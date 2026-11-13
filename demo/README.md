# ShowTime: the demo app

ShowTime is a small movie-booking app made to test Unremote end to end without touching anyone's real service.
It's built to behave the way real apps do:

- **`backend/`** is an HTTPS API in plain Node (no dependencies). It has bearer tokens that expire after 5
  minutes, refresh tokens that rotate, a startup config call, an analytics endpoint the app calls on every
  screen, cities, movies, showtimes for three days, a live seat map, 10-minute seat holds and a checkout that
  returns a payment link. Nothing is ever charged.
- **`android/`** is the Android app (Java, no libraries). Like a release app, it trusts the system CAs plus the
  API's own cert, and not user-installed CAs. It sends a device id and app version on every call, and
  refreshes its token on a 401.
- **`listing.txt`** is its "store listing". The explorer sets its goals from it.

The demo account is `demo@showtime.test` / `showtime-demo`. It's in `backend/seed.json`.

## Set up

You need the same tools as Unremote (see the [main README](../README.md#quickstart)) and `openssl`.

```bash
demo/setup.sh
```

This makes a self-signed cert for the API (from `backend/cert.cnf`, valid for `10.0.2.2`, `127.0.0.1` and
`localhost`), copies it into the app as `res/raw/showtime_api.pem`, and builds
`android/app/build/outputs/apk/debug/app-debug.apk`. It keeps an existing cert unless you pass `--new-cert`.
If you do replace it, restart the API and reinstall the app. The cert and key are git-ignored.

Start the API, and check it in another terminal:

```bash
node demo/backend/server.js
```

```bash
demo/backend/smoke.sh
```

`smoke.sh` logs in, lists movies, holds seats C4 and C5 on tomorrow's second Dune show, and checks out. Set
`TOKEN_TTL=30` when starting the server to see the app refresh its token while you explore.

## Learn it

Boot the capture emulator and install the app on it:

```bash
unremote setup
```

```bash
~/Library/Android/sdk/platform-tools/adb -s emulator-5554 install -r demo/android/app/build/outputs/apk/debug/app-debug.apk
```

Then let the agent learn it. `UPSTREAM_CA` makes the proxy trust the demo API's self-signed cert.
`--allow-writes` lets the hold and checkout reach this local backend, so the explorer sees what they return.
Don't use `--allow-writes` on a real app.

```bash
UPSTREAM_CA=$PWD/demo/backend/cert.pem unremote learn test.showtime.app showtime --listing demo/listing.txt --login email=demo@showtime.test,password=showtime-demo --allow-writes
```

Give the generated server the demo login, and trust the demo cert from Node:

```bash
printf 'SHOWTIME_EMAIL=demo@showtime.test\nSHOWTIME_PASSWORD=showtime-demo\n' > generated/showtime/.env
```

```bash
export NODE_EXTRA_CA_CERTS=$PWD/demo/backend/cert.pem
```

```bash
unremote verify showtime
```

```bash
unremote try showtime "Hold two seats next to each other for the next Dune show in Bengaluru and give me the payment link."
```

## What a run looks like

From the run described in the main README (`runs/` is git-ignored, so yours gets its own folder):

```
== 3. analyze: endpoints, value flow, login, noise
21 requests on 10.0.2.2:8443, 10 endpoints, 13 actions
auth: {"scheme": "bearer", "token_path": "$.access_token", "refresh_token_path": "$.refresh_token"}
  [auth     ] POST /v2/auth/login                        x1  ← tap "Log in"
  [bootstrap] GET /v2/config                             x1  ← launch
  [feature  ] GET /v2/cities                             x2  ← tap "Log in"
  [feature  ] GET /v2/movies                             x1  ← tap "Bengaluru"                        {'city_id': 'GET /v2/cities:$.cities[*].city_id'}
  [feature  ] GET /v2/movies/{movie_id}/shows            x1  ← tap "Today (2026-11-13)"               {'movie_id': 'GET /v2/movies:$.items[*].movie_id', 'city_id': 'GET /v2/cities:$.cities[*].city_id', 'date': 'user_choice'}
  [feature  ] GET /v2/shows/{show_id}/seatmap            x1  ← tap "PVR Orion · 19:00 · ₹320"         {'show_id': 'GET /v2/movies/{movie_id}/shows:$.shows[*].show_id'}
  [feature  ] POST /v2/shows/{show_id}/hold              x1  ← tap "HOLD 1 SEAT(S)"                   {'show_id': 'GET /v2/shows/{show_id}/seatmap:$.show_id', '$.seat_ids[*]': 'user_choice'}
  [feature  ] POST /v2/holds/{hold_id}/checkout          x1  ← tap "Proceed to pay"                   {'hold_id': 'POST /v2/shows/{show_id}/hold:$.hold_id'}
  [feature  ] GET /v2/me/bookings                        x1  ← tap "My bookings"
  [telemetry] POST /collect                              x11 ← launch                                 {'$.event': 'user_choice', '$.screen': 'user_choice', '$.ts': 'user_choice'}
== 4. design tools (Claude)
```

```
$ unremote verify showtime
PASS  list_cities            {} → HTTP 200
PASS  list_movies            {"city_id":"BLR"} → HTTP 200
PASS  list_showtimes         {"movie_id":"mv_dune3","city_id":"BLR","date":"2026-11-13"} → HTTP 200
PASS  get_seatmap            {"show_id":66166} → HTTP 200
PASS  list_my_bookings       {} → HTTP 200
5/5 read tools verified; not called (change state): hold_seats, checkout_hold
```

`GET https://127.0.0.1:8443/__debug/state` on the backend shows the current holds, so you can see what an agent did.
