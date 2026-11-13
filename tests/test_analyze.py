"""Unit tests for unremote/analyze.py.

Run from the repo root:  python3 -m unittest discover tests

Two kinds of fixtures:
  - tests/fixtures/showtime/ and tests/fixtures/wiki/ hold small hand-written flows.jsonl / actions.jsonl
    captures shaped like the real ShowTime and Wikipedia runs (no real tokens or ids).
  - The KnownIssues tests build a few flows inline to pin down edge cases that used to misfire.
"""
import contextlib
import gc
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import warnings

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "unremote"))
import analyze  # noqa: E402

FIXTURES = os.path.join(HERE, "fixtures")


def _run(run_dir):
    """Run the analyzer on a run folder and return the api_map it writes."""
    argv = sys.argv
    sys.argv = ["analyze.py", "--run", run_dir]
    try:
        with warnings.catch_warnings(), contextlib.redirect_stdout(io.StringIO()):
            warnings.simplefilter("ignore", ResourceWarning)  # analyze.py opens files without closing them
            analyze.main()
            gc.collect()
    finally:
        sys.argv = argv
    with open(os.path.join(run_dir, "api_map.json")) as f:
        return json.load(f)


def analyze_fixture(name):
    d = tempfile.mkdtemp(prefix="unremote-test-")
    try:
        for fn in ("flows.jsonl", "actions.jsonl"):
            shutil.copy(os.path.join(FIXTURES, name, fn), d)
        return _run(d)
    finally:
        shutil.rmtree(d)


def analyze_inline(flows, actions=None):
    d = tempfile.mkdtemp(prefix="unremote-test-")
    try:
        actions = actions or [{"t": 0, "action": "launch", "screen": "", "goal": "start"},
                              {"t": 1, "action": 'tap "Start"', "screen": "Home", "goal": "x"}]
        with open(os.path.join(d, "flows.jsonl"), "w") as f:
            f.writelines(json.dumps(x) + "\n" for x in flows)
        with open(os.path.join(d, "actions.jsonl"), "w") as f:
            f.writelines(json.dumps(x) + "\n" for x in actions)
        return _run(d)
    finally:
        shutil.rmtree(d)


def flow(t0, method, path, host="api.example.com", port=443, query=None, headers=None, body=None, resp=None,
         status=200, held=False, scheme="https"):
    return {"t0": t0, "t1": t0 + 0.2, "method": method, "scheme": scheme, "host": host, "port": port, "path": path,
            "query": query or {}, "req_headers": headers or {}, "req_body": body, "status": status,
            "resp_headers": {}, "resp_body": resp, "held": held}


class ShowTimeFixture(unittest.TestCase):
    """A single-host booking API with login, refresh, analytics and a bootstrap call."""

    @classmethod
    def setUpClass(cls):
        cls.api = analyze_fixture("showtime")
        cls.ep = cls.api["endpoints"]

    # --- path templating -------------------------------------------------------------------------------
    def test_numeric_ids_are_templated_and_named_after_the_collection(self):
        self.assertIn("GET /v2/shows/{show_id}/seatmap", self.ep)
        self.assertIn("POST /v2/shows/{show_id}/hold", self.ep)
        self.assertEqual(self.ep["GET /v2/shows/{show_id}/seatmap"]["params"]["show_id"]["examples"], ["29418"])

    def test_prefixed_ids_and_uuids_are_templated(self):
        self.assertIn("GET /v2/movies/{movie_id}/shows", self.ep)        # mv_dune3
        self.assertIn("POST /v2/holds/{hold_id}/checkout", self.ep)      # hl_686668c6ab03
        self.assertIn("GET /v2/receipts/{receipt_id}", self.ep)          # a UUID

    def test_resource_names_stay_literal(self):
        for key in ("GET /v2/cities", "GET /v2/movies", "GET /v2/me/bookings", "GET /v2/search"):
            self.assertIn(key, self.ep)
        self.assertFalse(any("{v2" in k or "{me" in k for k in self.ep))

    def test_emulator_host_becomes_localhost_in_base_url(self):
        self.assertEqual(self.api["base_url"], "https://127.0.0.1:8443")
        self.assertEqual(self.api["captured_host"], "10.0.2.2:8443")

    def test_images_are_dropped(self):
        self.assertFalse(any(".png" in k for k in self.ep))
        self.assertEqual(self.api["stats"]["flows"], 17)  # 18 captured, one poster image

    # --- value flow --------------------------------------------------------------------------------------
    def test_value_flow_links_inputs_to_earlier_responses(self):
        shows = self.ep["GET /v2/movies/{movie_id}/shows"]
        self.assertEqual(shows["params"]["movie_id"]["source"], {"from": "GET /v2/movies", "path": "$.items[*].movie_id"})
        self.assertEqual(shows["query"]["city_id"]["source"], {"from": "GET /v2/cities", "path": "$.cities[*].city_id"})
        seatmap = self.ep["GET /v2/shows/{show_id}/seatmap"]
        self.assertEqual(seatmap["params"]["show_id"]["source"],
                         {"from": "GET /v2/movies/{movie_id}/shows", "path": "$.shows[*].show_id"})
        checkout = self.ep["POST /v2/holds/{hold_id}/checkout"]
        self.assertEqual(checkout["params"]["hold_id"]["source"], {"from": "POST /v2/shows/{show_id}/hold", "path": "$.hold_id"})
        receipt = self.ep["GET /v2/receipts/{receipt_id}"]
        self.assertEqual(receipt["params"]["receipt_id"]["source"]["from"], "POST /v2/holds/{hold_id}/checkout")

    def test_latest_earlier_response_wins(self):
        # show_id 29418 is in the showtimes list and, later, in the seat map; the hold uses the most recent one.
        hold = self.ep["POST /v2/shows/{show_id}/hold"]
        self.assertEqual(hold["params"]["show_id"]["source"], {"from": "GET /v2/shows/{show_id}/seatmap", "path": "$.show_id"})

    def test_typed_text_dates_and_choices_are_told_apart(self):
        self.assertEqual(self.ep["GET /v2/search"]["query"]["q"]["source"], {"from": "user_input"})
        shows = self.ep["GET /v2/movies/{movie_id}/shows"]
        self.assertEqual(shows["query"]["date"]["source"], {"from": "user_choice", "kind": "date"})
        hold = self.ep["POST /v2/shows/{show_id}/hold"]
        self.assertEqual(hold["body"]["$.seat_ids[*]"]["source"], {"from": "user_choice"})
        self.assertEqual(hold["body"]["$.seat_ids[*]"]["examples"], ["C4", "C5"])

    def test_triggers_name_the_tap_that_caused_the_call(self):
        trig = self.ep["GET /v2/shows/{show_id}/seatmap"]["triggers"][0]
        self.assertEqual(trig["action"], 'tap "PVR Orion · 19:00 · ₹320"')
        self.assertEqual(trig["screen"], "Dune · 2026-11-13")

    # --- auth --------------------------------------------------------------------------------------------
    def test_bearer_login_is_detected(self):
        auth = self.api["auth"]
        self.assertEqual(auth["scheme"], "bearer")
        self.assertEqual(auth["header"], "authorization")
        self.assertEqual(auth["token_from"], {"from": "POST /v2/auth/login", "path": "$.access_token"})
        self.assertEqual(auth["login"], {"endpoint": "POST /v2/auth/login", "body_fields": ["email", "password"]})
        self.assertEqual(auth["token_path"], "$.access_token")
        self.assertEqual(auth["refresh_token_path"], "$.refresh_token")
        self.assertEqual(auth["expires_in_s"], 300)

    def test_refresh_call_is_detected(self):
        self.assertEqual(self.api["auth"]["refresh"], {
            "endpoint": "POST /v2/auth/refresh", "body_field": "refresh_token",
            "value_from": {"from": "POST /v2/auth/login", "path": "$.refresh_token"}})

    def test_login_and_refresh_are_auth_and_never_record_secrets_as_inputs(self):
        for key in ("POST /v2/auth/login", "POST /v2/auth/refresh"):
            self.assertEqual(self.ep[key]["role"], "auth")
            self.assertEqual(self.ep[key]["body"], {})
        self.assertNotIn("fixture-pass", json.dumps(self.api))

    def test_calls_with_a_token_need_auth(self):
        self.assertTrue(self.ep["GET /v2/me/bookings"]["needs_auth"])
        self.assertFalse(self.ep["GET /v2/config"]["needs_auth"])

    # --- headers -----------------------------------------------------------------------------------------
    def test_constant_headers_are_kept_and_varying_or_managed_ones_dropped(self):
        h = self.api["constant_headers"]
        self.assertEqual(h["x-device-id"], "dev-fixture-0001")
        self.assertEqual(h["x-app-version"], "1.0.0")
        self.assertNotIn("x-request-nonce", h)            # differs on every call
        for managed in ("authorization", "user-agent", "host"):
            self.assertNotIn(managed, h)

    # --- noise -------------------------------------------------------------------------------------------
    def test_roles(self):
        roles = {k: e["role"] for k, e in self.ep.items()}
        self.assertEqual(roles["POST /collect"], "telemetry")     # many calls, {"ok": true}, event/screen/ts body
        self.assertEqual(roles["GET /static/theme.css"], "asset")
        self.assertEqual(roles["GET /v2/config"], "bootstrap")    # before the first tap, no inputs, no token
        for key in ("GET /v2/cities", "GET /v2/movies", "POST /v2/shows/{show_id}/hold", "GET /v2/me/bookings"):
            self.assertEqual(roles[key], "feature", key)

    def test_effect_follows_method(self):
        self.assertEqual(self.ep["GET /v2/movies"]["effect"], "read")
        self.assertEqual(self.ep["POST /v2/shows/{show_id}/hold"]["effect"], "write")

    # --- fixed query values ------------------------------------------------------------------------------
    def test_fixed_query_values(self):
        shows = self.ep["GET /v2/movies/{movie_id}/shows"]
        self.assertEqual(shows["fixed_query"], {"page_size": "20"})   # not city_id (from a response), not date
        self.assertEqual(self.ep["GET /v2/search"]["fixed_query"], {})  # typed by the user


class WikiFixture(unittest.TestCase):
    """A multi-host reading app: language subdomains, an analytics host, a style host and images."""

    @classmethod
    def setUpClass(cls):
        cls.api = analyze_fixture("wiki")
        cls.ep = cls.api["endpoints"]

    def test_language_subdomains_become_one_templated_host(self):
        self.assertEqual(self.api["base_url"], "https://{lang}.wikipedia.org")
        key = "GET https://{lang}.wikipedia.org/api/rest_v1/page/summary/{summary}"
        self.assertIn(key, self.ep)
        self.assertEqual(self.ep[key]["calls"], 2)                 # en and af merged
        self.assertEqual(self.ep[key]["params"]["lang"]["examples"], ["en", "af"])

    def test_other_subdomains_are_not_language_codes(self):
        self.assertIn("GET https://meta.wikimedia.org/api/rest_v1/data/css/mobile/base", self.ep)
        self.assertIn("POST https://intake-analytics.wikimedia.org/v1/events", self.ep)
        self.assertFalse(any("{lang}.wikimedia.org" in k for k in self.ep))

    def test_titles_seen_in_earlier_responses_become_path_params(self):
        summary = self.ep["GET https://{lang}.wikipedia.org/api/rest_v1/page/summary/{summary}"]
        self.assertEqual(summary["params"]["summary"]["examples"], ["Solar_System", "Sonnestelsel"])
        self.assertIn("GET https://{lang}.wikipedia.org/api/rest_v1/page/mobile-html/{mobile_html}", self.ep)

    def test_yyyy_mm_dd_path_segments(self):
        key = "GET https://{lang}.wikipedia.org/api/rest_v1/feed/featured/{year}/{month}/{day}"
        self.assertIn(key, self.ep)
        p = self.ep[key]["params"]
        self.assertEqual((p["year"]["examples"], p["month"]["examples"], p["day"]["examples"]), (["2026"], ["11"], ["13"]))

    def test_trailing_mm_dd_path_segments(self):
        key = "GET https://{lang}.wikipedia.org/api/rest_v1/feed/onthisday/events/{month}/{day}"
        self.assertIn(key, self.ep)
        self.assertNotIn("year", self.ep[key]["params"])

    def test_one_url_is_split_by_its_operation_query(self):
        self.assertIn("GET https://{lang}.wikipedia.org/w/api.php?action=query&generator=prefixsearch", self.ep)
        self.assertIn("GET https://{lang}.wikipedia.org/w/api.php?action=query&prop=langlinks", self.ep)

    def test_fixed_query_values_exclude_what_the_user_typed(self):
        search = self.ep["GET https://{lang}.wikipedia.org/w/api.php?action=query&generator=prefixsearch"]
        self.assertEqual(search["fixed_query"], {"format": "json", "formatversion": "2", "action": "query",
                                                 "generator": "prefixsearch", "gpslimit": "30"})
        self.assertEqual(search["query"]["gpssearch"]["source"], {"from": "user_input"})

    def test_noise_on_other_hosts(self):
        self.assertEqual(self.ep["POST https://intake-analytics.wikimedia.org/v1/events"]["role"], "telemetry")
        self.assertEqual(self.ep["GET https://meta.wikimedia.org/api/rest_v1/data/css/mobile/base"]["role"], "asset")
        self.assertFalse(any("Sun.jpg" in k for k in self.ep))

    def test_no_login_means_no_auth(self):
        self.assertEqual(self.api["auth"], {"scheme": None})


class SmallCases(unittest.TestCase):
    def test_repeated_trivial_calls_are_telemetry(self):
        flows = [flow(10 + i, "GET", "/v1/ping", resp={}) for i in range(4)] + \
                [flow(20, "GET", "/v1/items", resp={"items": [{"item_id": "it_00001"}]})]
        api = analyze_inline(flows)
        self.assertEqual(api["endpoints"]["GET /v1/ping"]["role"], "telemetry")
        self.assertEqual(api["endpoints"]["GET /v1/items"]["role"], "feature")

    def test_hex_ids_are_templated(self):
        api = analyze_inline([flow(10, "GET", "/v1/orders/9f86d081884c7d65/status", resp={"status": "ok"})])
        self.assertIn("GET /v1/orders/{order_id}/status", api["endpoints"])

    def test_varying_slugs_from_responses_are_params(self):
        flows = [flow(10, "GET", "/v1/stations", resp={"stations": [{"slug": "koramangala"}, {"slug": "indiranagar"}]}),
                 flow(20, "GET", "/v1/stations/koramangala", resp={"name": "Koramangala"}),
                 flow(30, "GET", "/v1/stations/indiranagar", resp={"name": "Indiranagar"})]
        api = analyze_inline(flows)
        self.assertIn("GET /v1/stations/{station}", api["endpoints"])
        self.assertEqual(api["endpoints"]["GET /v1/stations/{station}"]["params"]["station"]["source"],
                         {"from": "GET /v1/stations", "path": "$.stations[*].slug"})


class KnownIssues(unittest.TestCase):
    """Edge cases that used to misfire; each test pins the behaviour we want."""


    def test_api_and_www_subdomains_are_not_language_codes(self):
        # [a-z]{2,3} also matches api, www, cdn, img, app: two of them on one domain become {lang}.example.com.
        flows = [flow(10, "GET", "/v1/me", host="api.example.com", resp={"name": "x"}),
                 flow(11, "GET", "/v1/me", host="api.example.com", resp={"name": "x"}),
                 flow(12, "GET", "/terms", host="www.example.com", resp="<html>terms</html>")]
        api = analyze_inline(flows)
        self.assertEqual(api["base_url"], "https://api.example.com")


    def test_held_write_with_a_plural_ts_field_is_not_telemetry(self):
        # The event-body regex (event|screen|ts)$ matches "$.seats" (or "$.guests", "$.points"), and a held
        # write counts as a trivial reply, so a blocked booking call is filed as analytics and never designed.
        flows = [flow(10, "GET", "/v1/shows/4411/seatmap", resp={"show_id": 4411, "free": ["A1", "A2"]}),
                 flow(20, "POST", "/v1/shows/4411/book", body={"seats": 2}, status=403,
                      resp={"error": "held_by_unremote"}, held=True)]
        api = analyze_inline(flows)
        self.assertEqual(api["endpoints"]["POST /v1/shows/{show_id}/book"]["role"], "feature")


    def test_adding_tracks_or_collections_is_not_telemetry(self):
        # A write whose path contains "track" or "collect" is called telemetry (e.g. add to playlist).
        flows = [flow(10, "GET", "/v1/playlists", resp={"playlists": [{"playlist_id": "pl_00042"}]}),
                 flow(20, "POST", "/v1/playlists/pl_00042/tracks", body={"track_uri": "song:123"}, resp={"added": 1})]
        api = analyze_inline(flows)
        self.assertEqual(api["endpoints"]["POST /v1/playlists/{playlist_id}/tracks"]["role"], "feature")


    def test_plain_http_apis_keep_their_scheme(self):
        # origin() always writes https://, although the recorder stores the scheme.
        api = analyze_inline([flow(10, "GET", "/v1/status", host="192.168.1.20", port=8080, scheme="http",
                                   resp={"ok": True, "level": 3})])
        self.assertEqual(api["base_url"], "http://192.168.1.20:8080")


    def test_header_sent_on_one_call_is_not_replayed_on_all(self):
        # A header seen on one call out of many has one distinct value, so it counts as constant.
        flows = [flow(10 + i, "GET", f"/v1/page/{i}", headers={"X-Device": "d1"}, resp={"n": i}) for i in range(5)]
        flows.append(flow(20, "POST", "/v1/upload", headers={"X-Device": "d1", "Origin": "https://example.com"}, resp={"id": 1}))
        api = analyze_inline(flows)
        self.assertNotIn("origin", api["constant_headers"])


    def test_value_flow_matches_titles_written_with_underscores(self):
        # Path templating matches "Solar_System" to "Solar System" in a response, but source_of() compares
        # exactly, so the source is lost ("user_choice") and a one-off titles= query value is marked fixed.
        api = analyze_fixture("wiki")
        langlinks = api["endpoints"]["GET https://{lang}.wikipedia.org/w/api.php?action=query&prop=langlinks"]
        self.assertNotIn("titles", langlinks["fixed_query"])


    def test_two_trailing_small_numbers_are_not_always_a_date(self):
        # Any path ending in two 2-digit segments is read as {month}/{day}, e.g. map tiles.
        api = analyze_inline([flow(10, "GET", "/v1/tiles/7/12/34", resp={"tile": "x"})])
        self.assertNotIn("GET /v1/tiles/{tile_id}/{month}/{day}", api["endpoints"])


if __name__ == "__main__":
    unittest.main()
