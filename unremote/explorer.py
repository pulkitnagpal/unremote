"""Explorer: an agent that uses an Android app on its own, toward goals taken from the app's store listing.

It reads the screen through Android's accessibility tree (uiautomator), asks Claude for the next action,
and performs it with adb. Every action is logged with a timestamp so the analyzer can match taps to the
network requests they caused.
"""
import argparse
import json
import os
import re
import subprocess
import time
import xml.etree.ElementTree as ET

from llm import ask_json

ADB = os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")


def adb(*args, check=True):
    return subprocess.run([ADB, *args], capture_output=True, text=True, check=check).stdout


def screen():
    """Return (title, elements) for what is on screen now."""
    raw = ""
    for _ in range(3):
        raw = adb("exec-out", "uiautomator", "dump", "/dev/tty", check=False)
        if "<hierarchy" in raw:
            break
        time.sleep(0.8)
    xml = raw[raw.find("<hierarchy"): raw.rfind("</hierarchy>") + len("</hierarchy>")]
    root = ET.fromstring(xml)
    els, title = [], ""
    for n in root.iter("node"):
        text, desc = n.get("text", ""), n.get("content-desc", "")
        cls = n.get("class", "").split(".")[-1]
        clickable = n.get("clickable") == "true"
        editable = cls == "EditText"
        label = text or desc
        if not label and not editable:
            continue
        if n.get("package") and "systemui" in n.get("package"):
            continue
        b = list(map(int, re.findall(r"\d+", n.get("bounds", "[0,0][0,0]"))))
        if not title and cls == "TextView" and text:
            title = text
        els.append({
            "i": len(els), "kind": "input" if editable else ("button" if clickable else "text"),
            "label": label, "hint": desc if editable else "", "enabled": n.get("enabled") == "true",
            "x": (b[0] + b[2]) // 2, "y": (b[1] + b[3]) // 2,
        })
    return title, els


def act(a, els):
    kind = a.get("action")
    if kind == "back":
        adb("shell", "input", "keyevent", "4")
        return "back"
    el = els[int(a["element"])]
    adb("shell", "input", "tap", str(el["x"]), str(el["y"]))
    if kind == "type":
        time.sleep(0.4)
        adb("shell", "input", "keyevent", "KEYCODE_MOVE_END")
        txt = a.get("text", "").replace(" ", "%s").replace("'", "")
        adb("shell", "input", "text", f"'{txt}'")
        adb("shell", "input", "keyevent", "111")  # hide keyboard (escape)
        return f'type "{a.get("text", "")}" into "{el["label"]}"'
    return f'tap "{el["label"]}"'


def derive_goals(listing):
    prompt = f"""Below is an app's store listing. List the concrete things a user can do in this app, as short
goals an agent could complete by using the app, in the order a user would naturally do them. Include reading
or browsing goals and the main transaction goal (stop before any real payment). 4 to 7 goals.

Store listing:
{listing}

Reply with JSON only: {{"goals": ["...", "..."]}}"""
    return ask_json(prompt)["goals"]


def next_action(goals, done, history, title, els, creds, warning=""):
    lines = "\n".join(
        f'[{e["i"]}] {e["kind"]}{"" if e["enabled"] else " (disabled)"}: {e["label"]}' for e in els)
    status = "\n".join(f'{i + 1}. [{"DONE" if g in done else "todo"}] {g}' for i, g in enumerate(goals))
    prompt = f"""You are exploring an Android app so its features can be mapped. Use it like a careful human.
Each goal only needs to be done ONCE. As soon as a screen confirms a goal (a list loaded, a confirmation or
result screen appeared), mark it completed and move on to the next todo goal. Do not repeat a finished goal.

Goals:
{status}

Test account for this app (use it if the app asks you to log in): {json.dumps(creds)}
Your last actions: {json.dumps(history[-10:])}
{warning}
Current screen: "{title}"
{lines}

Rules: pick ONE action. Use "type" for inputs (it taps the field and types). Use "back" to go back.
When every goal is DONE, answer "done".
Payments: tapping a button that proceeds to checkout or shows a payment page/link is fine and wanted (it does not
charge anything). Never type card, UPI or bank details, and never confirm a payment inside a payment form.

Reply with JSON only:
{{"action": "tap"|"type"|"back"|"done", "element": <index or null>, "text": "<for type>",
  "goal": <number of the goal you are working on>, "completed": [<numbers of goals now completed>], "why": "<short>"}}"""
    return ask_json(prompt)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--package", required=True)
    p.add_argument("--listing", required=True)
    p.add_argument("--run", required=True)
    p.add_argument("--creds", default="")
    p.add_argument("--max-steps", type=int, default=45)
    args = p.parse_args()
    os.makedirs(args.run, exist_ok=True)
    creds = dict(kv.split("=", 1) for kv in args.creds.split(",") if "=" in kv)

    goals = derive_goals(open(args.listing).read())
    json.dump({"goals": goals}, open(os.path.join(args.run, "goals.json"), "w"), indent=2)
    print("goals:", *goals, sep="\n  - ")

    adb("shell", "pm", "clear", args.package)  # fresh start, so login and startup calls are captured
    log = open(os.path.join(args.run, "actions.jsonl"), "a")
    t = time.time()
    log.write(json.dumps({"t": t, "action": "launch", "screen": "", "goal": "start"}) + "\n")
    activity = adb("shell", "cmd", "package", "resolve-activity", "--brief", args.package).strip().splitlines()[-1]
    adb("shell", "am", "start", "-n", activity)
    time.sleep(2.5)

    done, history, per_goal = [], [], {}
    for step in range(args.max_steps):
        title, els = screen()
        recent = history[-8:]
        warning = ""
        if recent and max(recent.count(h) for h in recent) >= 3:
            warning = "WARNING: you are repeating the same actions. The goal you are on is very likely already done: mark it completed and move to the next todo goal.\n"
        a = next_action(goals, done, history, title, els, creds, warning)
        for n in a.get("completed") or []:
            g = goals[int(n) - 1] if str(n).isdigit() and 0 < int(n) <= len(goals) else None
            if g and g not in done:
                done.append(g)
        gi = a.get("goal")
        per_goal[gi] = per_goal.get(gi, 0) + 1
        if str(gi).isdigit() and per_goal[gi] > 10 and 0 < int(gi) <= len(goals) and goals[int(gi) - 1] not in done:
            done.append(goals[int(gi) - 1])  # give up on a goal that takes too long; the rest still get explored
            print(f"step {step}: skipping goal {gi}")
        if a.get("action") == "done" or len(done) == len(goals):
            print(f"step {step}: done")
            break
        t = time.time()
        try:
            what = act(a, els)
        except Exception as e:  # bad index etc.
            what = f"failed: {e}"
        gn = a.get("goal")
        goal = goals[int(gn) - 1] if str(gn).isdigit() and 0 < int(gn) <= len(goals) else gn
        entry = {"t": t, "action": what, "screen": title, "goal": goal, "why": a.get("why")}
        log.write(json.dumps(entry) + "\n")
        log.flush()
        history.append(f"{title}: {what}")
        print(f"step {step}: [{title}] {what}  — goal {gn}", flush=True)
        time.sleep(1.6)
    json.dump({"goals": goals, "completed": done}, open(os.path.join(args.run, "goals.json"), "w"), indent=2)
    print(f"completed {len(done)}/{len(goals)} goals")


if __name__ == "__main__":
    main()
