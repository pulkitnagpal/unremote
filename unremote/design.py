"""Designer: Claude turns the API map into a small set of agent-friendly tools (names, descriptions, inputs)."""
import argparse
import json
import os

from llm import ask_json


def compact(api):
    """Only what the designer needs: feature endpoints, their inputs and where values come from."""
    out = {}
    for key, e in api["endpoints"].items():
        if e["role"] != "feature":
            continue
        out[key] = {
            "effect": e["effect"],
            "triggered_by": [f'{t["screen"]}: {t["action"]}' for t in e["triggers"]],
            "path_params": {n: {"examples": v["examples"], "source": v["source"]} for n, v in e["params"].items()},
            "query": {n: {"examples": v["examples"], "source": v["source"]} for n, v in e["query"].items()
                      if n not in e.get("fixed_query", {})},
            "fixed_query (sent automatically, not inputs)": e.get("fixed_query", {}),
            "body": {n: {"examples": v["examples"], "source": v["source"]} for n, v in e["body"].items()},
            "response_shape": e["response_shape"],
        }
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--run", required=True)
    p.add_argument("--app", required=True)
    args = p.parse_args()
    api = json.load(open(os.path.join(args.run, "api_map.json")))
    goals = json.load(open(os.path.join(args.run, "goals.json")))["goals"]
    prompt = f"""You are designing MCP tools so an AI agent can use the "{args.app}" app through its private API
instead of tapping its screens. Below are the app's user goals and the API endpoints observed while an agent used it,
with what screen action triggered each one, the inputs, and where each input value came from
("from": "<endpoint> / <json path>" means the value comes from an earlier call's response).

Goals: {json.dumps(goals)}

Endpoints:
{json.dumps(compact(api), indent=1)}

Design one tool per endpoint that serves a user goal. Skip app plumbing (configuration, site info, styles,
scripts, translations) as well as auth and analytics, which are handled for you. A "lang" input is the
language subdomain (e.g. "en"); say so and give "en" as the usual value.
- name: snake_case verb_object, e.g. list_movies.
- description: one or two sentences for an agent: what it does, and where to get each input
  (e.g. "show_id comes from list_showtimes"). For write tools, say it changes state and the user should confirm.
- inputs: each path param, query param and body field. "in" is path|query|body. For body, "field" is the
  top-level JSON key (a body path like $.seat_ids[*] means field "seat_ids" of type "string[]").
  type is one of string|integer|number|boolean|string[]|integer[]. Mark dates as format YYYY-MM-DD in the description.

Reply with JSON only:
{{"server_name": "<short app id>", "tools": [{{"name": "...", "description": "...", "endpoint": "<METHOD /template exactly as given>",
 "effect": "read|write", "inputs": [{{"name": "...", "in": "path|query|body", "field": "<path param name, query key or body key>",
 "type": "...", "required": true, "description": "..."}}]}}]}}"""
    tools = ask_json(prompt)
    json.dump(tools, open(os.path.join(args.run, "tools.json"), "w"), indent=2)
    for t in tools["tools"]:
        print(f'  {t["name"]:22} {t["effect"]:5} {t["endpoint"]}')


if __name__ == "__main__":
    main()
