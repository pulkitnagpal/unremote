# How Unremote works

Unremote turns an Android app into an MCP server in six steps. Only two of them use a language model.

```
 store listing ──► explorer (Claude + adb) ──► actions.jsonl ─┐
                        │ taps, types                         │
                        ▼                                     ▼
                   the app on a      ──► mitmproxy  ──►  flows.jsonl ──► analyzer ──► api_map.json
                   capture emulator      recorder                       (no LLM)          │
                                                                                          ▼
              Claude Code ◄── MCP server ◄── generator (no LLM) ◄── tools.json ◄── designer (Claude)
                                  │
                                  └── verify: every read tool replayed against the live API
```

Everything one run produces lands in `runs/<app>-<timestamp>/`. The generated server goes to `generated/<app>/`.

| File | Written by | What's in it |
|---|---|---|
| `goals.json` | explorer | 4–7 user goals taken from the store listing, and which ones the agent finished |
| `actions.jsonl` | explorer | one line per tap or typed text: time, screen title, goal, reason |
| `flows.jsonl` | recorder | one line per HTTP request: method, host, path, query, headers, bodies, status, times |
| `api_map.json` | analyzer | endpoint templates, where every input comes from, auth, constant headers, roles |
| `tools.json` | designer | tool names, descriptions and inputs |
| `generated/<app>/` | generator | `server.mjs`, `client.mjs`, `unremote.config.json`, `checks.json`, `verify.mjs` |

`flows.jsonl` holds real tokens, cookies and device ids. `runs/` is in `.gitignore`. Keep it out of git.

## 1. Explorer

`unremote/explorer.py` reads the store listing and asks Claude for a short list of goals ("Select the city",
"Choose free seats on the live seat map and hold them", "Open My bookings"). It then runs a loop:

1. Dump the screen with `uiautomator`. Keep only nodes that have text, a content description, or are inputs.
2. Show Claude the numbered elements, the goals with done/todo marks, and the last ten actions.
3. Do the one action it picks (`tap`, `type`, `back`) with `adb shell input`.
4. Log the action with a timestamp.

The prompt marks a goal done as soon as a screen confirms it. Three guards stop the agent from wandering. It is
warned when it repeats itself. A goal is dropped after 10 steps. The run stops after 45 steps. The app's data
is cleared first (`pm clear`), so login and startup calls always get captured.

Two rules about payments are in the prompt: going as far as a payment page or link is fine, and typing card,
UPI or bank details is never allowed.

## 2. Recorder

`unremote/recorder.py` is a mitmproxy addon. The capture emulator (`unremote setup`) is an Android 13 image with
the mitmproxy CA in the **system** trust store. Release builds of most apps trust only system CAs, so their HTTPS
can be read without patching or repackaging the app. This changes the emulator only, not your Mac.

With `writes=block` (the default for `unremote learn`), every POST, PUT, PATCH and DELETE gets answered with
`403 {"error":"held_by_unremote"}` and is recorded with `held: true`. The app's real server never sees it.
Writes whose path contains `login`, `signin`, `sign-in`, `auth`, `token`, `refresh` or `session` are let
through so the agent can sign in. That pattern is broad: a `/payments/authorize` or `/checkout/session` call
would also pass, which is one more reason to explore only with a test or throwaway account. Pass `--allow-writes` only for apps and accounts
where you are happy for the explorer to really act (the ShowTime demo backend, for example).

Bodies are stored decoded. Real apps send gzip and brotli replies, and the raw bytes would give the analyzer
nothing to read, so the recorder uses mitmproxy's `get_content()`, which undoes the compression. JSON is
parsed; other text is kept up to 4000 characters; binary bodies are kept only as a byte count.

The emulator's own Google traffic (Play services, Firebase, Crashlytics) is skipped.

## 3. Analyzer

`unremote/analyze.py` is plain Python with no model and no network access. It reads `flows.jsonl` and
`actions.jsonl` and writes `api_map.json`. The analyzer is where an unreadable capture becomes an API you can
design for, so most of this page is about it. Every example below comes from the real ShowTime run
(`showtime-20261113-190645`, 21 requests) or the real Wikipedia app run (`wikipedia-20261113-195010`,
204 requests).

### 3.1 Hosts and language templating

Images, video and fonts (`.png .jpg .webp .gif .svg .mp4 .woff`) are dropped first. In the Wikipedia run that
removed 81 of 204 requests, mostly thumbnails.

If two or more hosts differ only in a first label that looks like a language code (`[a-z]{2,3}(-[a-z]+)?`),
they become one templated host and the label becomes a `lang` input:

```
en.wikipedia.org  af.wikipedia.org  zh.wikipedia.org  crh.wikipedia.org  …   (15 language hosts in the run)
                       ▼
https://{lang}.wikipedia.org
```

`meta.wikimedia.org` and `intake-analytics.wikimedia.org` are left alone: their first labels are not
language-shaped.

The **main host** is the busiest host that receives GETs and doesn't look like analytics. Its origin is the
server's `base_url`. When an app talks to more than one host, every endpoint key carries its full origin
(`GET https://meta.wikimedia.org/w/api.php`). The emulator's name for your Mac, `10.0.2.2`, becomes `127.0.0.1`.

### 3.2 Path templates

Each path segment (except the first) is checked, and becomes a parameter if any of these hold:

- **It looks like an id**: all digits, a short prefix plus underscore (`mv_dune3`, `hl_686668c6ab03`), a UUID,
  or 16+ hex characters.
- **It's a value from an earlier response that looks like data**: the segment, or its URL-decoded form with `_`
  read as a space, appeared in an earlier response, and either it isn't a plain lower-case word or every value
  seen at that position came from a response.
- **It's a date**: `yyyy/mm/dd` anywhere, or two trailing two-digit segments (`mm/dd`).

The parameter is named after the segment before it, singularised, with `_id` added for ids:

```
/v2/shows/66166/seatmap                        → /v2/shows/{show_id}/seatmap
/v2/movies/mv_dune3/shows                      → /v2/movies/{movie_id}/shows
/v2/holds/hl_686668c6ab03/checkout             → /v2/holds/{hold_id}/checkout
/api/rest_v1/page/summary/Solar_System         → /api/rest_v1/page/summary/{summary}      ("Solar System" was in search results)
/api/rest_v1/page/summary/Sonnestelsel         → same endpoint, on af.wikipedia.org       (it was in the language list)
/api/rest_v1/feed/featured/2026/11/13          → /api/rest_v1/feed/featured/{year}/{month}/{day}
/api/rest_v1/feed/onthisday/events/11/13       → /api/rest_v1/feed/onthisday/events/{month}/{day}
```

A segment that varies but never came from a response stays literal. `/v2/cities` and `/v2/movies` are two
endpoints, not one endpoint with a `{v2}` parameter. Names like `{summary}` and `{mobile_html}` are clumsy. The
designer renames them (`title`) when it writes the tool.

### 3.3 One URL, many operations

Some APIs put everything behind one path and pick the operation with the query. If calls to one endpoint use
different sets of query keys, the analyzer splits the endpoint by the values of the operation-like keys
(`action list prop meta generator op operation method`), or by the set of keys when there are none. The
Wikipedia app's `/w/api.php` became eight endpoints, among them:

```
GET https://{lang}.wikipedia.org/w/api.php?action=query&prop=description|pageimages|coordinates|info&generator=prefixsearch
GET https://{lang}.wikipedia.org/w/api.php?action=query&prop=langlinks
GET https://{lang}.wikipedia.org/w/api.php?action=sitematrix
```

### 3.4 Value flow

Every scalar in every response is indexed with the endpoint it came from, its JSON path (array indices written
`[*]`) and the time the response ended. For every path parameter, query value and body field, the analyzer then
asks where the value came from, in this order:

1. **An earlier response.** The most recent response that ended before this request started and contains the
   exact value: `{"from": "<endpoint>", "path": "<json path>"}`.
2. **Something the user typed.** The value appears in quotes in a `type "…" into "…"` action: `{"from": "user_input"}`.
3. **A date the user picked.** It looks like `YYYY-MM-DD`: `{"from": "user_choice", "kind": "date"}`.
4. **Anything else is a choice**: `{"from": "user_choice"}`.

From the ShowTime run:

```
GET  /v2/movies                    city_id  ← GET /v2/cities                    $.cities[*].city_id
GET  /v2/movies/{movie_id}/shows   movie_id ← GET /v2/movies                    $.items[*].movie_id
                                   date     ← user_choice (date)
GET  /v2/shows/{show_id}/seatmap   show_id  ← GET /v2/movies/{movie_id}/shows   $.shows[*].show_id
POST /v2/shows/{show_id}/hold      seat_ids ← user_choice
POST /v2/holds/{hold_id}/checkout  hold_id  ← POST /v2/shows/{show_id}/hold     $.hold_id
```

This chain is what lets the designer write "show_id comes from list_showtimes" into a tool description, and
it's how Claude later knows which tool to call first.

Values shorter than three characters, and `true`/`false`/`null`, aren't indexed. They match too much by chance.
Even so, some matches are coincidences. In the Wikipedia run, `pithumbsize=330` was traced to a thumbnail
`width` of 330 in an unrelated response. The designer sees the source as a hint, not a fact.

### 3.5 Login and refresh

- **Bearer token.** The first request with `Authorization: Bearer <t>` where `<t>` came from an earlier
  response. That response's endpoint and JSON path become `token_from`.
- **Login call.** A successful request whose JSON body has a key containing `password`. Its body field names
  (not values) are recorded. The token path is the first response field containing `access` or ending in
  `.token`. The refresh token path is the first containing `refresh`. `expires_in` is kept when present.
- **Refresh call.** A request whose body has a key containing `refresh`. The source of its value is traced like
  any other value, normally back to the login response.

From the ShowTime run:

```json
"auth": {
  "scheme": "bearer", "header": "authorization",
  "token_from": {"from": "POST /v2/auth/login", "path": "$.access_token"},
  "login": {"endpoint": "POST /v2/auth/login", "body_fields": ["email", "password"]},
  "token_path": "$.access_token", "refresh_token_path": "$.refresh_token", "expires_in_s": 300
}
```

The generated client logs in on the first `401`, retries the call once, and tries the refresh call (if one
was seen) before logging in again. Login values come from environment variables named after the body fields
(`SHOWTIME_EMAIL`, `SHOWTIME_PASSWORD`). They are never written into the config.

### 3.6 Constant headers

A request header that had exactly one value across the whole capture is replayed on every call. Apps use these
to identify the device and app version, and some servers reject calls without them. `Host`, `Content-Length`,
`Connection`, `Accept-Encoding`, `Content-Type`, `Authorization` and `User-Agent` are skipped. ShowTime's
constants were `accept`, `x-device-id` and `x-app-version`. The Wikipedia app's was `x-wmf-uuid`.

These values identify your capture device. They end up in `generated/<app>/unremote.config.json`, so don't
publish that file for an app you used with a real account.

### 3.7 Noise

Every endpoint gets a role. Only `feature` endpoints are shown to the designer.

| Role | Rule | Real examples |
|---|---|---|
| `telemetry` | analytics-like host name; or a path with `collect`, `/events`, `track` on a write; or `_204`, `/csi`, `/log`, `/beacon`; or a trivial reply (`{"ok": true}`, empty, held) with an event-like body (`…event`, `…screen`, `…ts`) or 4+ calls | `POST /collect` ×11 (ShowTime); `POST https://intake-analytics.wikimedia.org/v1/events` ×40 |
| `asset` | `/data/css/`, `/data/javascript/`, `/data/i18n/`, `.css`, `.js`, `.map`, `/font/` | 10 style, script, translation and MathJax endpoints, 8 of them on `meta.wikimedia.org` |
| `auth` | the login or refresh call | `POST /v2/auth/login` |
| `bootstrap` | first seen before the agent's first tap, with no token, no parameters and no query | `GET /v2/config` |
| `feature` | everything else | `GET /v2/shows/{show_id}/seatmap` |

Every endpoint also gets an `effect`: `read` for GET, `write` for anything else.

### 3.8 Fixed query values

Many query values are sent by the app on every call and are not inputs at all: `format=json`,
`formatversion=2`, `gpslimit=30`. A query value is **fixed** when it never changed, didn't come from an earlier
response, wasn't typed by the user, and isn't a date. The generated tool sends fixed values automatically and
doesn't expose them as inputs. Wikipedia's prefix search had 15 fixed values and 3 real inputs (the search text,
the thumbnail size, the language).

The risk runs one way: a real input that was only ever used with one value looks fixed. Exploring each feature
twice with different values fixes that.

### 3.9 Triggers

Each request is matched to the last action that happened up to four seconds before it:

```
GET /v2/shows/{show_id}/seatmap   ← tap "PVR Orion · 19:00 · ₹320" on "Dune: Part Three · 2026-11-13"
```

The designer uses this to understand what a call is for, from the user's side.

## 4. Designer

`unremote/design.py` sends Claude the goals and the `feature` endpoints, with their inputs, sources, fixed
values, triggers and response shapes. It asks for one tool per endpoint that serves a goal, named `verb_object`,
with descriptions that say where each input comes from and, for writes, that the user should confirm. ShowTime
got 7 tools: `list_cities`, `list_movies`, `list_showtimes`, `get_seatmap`, `hold_seats`, `checkout_hold`,
`list_my_bookings`. Auth, analytics and app plumbing are left out on purpose.

## 5. Generator

`unremote/generate.py` has no model in it. It writes `unremote.config.json` (base URL, constant headers,
auth, tools with their fixed query values) next to a fixed runtime:

- `server.mjs` registers one MCP tool per entry. Write tools get `destructiveHint: true` and a
  "[Changes state — confirm with the user first]" prefix on the description.
- `client.mjs` fills path, query and body from the tool arguments, adds constant headers and the bearer
  token, and handles login, refresh and retry.

Real replies can be far too big for an agent. Wikipedia's "on this day" feed alone is about 450,000 characters
of JSON.
The server trims every reply to `UNREMOTE_MAX_CHARS` (default 12000). HTML becomes plain text. For JSON it
tries smaller and smaller limits until the reply fits: first 20 items per list and 600 characters per string,
down to 3 items and 60 characters. It notes what was cut (`… 37 more`, `[large reply trimmed]`). Raise the limit
if an agent needs more of a reply.

## 6. Verify

`generated/<app>/checks.json` holds one check per **read** tool, using the exact arguments the app sent during
exploration. `unremote verify <app>` calls each one against the live API. A check passes when the call returns
below 400 and the reply has the same top-level keys the app saw. Write tools are listed and never called.

```
$ unremote verify wikipedia
PASS  search_articles        {"lang":"en","search":"Sol","thumbnail_size":330} → HTTP 200
PASS  get_article_summary    {"lang":"en","title":"Solar_System"} → HTTP 200
…
10/10 read tools verified; not called (change state): none
```

## Known analyzer misfires

`tests/test_analyze.py` has a `KnownIssues` class. Each test there states the behaviour the analyzer should have
and is marked `expectedFailure` until it is fixed:

- `api.` and `www.` on one domain look like language codes and get merged into `{lang}`.
- A blocked write with a body field ending in `ts` (`seats`, `guests`) is classed as telemetry.
- A write to a path containing `track` or `collect` (add to playlist, create a collection) is classed as telemetry.
- Plain-HTTP APIs are written as `https://`.
- A header seen on only one call counts as constant and is replayed on every call.
- Value flow compares values exactly, so `Solar_System` in a path isn't linked to `"Solar System"` in a response,
  even though templating does make that link. One-off titles can then be marked fixed.
- Any path ending in two two-digit segments is read as `{month}/{day}`.
