// ShowTime demo API: a small movie-booking backend that behaves like a real app's private API.
// Used only to test Unremote end to end. No dependencies.
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const PORT = +process.env.PORT || 8443;
const TOKEN_TTL = +process.env.TOKEN_TTL || 300; // seconds; short on purpose so refresh gets exercised
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));

const tokens = new Map();   // access token -> { userId, exp }
const refresh = new Map();  // refresh token -> userId
const holds = new Map();    // hold id -> { showId, seats, userId, total, status }
const taken = new Map();    // show id -> Set of seat ids held or booked
const events = [];          // analytics noise
const rid = (p, n = 6) => p + '_' + crypto.randomBytes(n).toString('hex');

function day(offset) {
  const d = new Date(Date.now() + offset * 864e5);
  return d.toISOString().slice(0, 10);
}
function showsFor(movieId, cityId, date) {
  // Deterministic show ids so the same movie/date/city always gives the same shows.
  const m = seed.movies.find(x => x.movie_id === movieId);
  if (!m || !m.cities.includes(cityId)) return [];
  const theatres = seed.theatres[cityId] || [];
  const out = [];
  theatres.forEach((t, ti) => m.times.forEach((time, k) => {
    const h = crypto.createHash('sha1').update(movieId + cityId + date + t + time).digest();
    out.push({ show_id: 10000 + (h.readUInt32BE(0) % 89999), theatre: t, starts_at: time, date, price_inr: m.price + ti * 40 });
  }));
  return out;
}
function seatmap(showId) {
  const t = taken.get(showId) || new Set();
  return ['A', 'B', 'C', 'D'].map(row => ({ row, seats: Array.from({ length: 8 }, (_, i) => {
    const id = row + (i + 1);
    return { seat_id: id, status: t.has(id) ? 'taken' : 'free' };
  }) }));
}
function findShow(showId) {
  for (const m of seed.movies) for (const c of m.cities) for (let o = 0; o < 3; o++)
    for (const s of showsFor(m.movie_id, c, day(o))) if (s.show_id === showId) return { ...s, movie_id: m.movie_id, title: m.title, city_id: c };
  return null;
}

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'x-request-id': rid('req', 4) });
  res.end(JSON.stringify(body));
}
function auth(req) {
  const h = req.headers.authorization || '';
  const t = tokens.get(h.replace(/^Bearer /, ''));
  if (!t || t.exp < Date.now()) return null;
  return t.userId;
}
function issue(userId) {
  const access = rid('at', 16), ref = rid('rt', 16);
  tokens.set(access, { userId, exp: Date.now() + TOKEN_TTL * 1000 });
  refresh.set(ref, userId);
  return { access_token: access, refresh_token: ref, token_type: 'bearer', expires_in: TOKEN_TTL };
}

async function route(req, res, url, body) {
  const p = url.pathname, q = url.searchParams, m = req.method;
  let x;
  // Startup config and analytics: noise a real app sends that is not part of any user task.
  if (m === 'GET' && p === '/v2/config') return send(res, 200, { min_version: '1.0.0', flags: { new_seatmap: true, promo_banner: false } });
  if (m === 'POST' && p === '/collect') { events.push(body); return send(res, 200, { ok: true }); }

  if (m === 'POST' && p === '/v2/auth/login') {
    const u = seed.users.find(u => u.email === body.email && u.password === body.password);
    if (!u) return send(res, 401, { error: 'invalid_credentials' });
    return send(res, 200, { ...issue(u.id), user: { id: u.id, name: u.name } });
  }
  if (m === 'POST' && p === '/v2/auth/refresh') {
    const userId = refresh.get(body.refresh_token);
    if (!userId) return send(res, 401, { error: 'invalid_refresh_token' });
    refresh.delete(body.refresh_token);
    return send(res, 200, issue(userId));
  }
  if (m === 'GET' && p === '/v2/cities') return send(res, 200, { cities: seed.cities });
  if (m === 'GET' && p === '/v2/movies') {
    const city = q.get('city_id');
    return send(res, 200, { items: seed.movies.filter(x => x.cities.includes(city)).map(({ movie_id, title, rating, languages, runtime_min }) => ({ movie_id, title, rating, languages, runtime_min })) });
  }
  if (m === 'GET' && (x = p.match(/^\/v2\/movies\/([\w-]+)\/shows$/))) {
    return send(res, 200, { movie_id: x[1], shows: showsFor(x[1], q.get('city_id'), q.get('date') || day(0)) });
  }

  // Everything below needs a signed-in user.
  const userId = auth(req);
  if (!userId) return send(res, 401, { error: 'unauthorized' });
  if (m === 'GET' && (x = p.match(/^\/v2\/shows\/(\d+)\/seatmap$/))) {
    const show = findShow(+x[1]);
    if (!show) return send(res, 404, { error: 'no_such_show' });
    return send(res, 200, { show_id: show.show_id, title: show.title, theatre: show.theatre, starts_at: show.starts_at, date: show.date, rows: seatmap(show.show_id) });
  }
  if (m === 'POST' && (x = p.match(/^\/v2\/shows\/(\d+)\/hold$/))) {
    const show = findShow(+x[1]);
    if (!show) return send(res, 404, { error: 'no_such_show' });
    const seats = body.seat_ids || [];
    const t = taken.get(show.show_id) || new Set();
    if (!seats.length || seats.some(s => t.has(s))) return send(res, 409, { error: 'seats_unavailable' });
    seats.forEach(s => t.add(s)); taken.set(show.show_id, t);
    const h = { hold_id: rid('hl'), show_id: show.show_id, seats, total_inr: seats.length * show.price_inr, userId, status: 'held', expires_in: 600 };
    holds.set(h.hold_id, h);
    const { userId: _, ...pub } = h;
    return send(res, 200, pub);
  }
  if (m === 'POST' && (x = p.match(/^\/v2\/holds\/([\w]+)\/checkout$/))) {
    const h = holds.get(x[1]);
    if (!h || h.userId !== userId) return send(res, 404, { error: 'no_such_hold' });
    h.status = 'awaiting_payment';
    return send(res, 200, { hold_id: h.hold_id, total_inr: h.total_inr, payment_url: 'https://pay.showtime.test/checkout/' + h.hold_id });
  }
  if (m === 'GET' && p === '/v2/me/bookings') {
    return send(res, 200, { bookings: [...holds.values()].filter(h => h.userId === userId).map(({ userId: _, ...h }) => h) });
  }
  send(res, 404, { error: 'not_found' });
}

// Test-only window into server state, so the e2e run can confirm a booking really happened.
function debug(res) { send(res, 200, { holds: [...holds.values()], events: events.length }); }

https.createServer({ key: fs.readFileSync(path.join(__dirname, 'key.pem')), cert: fs.readFileSync(path.join(__dirname, 'cert.pem')) }, (req, res) => {
  const url = new URL(req.url, 'https://localhost');
  if (url.pathname === '/__debug/state') return debug(res);
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'bad_json' }); }
    console.log(new Date().toISOString().slice(11, 19), req.method, req.url);
    route(req, res, url, body).catch(e => send(res, 500, { error: String(e) }));
  });
}).listen(PORT, '0.0.0.0', () => console.log('ShowTime API on https://0.0.0.0:' + PORT));
