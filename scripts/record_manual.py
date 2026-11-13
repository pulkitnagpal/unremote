"""Record the 'human books by hand' scene: tap through ShowTime at human speed while adb records the screen."""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "unremote"))
from explorer import adb, screen  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else "media/raw/manual-booking.mp4"
PKG = "test.showtime.app"


def find(label, starts=False):
    for _ in range(10):
        _, els = screen()
        hits = [e for e in els if (e["label"].lower().startswith(label.lower()) if starts else e["label"].lower() == label.lower())]
        hits.sort(key=lambda e: e["kind"] != "button" and e["kind"] != "input")  # the button, not a title
        if hits:
            return hits[0]
        time.sleep(0.6)
    raise SystemExit(f"not on screen: {label}")


def tap(label, starts=False, pause=1.3):
    e = find(label, starts)
    adb("shell", "input", "tap", str(e["x"]), str(e["y"]))
    time.sleep(pause)


def type_into(label, text):
    tap(label, pause=0.5)
    for chunk in text.split(" "):
        adb("shell", "input", "text", chunk)
        time.sleep(0.25)
    adb("shell", "input", "keyevent", "111")
    time.sleep(0.6)


adb("shell", "settings", "put", "global", "http_proxy", ":0")
adb("shell", "pm", "clear", PKG)
rec = subprocess.Popen([os.path.expanduser("~/Library/Android/sdk/platform-tools/adb"), "shell", "screenrecord",
                        "--bit-rate", "12000000", "--time-limit", "170", "/sdcard/manual.mp4"])
time.sleep(1.0)
adb("shell", "am", "start", "-n", f"{PKG}/.MainActivity")
time.sleep(2.2)
type_into("Email", "demo@showtime.test")
type_into("Password", "showtime-demo")
tap("Log in", pause=1.8)
tap("Bengaluru")
tap("Dune: Part Three", starts=True)
tap("Tomorrow", starts=True)
tap("INOX Indiranagar · 19:00", starts=True, pause=1.6)  # a human checks one theatre first…
adb("shell", "input", "keyevent", "4"); time.sleep(1.2)  # …goes back to compare
tap("PVR Orion · 19:00", starts=True, pause=1.8)
tap("C4", pause=0.9)
tap("C5", pause=0.9)
tap("Hold 2 seat(s)", pause=2.0)
tap("Proceed to pay", pause=2.6)
time.sleep(1.5)
rec.terminate()
time.sleep(2.5)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
adb("pull", "/sdcard/manual.mp4", OUT)
print("saved", OUT)
