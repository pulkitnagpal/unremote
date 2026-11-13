#!/usr/bin/env bash
# Smoke test for the ShowTime demo API: login, list, seatmap, hold, checkout.
set -euo pipefail
B=${B:-https://127.0.0.1:8443}
c() { curl -sk "$@"; }
j() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
c "$B/v2/movies?city_id=BLR" | j "[m['title'] for m in d['items']]"
TOK=$(c "$B/v2/auth/login" -d '{"email":"demo@showtime.test","password":"showtime-demo"}' | j "d['access_token']")
D=$(date -v+1d +%F)
SID=$(c "$B/v2/movies/mv_dune3/shows?city_id=BLR&date=$D" | j "d['shows'][1]['show_id']")
echo "show $SID"
c "$B/v2/shows/$SID/seatmap" -H "Authorization: Bearer $TOK" | j "(d['title'], d['starts_at'], len(d['rows']))"
HID=$(c "$B/v2/shows/$SID/hold" -H "Authorization: Bearer $TOK" -d '{"seat_ids":["C4","C5"]}' | j "d['hold_id']")
c -X POST "$B/v2/holds/$HID/checkout" -H "Authorization: Bearer $TOK" | j "d['payment_url']"
c "$B/v2/shows/$SID/seatmap" | j "d"
