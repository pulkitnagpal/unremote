// The Unremote launch film as one seekable stage. Everything on screen is a function of the time t (seconds): no CSS
// transitions, no timers, so headless Brave can step it frame by frame (film/render.mjs) and the design boards can freeze
// it at any moment (film/boards.html).
//
//   const film = UnremoteFilm.mount(rootElement, data);  await film.seek(12.5);
(function () {
  'use strict';

  // ---------- easing and helpers ----------
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const seg = (t, a, b) => (b <= a ? (t >= a ? 1 : 0) : clamp((t - a) / (b - a)));
  const eo = (x) => 1 - Math.pow(1 - clamp(x), 3);
  const ei = (x) => Math.pow(clamp(x), 3);
  const eio = (x) => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  const back = (x) => { x = clamp(x); const c = 1.5; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
  const lerp = (a, b, x) => a + (b - a) * x;
  /** 0 → 1 over [a, a+fi], held, 1 → 0 over [b-fo, b]. */
  const win = (t, a, b, fi = 0.3, fo = 0.3) => Math.min(seg(t, a, a + fi), 1 - seg(t, b - fo, b));
  const wob = (seed, x) => 0.55 * Math.sin(x * 2.1 + seed * 7.3) + 0.3 * Math.sin(x * 4.7 + seed * 3.1) + 0.15 * Math.sin(x * 9.3 + seed);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  /** Piecewise-linear [sceneT, value] knots, read at t. */
  const mapT = (map, t) => {
    if (t <= map[0][0]) return map[0][1];
    for (let i = 0; i < map.length - 1; i++) { const [a, va] = map[i], [b, vb] = map[i + 1]; if (t < b) return lerp(va, vb, (t - a) / (b - a)); }
    return map[map.length - 1][1];
  };
  const fmtTime = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  function h(tag, cls, html, style) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    if (style) Object.assign(e.style, style);
    return e;
  }
  /** Places an element at (x, y) on the stage and applies opacity, an offset, a scale and a rotation. */
  function put(e, o) {
    const op = o.o == null ? 1 : clamp(o.o);
    const vis = op > 0.001;
    if (e._vis !== vis) { e.style.visibility = vis ? 'visible' : 'hidden'; e._vis = vis; }
    if (!vis) return;
    e.style.opacity = op.toFixed(3);
    const tf = `translate(${(o.dx || 0).toFixed(2)}px, ${(o.dy || 0).toFixed(2)}px) scale(${(o.s == null ? 1 : o.s).toFixed(4)}) rotate(${(o.r || 0).toFixed(2)}deg)`;
    if (e._tf !== tf) { e.style.transform = tf; e._tf = tf; }
  }
  function at(parent, e, x, y, origin) {
    e.classList.add('abs');
    e.style.left = x + 'px'; e.style.top = y + 'px';
    if (origin) e.style.transformOrigin = origin;
    parent.appendChild(e);
    return e;
  }

  // ---------- hand-drawn strokes ----------
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svgLayer(parent) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('class', 'ink'); s.setAttribute('width', '1920'); s.setAttribute('height', '1080');
    s.setAttribute('viewBox', '0 0 1920 1080');
    parent.appendChild(s);
    return s;
  }
  function polyLen(p) { let L = 0; for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return L; }
  /** A stroke that can be drawn on from 0 to 1. */
  function stroke(svg, pts, color, width, extra = {}) {
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', 'M' + pts.map((q) => q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join(' L'));
    p.setAttribute('fill', 'none'); p.setAttribute('stroke', color); p.setAttribute('stroke-width', width);
    p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
    for (const k in extra) p.setAttribute(k, extra[k]);
    const L = polyLen(pts) + 1;
    p.style.strokeDasharray = `${L} ${L}`;
    p.style.strokeDashoffset = L;
    svg.appendChild(p);
    let last = -1;
    return {
      el: p, pts, len: L,
      draw(x, op = 1) {
        x = clamp(x);
        const v = (L * (1 - x)).toFixed(1) + '|' + op.toFixed(2);
        if (v === last) return; last = v;
        p.style.strokeDashoffset = (L * (1 - x)).toFixed(1);
        p.style.opacity = x <= 0.001 ? 0 : op;
      },
    };
  }
  /** A marker loop around a box: a little more than one turn, slightly wobbly. */
  function loopPts(cx, cy, rx, ry, seed = 1, turns = 1.12) {
    const out = [], n = 120, a0 = -2.2 + seed * 0.4;
    for (let i = 0; i <= n; i++) {
      const u = i / n, a = a0 + u * turns * Math.PI * 2;
      const k = 1 + 0.035 * wob(seed, u * 6) + 0.05 * u;
      out.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
    }
    return out;
  }
  /** A gently wobbling line through the given points (Catmull-Rom smoothed). */
  function linePts(ctrl, seed = 1, amp = 1.6) {
    const out = [];
    const P = (i) => ctrl[Math.max(0, Math.min(ctrl.length - 1, i))];
    for (let i = 0; i < ctrl.length - 1; i++) {
      const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
      const n = Math.max(6, Math.round(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 8));
      for (let j = 0; j < n; j++) {
        const t = j / n, t2 = t * t, t3 = t2 * t;
        const x = 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
        const y = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
        out.push([x, y]);
      }
    }
    out.push(ctrl[ctrl.length - 1]);
    return out.map((q, i) => [q[0] + amp * wob(seed, i * 0.21), q[1] + amp * wob(seed + 3, i * 0.19)]);
  }
  function arrowHead(end, prev, size = 14) {
    const a = Math.atan2(end[1] - prev[1], end[0] - prev[0]);
    return [[end[0] - size * Math.cos(a - 0.5), end[1] - size * Math.sin(a - 0.5)], end, [end[0] - size * Math.cos(a + 0.5), end[1] - size * Math.sin(a + 0.5)]];
  }
  /** Down, across and down again, with rounded corners: the path a value takes from one row of the map to the next. */
  function elbowPts(a, b, y, r = 26) {
    const out = [], dir = Math.sign(b[0] - a[0]) || 1;
    const arc = (cx, cy, a0, a1) => { for (let i = 0; i <= 8; i++) { const u = a0 + (a1 - a0) * i / 8; out.push([cx + r * Math.cos(u), cy + r * Math.sin(u)]); } };
    out.push(a, [a[0], y - r]);
    arc(a[0] + dir * r, y - r, dir > 0 ? Math.PI : 0, Math.PI / 2);
    out.push([b[0] - dir * r, y]);
    arc(b[0] - dir * r, y + r, -Math.PI / 2, dir > 0 ? 0 : -Math.PI);
    out.push(b);
    const dense = [];
    for (let i = 0; i < out.length - 1; i++) { const p = out[i], q = out[i + 1], n = Math.max(1, Math.round(Math.hypot(q[0] - p[0], q[1] - p[1]) / 10)); for (let j = 0; j < n; j++) dense.push([p[0] + (q[0] - p[0]) * j / n, p[1] + (q[1] - p[1]) * j / n]); }
    dense.push(b);
    return dense.map((q, i) => [q[0] + 1.1 * wob(5, i * 0.21), q[1] + 1.1 * wob(8, i * 0.19)]);
  }
  function arrow(svg, ctrl, color, width, seed) {
    const body = stroke(svg, ctrl.raw ? ctrl.raw : linePts(ctrl, seed, 1.2), color, width);
    const pts = body.pts;
    const head = stroke(svg, arrowHead(pts[pts.length - 1], pts[Math.max(0, pts.length - 4)]), color, width);
    return { draw(x, op = 1) { body.draw(seg(x, 0, 0.85), op); head.draw(seg(x, 0.85, 1), op); } };
  }

  // ---------- data the film draws from (film/stage.mjs fills window.UNREMOTE_DATA; these are the real ShowTime values) ----------
  const DEFAULTS = {
    manual: { frames: null, taps: 27, screens: 11, seconds: 107 },
    scan: { frames: null },
    actions: [
      ['launch', '', 'Opening ShowTime for the first time.'],
      ['type "demo@showtime.test" into "Email"', 'Log in', 'The app opened on the Log in screen, so I’m entering the test account email first.'],
      ['type "showtime-demo" into "Password"', 'Log in', 'Email is entered; now the test account password.'],
      ['tap "Log in"', 'Log in', 'Email and password are filled in, so I’m tapping Log in.'],
      ['tap "Bengaluru"', 'Choose your city', 'Select Bengaluru to see what’s playing there.'],
      ['tap "Dune: Part Three"', 'Now showing', 'Each movie shows its rating and runtime. Opening Dune: Part Three to check showtimes.'],
      ['tap "Today (2026-11-13)"', 'Dune: Part Three', 'Open today’s showtimes to check theatres and prices.'],
      ['tap "PVR Orion · 19:00 · ₹320"', 'Showtimes', 'Prices across PVR Orion and INOX Indiranagar are listed. Picking the 19:00 show.'],
      ['tap "A1"', 'Pick seats', 'Showtime picked. Now selecting a free seat on the seat map.'],
      ['tap "HOLD 1 SEAT(S)"', 'Pick seats', 'A1 is selected, so holding it for 10 minutes.'],
      ['tap "Proceed to pay"', 'Seats held', 'The seat is held. Proceed to the payment link.'],
      ['tap "Done"', 'Payment', 'The secure checkout link is showing, so I stop before paying.'],
      ['tap "My bookings"', 'Choose your city', 'Open My bookings to review all bookings in one place.'],
    ],
    // first action that called each endpoint (from runs/…/api_map.json triggers)
    trig: { config: 0, collect: 0, login: 3, cities: 3, movies: 4, shows: 6, seatmap: 7, hold: 9, checkout: 10, bookings: 12 },
    stats: { requests: 21, endpoints: 10 },
    tools: [
      ['list_cities', 'r', 'Cities ShowTime operates in. city_id feeds list_movies.'],
      ['list_movies', 'r', 'Movies now showing in a city: rating, languages, runtime.'],
      ['list_showtimes', 'r', 'Theatre, start time and price in INR, for a date.'],
      ['get_seatmap', 'r', 'The live seat map for a showtime, to pick free seats.'],
      ['hold_seats', 'w', 'Holds seats for about 10 minutes. Confirm with the user first.'],
      ['checkout_hold', 'w', 'Starts checkout, returns the secure payment_url.'],
      ['list_my_bookings', 'r', 'The user’s bookings and holds, with time left.'],
    ],
    booking: {
      prompt: 'Book 2 seats next to each other for Dune tomorrow evening at the cheaper theatre',
      date: '2026-11-14', time: '19:00', show: 48213, hold: 'hl_9c41e07ab2d3',
      url: 'https://pay.showtime.test/checkout/hl_9c41e07ab2d3',
      taken: ['A3', 'A4', 'B4', 'B5', 'B6', 'C1', 'C2', 'C6', 'D7'],
      seconds: 12,
    },
  };

  // ---------- ShowTime stand-in screens (until the real recordings are in media/raw) ----------
  const POSTER = { dune: 'linear-gradient(160deg,#C9A36B,#6B4A2B)', kalki: 'linear-gradient(160deg,#4B5D8C,#1D2340)', padd: 'linear-gradient(160deg,#D9534F,#8C2F2B)' };
  function stScreen(key) {
    const sb = '<div class="sb"><span>9:41</span><span><i></i><i></i></span></div>';
    const bar = (title, back = true) => `<div class="bar">${back ? '<span class="bk">←</span>' : ''}${title}</div>`;
    switch (key) {
      case 'login': return `${sb}<div class="pad" style="padding-top:120px;gap:18px"><div class="brand">ShowTime</div><div style="font:500 17px var(--sans);color:#49454F;margin-bottom:22px">Movies near you, booked in a minute.</div>
        <div class="field" data-f="email"><small>Email</small></div><div class="field" data-f="pw"><small>Password</small></div><div class="btn" style="margin-top:8px">Log in</div></div>`;
      case 'city': return `${sb}${bar('Choose your city', false)}<div style="padding:6px 0">
        <div class="row">Bengaluru</div><div class="row">Delhi</div></div><div style="position:absolute;bottom:40px;left:18px;right:18px" class="chip">My bookings</div>`;
      case 'movies': return `${sb}${bar('Now showing')}<div>
        <div class="row" style="height:100px"><div class="poster" style="background:${POSTER.dune}"></div><div>Dune: Part Three<div class="meta">UA · 166 min · English, Hindi</div></div></div>
        <div class="row" style="height:100px"><div class="poster" style="background:${POSTER.kalki}"></div><div>Kalki 2898 AD Part 2<div class="meta">UA · 172 min · Telugu, Hindi</div></div></div>
        <div class="row" style="height:100px"><div class="poster" style="background:${POSTER.padd}"></div><div>Paddington 4<div class="meta">U · 104 min · English</div></div></div></div>`;
      case 'movie': return `${sb}${bar('Dune: Part Three')}<div style="height:190px;margin:0 18px;border-radius:14px;background:${POSTER.dune}"></div>
        <div class="pad"><div class="meta" style="font-size:14px">UA · 166 min · English, Hindi</div><div style="font:600 16px var(--sans);margin-top:10px">Pick a day</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><span class="chip" data-c="d0">Today</span><span class="chip" data-c="d1">Tomorrow</span><span class="chip" data-c="d2">Sun 15</span></div></div>`;
      case 'shows': return `${sb}${bar('Showtimes')}<div class="pad" style="gap:16px">
        ${['PVR Orion|320', 'INOX Indiranagar|360'].map((x) => { const [n, p] = x.split('|'); return `<div><div style="font:600 16px var(--sans)">${n}</div><div class="meta">₹${p} a seat</div>
        <div style="display:flex;gap:8px;margin-top:10px">${['16:00', '19:00', '22:15'].map((t) => `<span class="chip" data-c="${n[0]}${t}">${t}</span>`).join('')}</div></div>`; }).join('')}</div>`;
      case 'seats': {
        let g = '';
        for (const r of 'ABCD') { g += `<div style="display:flex;gap:7px;justify-content:center">`; for (let i = 1; i <= 8; i++) g += `<div class="seat" data-s="${r}${i}">${r}${i}</div>`; g += '</div>'; }
        return `${sb}${bar('Pick seats')}<div class="meta" style="padding:0 18px 10px">PVR Orion · 19:00 · ₹320</div><div class="scr"></div><div class="tl">SCREEN</div>
          <div style="display:flex;flex-direction:column;gap:9px;margin-top:22px">${g}</div><div class="btn" data-b="hold" style="position:absolute;left:18px;right:18px;bottom:40px">HOLD SEATS</div>`;
      }
      case 'held': return `${sb}${bar('Seats held')}<div class="pad" style="gap:14px;padding-top:30px"><div style="font:700 26px var(--sans)">Held for 10:00</div>
        <div class="meta" style="font-size:15px" data-t="heldseats">Dune: Part Three · PVR Orion · 19:00</div><div class="btn" style="margin-top:20px">Proceed to pay</div></div>`;
      case 'payment': return `${sb}${bar('Payment')}<div class="pad" style="gap:14px;padding-top:30px"><div style="font:600 17px var(--sans)">Secure checkout</div>
        <div class="field" style="font-size:13px;color:#1D4ED8">pay.showtime.test/checkout/…</div><div class="btn" style="margin-top:14px">Done</div></div>`;
      case 'bookings': return `${sb}${bar('My bookings')}<div><div class="row" style="height:84px"><div>Dune: Part Three<div class="meta">PVR Orion · 19:00 · awaiting payment</div></div></div></div>`;
    }
    return '';
  }
  const SCREENS = ['login', 'city', 'movies', 'movie', 'shows', 'seats', 'held', 'payment', 'bookings'];

  /** A phone that plays either a real recording (an image sequence) or the stand-in screens driven by a script. */
  function makePhone(parent, x, y, opts) {
    const ph = at(parent, h('div', 'phone'), x, y, '50% 50%');
    const scr = h('div', 'screen'); ph.appendChild(scr);
    const sc = {};
    for (const k of SCREENS) { const d = h('div', 'st', stScreen(k)); d.style.display = 'none'; scr.appendChild(d); sc[k] = d; }
    const img = h('img'); img.style.display = 'none'; img.decoding = 'sync'; scr.appendChild(img);
    const xray = h('div', 'xray'); scr.appendChild(xray);
    const rip = []; for (let i = 0; i < 3; i++) { const r = h('div', 'ripple' + (opts.agent ? ' agent' : '')); r.style.display = 'none'; scr.appendChild(r); rip.push(r); }
    let shown = null, lastSrc = '';
    return {
      el: ph,
      /** steps: [{t, screen, tap:[x,y], set:{…}}]; frames: {dir, count, ext, fps, map:[[sceneT, videoT], …]} */
      async show(t, steps, frames, extra = {}) {
        if (frames) {
          img.style.display = 'block';
          const vt = mapT(frames.map, t);
          const n = clamp(Math.round(vt * frames.fps) + 1, 1, frames.count);
          const src = `${frames.dir}/${String(n).padStart(5, '0')}.${frames.ext || 'jpg'}`;
          if (src !== lastSrc) { lastSrc = src; img.src = (window.UNREMOTE_FRAME_URI || {})[src] || src; try { await img.decode(); } catch (e) { /* missing frame: keep last */ } }
          if (shown) { sc[shown].style.display = 'none'; shown = null; }
        } else {
          img.style.display = 'none';
          let cur = steps[0];
          for (const s of steps) if (t >= s.t) cur = s;
          if (shown !== cur.screen) { if (shown) sc[shown].style.display = 'none'; sc[cur.screen].style.display = 'block'; shown = cur.screen; }
          const state = {};
          for (const s of steps) if (t >= s.t && s.set) Object.assign(state, s.set);
          applyState(sc, state);
        }
        // tap ripples
        const taps = (frames ? frames.taps || [] : steps.filter((s) => s.tap).map((s) => ({ t: s.t - 0.18, x: s.tap[0], y: s.tap[1] })));
        const live = taps.filter((p) => p.x != null && t >= p.t && t < p.t + 0.5).slice(-3);
        rip.forEach((r, i) => {
          const p = live[i];
          if (!p) { r.style.display = 'none'; return; }
          const u = (t - p.t) / 0.5;
          r.style.display = 'block'; r.style.left = p.x + 'px'; r.style.top = p.y + 'px';
          r.style.opacity = (1 - u).toFixed(3); r.style.transform = `scale(${(0.45 + 0.8 * eo(u)).toFixed(3)})`;
        });
        xray.style.background = `rgba(250,249,246,${(extra.xray || 0).toFixed(3)})`;
      },
    };
  }
  function applyState(sc, st) {
    const L = sc.login;
    L.querySelector('[data-f=email]').innerHTML = st.email ? `<span>${esc(st.email)}</span>` : '<small>Email</small>';
    L.querySelector('[data-f=pw]').innerHTML = st.pw ? '<span>•••••••••••••</span>' : '<small>Password</small>';
    sc.movie.querySelectorAll('[data-c]').forEach((c) => c.classList.toggle('on', c.dataset.c === st.day));
    sc.shows.querySelectorAll('[data-c]').forEach((c) => c.classList.toggle('on', c.dataset.c === st.show));
    const sel = st.seats || [], taken = st.taken || [];
    sc.seats.querySelectorAll('[data-s]').forEach((c) => { c.classList.toggle('sel', sel.includes(c.dataset.s)); c.classList.toggle('taken', taken.includes(c.dataset.s)); });
    sc.seats.querySelector('[data-b=hold]').textContent = sel.length ? `HOLD ${sel.length} SEAT${sel.length > 1 ? 'S' : ''}` : 'HOLD SEATS';
  }
  // seat centres on the stand-in seat map (360-wide screen): 8 seats of 30px + 7 gaps of 7px, centred
  const seatXY = (id) => [(360 - (8 * 30 + 7 * 7)) / 2 + (Number(id.slice(1)) - 1) * 37 + 15, 36 + 60 + 28 + 6 + 6 + 18 + 22 + 'ABCD'.indexOf(id[0]) * 37 + 14];

  // ============================================================================================
  function mount(root, data) {
    const D = Object.assign({}, DEFAULTS, data || {});
    D.booking = Object.assign({}, DEFAULTS.booking, (data || {}).booking || {});
    D.manual = Object.assign({}, DEFAULTS.manual, (data || {}).manual || {});
    D.scan = Object.assign({}, DEFAULTS.scan, (data || {}).scan || {});
    const stage = h('div', 'uf-stage');
    root.appendChild(stage);
    const world = h('div', 'world'); stage.appendChild(world);
    world.appendChild(h('div', 'grid'));
    const L = (x) => world.appendChild(x);

    // ---------------- Act 1: by hand ----------------
    const A = { phone: makePhone(world, 360, 96, {}) };
    const title = at(world, h('div', 'hand', 'Booking two movie tickets, by hand.', { fontSize: '60px' }), 860, 112);
    const TALLY_Y = [270, 455];
    const kTaps = at(world, h('div', 'tally-k', 'Taps'), 866, TALLY_Y[0]);
    const vTaps = at(world, h('div', 'tally-v', '0'), 860, TALLY_Y[0] + 34);
    const kScr = at(world, h('div', 'tally-k', 'Screens'), 866, TALLY_Y[1]);
    const vScr = at(world, h('div', 'tally-v', '0'), 860, TALLY_Y[1] + 34);
    const kTime = at(world, h('div', 'tally-k', 'Time'), 1390, TALLY_Y[1]);
    const vTime = at(world, h('div', 'tally-v', '0:00'), 1384, TALLY_Y[1] + 34);
    const inkA = svgLayer(world);
    const tallyMarks = [];
    for (let i = 0; i < 40; i++) {
      const grp = Math.floor(i / 5), k = i % 5, gx = 1050 + grp * 88, y0 = TALLY_Y[0] + 42, y1 = TALLY_Y[0] + 118;
      if (gx > 1820) break;
      const pts = k < 4 ? linePts([[gx + k * 15, y0 + (k % 2) * 3], [gx + k * 15 + 2, y1]], i, 0.7) : linePts([[gx - 10, y1 - 12], [gx + 58, y0 + 14]], i, 0.7);
      tallyMarks.push(stroke(inkA, pts, '#16161A', 5));
    }
    const crumbs = ['Log in', 'Bengaluru', 'Dune: Part Three', 'Tomorrow', 'INOX 19:00', 'back', 'PVR Orion 19:00', 'C4', 'C5', 'Hold 2 seats'];
    const crumbRow = at(world, h('div', null, null, { width: '980px', display: 'flex', flexWrap: 'wrap', gap: '12px 10px' }), 866, 680);
    const crumbEls = crumbs.map((c, i) => { const e = h('span', 'crumb', (i ? '<span style="color:#B9B5AE;margin-right:10px">›</span>' : '') + esc(c)); crumbRow.appendChild(e); e.style.display = 'inline-flex'; return e; });
    // the hidden API under the taps
    const apis = [['GET', '/v2/cities'], ['GET', '/v2/movies?city_id=BLR'], ['GET', '/v2/movies/mv_dune3/shows?date=2026-11-14'], ['GET', '/v2/shows/29418/seatmap'], ['POST', '/v2/shows/29418/hold'], ['POST', '/v2/holds/hl_1b05…/checkout']];
    const apiEls = apis.map(([m, p], i) => at(world, h('div', 'apiline', `<span>${m}</span> ${esc(p)}`), 880, 250 + i * 92));
    const apiWires = apis.map((_, i) => stroke(inkA, linePts([[744, 300 + i * 70], [800, 300 + i * 70], [850, 266 + i * 92]], i + 9, 0.6), '#1FB57A', 3));

    // manual script for the stand-in phone: [time, screen, tap, set]
    const ms = [];
    const M = (t, screen, tap, set) => ms.push({ t, screen, tap, set });
    M(0, 'login'); M(0.55, 'login', [180, 212], { email: 'demo@showtime.test' }); M(1.05, 'login', [180, 278], { pw: 1 }); M(1.5, 'city', [180, 410]);
    M(2.15, 'movies', [120, 132]); M(2.9, 'movie', [150, 160]); M(3.6, 'movie', [150, 445], { day: 'd1' }); M(4.2, 'shows', [180, 400]);
    M(5.0, 'shows', [126, 216], { show: 'P19:00' }); M(5.6, 'seats', [180, 140], { taken: D.booking.taken }); M(6.3, 'seats', seatXY('C4'), { seats: ['C4'] });
    M(6.75, 'seats', seatXY('C5'), { seats: ['C4', 'C5'] }); M(7.4, 'seats', [180, 740]); M(7.9, 'held', [180, 240]); M(8.6, 'payment', [180, 320]); M(9.6, 'payment');
    const MAN_END = 10.2;

    // ---------------- Act 2: unremote learn ----------------
    const term = at(world, h('div', 'term', '<div><span class="p">$</span> unremote learn showtime<span class="caret" style="background:#EDEBE6"></span></div><div class="dim" data-a> </div>'), 80, 46);
    const termCaret = term.querySelector('.caret'), termAct = term.querySelector('[data-a]');
    const why = at(world, h('div', 'hand', '', { fontSize: '34px', color: '#3F3F46', maxWidth: '1000px', overflow: 'hidden', textOverflow: 'ellipsis' }), 84, 170);
    const goals = at(world, h('div', 'side', `<div class="k">From the store listing</div><div style="font:500 22px/1.6 var(--sans);color:#3F3F46">Choose a city, browse what’s on<br>Compare showtimes and prices<br>Sign in, pick free seats<br>Hold them, get the payment link<br><span style="color:#9A968F">(stop before paying)</span></div>`, { width: '520px' }), 1000, 470, '0 0');
    const B = { phone: makePhone(world, 360, 96, { agent: true }) };
    // endpoints on the map
    const COLS = [480, 970, 1460], ROWS = [258, 446, 634, 812];
    const EP = {
      login: ['POST', '/v2/auth/login', 'sign in · token on every call', 0, 0],
      config: ['GET', '/v2/config', 'app bootstrap', 1, 0, 'ghost'],
      collect: ['POST', '/collect', 'telemetry · left out', 2, 0, 'ghost'],
      cities: ['GET', '/v2/cities', 'on “Choose your city”', 0, 1],
      movies: ['GET', '/v2/movies?<em>city_id</em>', 'on “Now showing”', 1, 1],
      shows: ['GET', '/v2/movies/<em>{movie_id}</em>/shows', 'on “Dune: Part Three”', 2, 1],
      seatmap: ['GET', '/v2/shows/<em>{show_id}</em>/seatmap', 'on “Pick seats”', 0, 2],
      hold: ['POST', '/v2/shows/<em>{show_id}</em>/hold', 'holds seats for 10 minutes', 1, 2],
      checkout: ['POST', '/v2/holds/<em>{hold_id}</em>/checkout', 'returns a payment link', 2, 2],
      bookings: ['GET', '/v2/me/bookings', 'on “My bookings”', 0, 3],
    };
    const epEl = {};
    for (const k in EP) {
      const [m, p, sub, c, r, ghost] = EP[k];
      epEl[k] = at(world, h('div', 'ep' + (ghost ? ' ghost' : ''), `<div class="path"><span class="m ${m === 'POST' ? 'post' : ''}">${m}</span>${p}</div><div class="sub">${sub}</div>`), COLS[c], ROWS[r], '50% 50%');
    }
    const inkB = svgLayer(world);
    const CW = 390, CH = 84;
    const mid = (k, side) => { const [, , , c, r] = EP[k]; const x = COLS[c], y = ROWS[r]; return side === 'r' ? [x + CW, y + CH / 2] : side === 'l' ? [x, y + CH / 2] : side === 'b' ? [x + CW / 2, y + CH] : [x + CW / 2, y]; };
    const gapY = (ROWS[1] + CH + ROWS[2]) / 2;
    const flows = [
      { from: 'cities', to: 'movies', v: 'city_id', ctrl: [mid('cities', 'r'), mid('movies', 'l')] },
      { from: 'movies', to: 'shows', v: 'movie_id', ctrl: [mid('movies', 'r'), mid('shows', 'l')] },
      { from: 'shows', to: 'seatmap', v: 'show_id', ctrl: Object.assign([mid('shows', 'b'), mid('seatmap', 't')], { raw: elbowPts(mid('shows', 'b'), [mid('seatmap', 't')[0], mid('seatmap', 't')[1] - 4], gapY) }), chip: [(COLS[0] + COLS[2] + CW) / 2, gapY] },
      { from: 'seatmap', to: 'hold', v: 'show_id', ctrl: [mid('seatmap', 'r'), mid('hold', 'l')] },
      { from: 'hold', to: 'checkout', v: 'hold_id', ctrl: [mid('hold', 'r'), mid('checkout', 'l')] },
    ].map((f, i) => {
      f.arrow = arrow(inkB, f.ctrl, '#1FB57A', 4, i + 2);
      const c = f.chip || [(f.ctrl[0][0] + f.ctrl[f.ctrl.length - 1][0]) / 2, f.ctrl[0][1]];
      f.chipEl = at(world, h('div', 'val', f.v, { fontSize: '15px', height: '30px', padding: '0 10px' }), 0, 0, '50% 50%');
      f.c = c;
      return f;
    });
    const payChip = at(world, h('div', 'val', 'payment_url'), COLS[2] + 120, ROWS[3] + 10, '50% 50%');
    const payArrow = arrow(inkB, [[COLS[2] + 195, ROWS[2] + CH + 4], [COLS[2] + 195, ROWS[3] + 4]], '#1FB57A', 4, 11);
    const strike = stroke(inkB, linePts([[COLS[2] + 18, ROWS[0] + 30], [COLS[2] + 240, ROWS[0] + 28]], 4, 1), '#D92D20', 4);
    const tokenArrow = arrow(inkB, [[COLS[0] + CW / 2, ROWS[0] + CH], [COLS[0] + CW / 2 + 6, ROWS[1] - 6]], '#16161A', 3, 13);
    const tokenNote = at(world, h('div', 'hand', 'token', { fontSize: '30px' }), COLS[0] + CW / 2 + 22, ROWS[0] + CH + 10);
    const stats = at(world, h('div', 'stat', '', { width: '700px', textAlign: 'right' }), 1150, 186);
    const pings = [0, 1].map(() => at(world, h('div', null, null, { width: '16px', height: '16px', borderRadius: '50%', background: '#1FB57A', boxShadow: '0 0 0 6px rgba(31,181,122,.18)' }), 0, 0));
    // agent script for the stand-in phone, one action every SCAN_STEP seconds from SCAN_T0
    const SCAN_T0 = 16.2, SCAN_STEP = 0.95;
    const actT = (i) => SCAN_T0 + i * SCAN_STEP;
    const AS = [
      ['login', null, null], ['login', [180, 212], { email: 'demo@showtime.test' }], ['login', [180, 278], { pw: 1 }], ['login', [180, 352]],
      ['city', [180, 128]], ['movies', [150, 146]], ['movie', [80, 445], { day: 'd0' }], ['shows', [126, 216], { show: 'P19:00' }],
      ['seats', seatXY('A1'), { seats: ['A1'] }], ['seats', [180, 740]], ['held', [180, 240]], ['payment', [180, 320]], ['city', [180, 776]],
    ];
    const as = [];
    AS.forEach(([screen, tap, set], i) => {
      as.push({ t: i ? actT(i) - 0.6 : 0, screen });
      if (tap) as.push({ t: actT(i) - 0.07, screen, tap, set: Object.assign({ taken: ['A3', 'B5'] }, set) });
    });
    as.push({ t: actT(12) + 0.35, screen: 'bookings' });
    const SCAN_END = actT(12) + 1.0;

    // tools
    const tools = at(world, h('div', 'tools', `<h3>showtime <small>· ${D.tools.length} tools, designed by Claude</small></h3>` +
      D.tools.map(([n, e, d]) => `<div class="tool"><div class="n">${n}</div><div class="e ${e === 'w' ? 'w' : ''}">${e === 'w' ? 'write' : 'read'}</div><div class="d">${esc(d)}</div></div>`).join('')), 880, 214, '50% 0');
    const toolRows = [...tools.querySelectorAll('.tool')];
    const file = at(world, h('div', 'file', '<small>MCP server</small> generated/showtime/server.mjs'), 880, 812);

    // ---------------- Act 3: just ask ----------------
    const BK = D.booking;
    const calls = [
      ['list_cities', '', 'Bengaluru (BLR), Delhi (DEL)'],
      ['list_movies', 'city_id: "BLR"', 'Dune: Part Three (mv_dune3), Kalki 2898 AD Part 2, Paddington 4'],
      ['list_showtimes', `movie_id: "mv_dune3", city_id: "BLR", date: "${BK.date}"`, `PVR Orion ${BK.time} ₹320 · INOX Indiranagar ${BK.time} ₹360 · …`],
      ['get_seatmap', `show_id: ${BK.show}`, 'rows A–D, 8 seats each · C4 and C5 free, side by side'],
      ['hold_seats', `show_id: ${BK.show}, seat_ids: ["C4", "C5"]`, `${BK.hold} · held for 10 minutes · ₹640`],
      ['checkout_hold', `hold_id: "${BK.hold}"`, 'payment_url'],
    ];
    // Claude Code's real reply (media/raw/claude-booking.txt) as it renders: bold labels, bullets, the link underlined
    const md = (l) => esc(l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/^- /, '• ').replace(/(https:\/\/\S+)/, '<u>$1</u>');
    const replyLines = BK.reply || ['Your seats are held and checkout is started.', '', `**Payment link:** ${BK.url}`];
    const answer = replyLines.map((l) => (l.trim() ? md(l) : '<i></i>')).join(' <br> ');
    const cc = at(world, h('div', 'cc', `<div class="tb"><i></i><i></i><i></i><span>claude — ~/movies</span></div><div class="body"><div data-in>
      <div class="ln" style="color:#6B6B74;margin-bottom:16px"><span style="color:#D97757">✻</span> Claude Code · MCP: showtime (${D.tools.length} tools)</div>
      <div class="you"><span class="p">&gt; </span><span data-p></span><span class="caret" data-c></span></div>
      <div data-calls style="margin-top:18px"></div><div class="ans" data-ans style="margin-top:10px"></div></div></div>`), 80, 70, '0 0');
    const ccIn = cc.querySelector('[data-in]'), ccBody = cc.querySelector('.body');
    const ccPrompt = cc.querySelector('[data-p]'), ccCaret = cc.querySelector('[data-c]'), ccCalls = cc.querySelector('[data-calls]'), ccAns = cc.querySelector('[data-ans]');
    const callEls = calls.map(([n, a, r]) => {
      const d = h('div', null, `<div class="ln"><span class="dot">●</span> <span class="tn">showtime · ${n}</span><span class="arg">(${esc(a)})</span></div><div class="ln res">⎿  ${esc(r)}</div>`);
      d.style.lineHeight = '1.45'; d.style.marginBottom = '6px';
      d.querySelector('.arg').style.fontSize = '18px';
      ccCalls.appendChild(d);
      return d;
    });
    const ansTxt = ccAns;
    const sideTh = at(world, h('div', 'side', `<div class="k">Tomorrow · ${BK.time} · Dune: Part Three</div><div class="th"><span>PVR Orion</span><span class="pr">₹320</span></div><div class="th" style="color:#9A968F"><span>INOX Indiranagar</span><span class="pr">₹360</span></div>`), 1250, 70, '0 0');
    let grid = '';
    for (const r of 'ABCD') { grid += `<div class="rl">${r}</div>`; for (let i = 1; i <= 8; i++) { const id = r + i; grid += `<div class="s ${BK.taken.includes(id) ? 't' : ''}" data-s="${id}">${i}</div>`; } }
    const sideSeats = at(world, h('div', 'side', `<div class="k">PVR Orion · seat map</div><div style="height:6px;border-radius:3px;background:#E6E3DD;margin:2px 30px 14px"></div><div class="seatgrid">${grid}</div>`), 1250, 296, '0 0');
    const seatEls = [...sideSeats.querySelectorAll('[data-s]')].filter((e) => ['C4', 'C5'].includes(e.dataset.s));
    const sideTime = at(world, h('div', 'side', `<div class="k">Same booking</div><div style="display:flex;gap:56px;align-items:flex-end"><div><div class="vs" style="color:#9A968F;font-size:54px;white-space:nowrap">${D.manual.taps} taps</div><div class="stat" style="margin-top:8px">by hand, ${D.manual.screens} screens</div></div><div><div class="vs" style="color:#0B7A50;font-size:54px;white-space:nowrap">1 sentence</div><div class="stat" style="margin-top:8px">to Claude Code</div></div></div>`), 1250, 690, '0 0');
    const inkC = svgLayer(world);
    let thLoop = null, seatLoop = null, linkLoop = null;
    const cheaper = at(world, h('div', 'hand', 'cheaper', { fontSize: '36px', color: '#D92D20' }), 1716, 128, '0 50%');
    const nextTo = at(world, h('div', 'hand', 'next to each other', { fontSize: '34px', color: '#D92D20' }), 1500, 592, '0 50%');

    // ---------------- a real app: Wikipedia, learned the same way ----------------
    const WK = Object.assign({ steps: 27, tools: 10, checked: '10 / 10', names: [], lines: [] }, D.wiki || {});
    const wiki = h('div', null, null, { position: 'absolute', inset: '0', background: '#FAF9F6' });
    stage.appendChild(wiki);
    wiki.appendChild(h('div', 'grid'));
    const wPhone = makePhone(wiki, 200, 128, {});
    const wTitle = at(wiki, h('div', 'hand', 'Same steps, on a real app.', { fontSize: '60px' }), 720, 120);
    const wStats = at(wiki, h('div', null, [[WK.steps, 'agent steps'], [WK.tools, 'tools'], [WK.checked, 'checked live']].map(([v, k]) =>
      `<div><div class="tally-v" style="font-size:76px">${v}</div><div class="tally-k" style="margin-top:6px">${k}</div></div>`).join(''), { display: 'flex', gap: '72px' }), 726, 236);
    const wTools = at(wiki, h('div', null, WK.names.map((n) => `<span class="val" style="background:#fff;border-color:#C9C5BE;color:#3F3F46;font-size:16px;height:32px">${n}</span>`).join(''),
      { width: '1080px', display: 'flex', flexWrap: 'wrap', gap: '10px' }), 726, 430);
    const wAns = at(wiki, h('div', 'side', `<div class="k">Claude Code, with the Wikipedia tools</div>` + WK.lines.map((l) => `<div style="font:400 23px/1.5 var(--sans);color:#16161A;margin-top:8px">${esc(l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>')}</div>`).join(''),
      { width: '1080px' }), 726, 560);
    const wikiFrames = D.manual.frames ? Object.assign({}, D.manual.frames, { map: [[0, WK.frameAt || 0.6]], taps: [] }) : null;

    // ---------------- end card ----------------
    const end = h('div', null, null, { position: 'absolute', inset: '0', background: '#FAF9F6' });
    stage.appendChild(end);
    end.appendChild(h('div', 'grid', null, { opacity: '.6' }));
    const endMark = at(end, h('div', null, window.UNREMOTE_MARK || ''), 960 - 90, 250, '50% 50%');
    endMark.style.width = '180px'; endMark.style.height = '180px';
    const endName = at(end, h('div', 'end-name', 'Unremote'), 0, 470, '50% 50%'); endName.style.width = '1920px'; endName.style.textAlign = 'center';
    const endTag = at(end, h('div', 'end-tag', 'Any Android app → an MCP server.'), 0, 652, '50% 50%'); endTag.style.width = '1920px';
    const endSub = at(end, h('div', 'end-sub', 'Scanned once, by the agent itself.'), 0, 716, '50% 50%'); endSub.style.width = '1920px';
    const endFoot = at(end, h('div', null, '<span class="end-url">github.com/pulkitnagpal/unremote</span><span class="pill">Open source</span>', { display: 'flex', gap: '28px', alignItems: 'center', justifyContent: 'center', width: '1920px' }), 0, 840, '50% 50%');

    // ---------------- captions ----------------
    const CAPS = [
      [0.3, 4.6, 'Booking two movie tickets, by hand.'],
      [5.0, 9.6, `${D.manual.screens} screens. ${D.manual.taps} taps, counting every key.`],
      [10.2, 13.6, 'Under every tap, there’s an API call.'],
      [14.4, 18.6, '<code>unremote learn</code>: the agent explores the app by itself.'],
      [19.0, 23.6, 'A proxy captures every HTTPS call it makes.'],
      [24.0, 28.6, 'Unremote maps how each value flows to the next call.'],
      [29.2, 34.4, 'Claude turns the map into tools and an <b>MCP server</b>.'],
      [35.6, 39.2, 'Now just ask.'],
      [39.6, 45.0, 'Claude compares theatres, finds two seats together, holds them.'],
      [45.4, 51.9, 'It stops at the payment link. <b>You</b> pay.'],
      [53.0, 56.9, 'And on a real app: <b>Wikipedia</b>, learned the same way.'],
    ];
    const capBg = h('div', null, null, { position: 'absolute', left: '0', right: '0', bottom: '0', height: '230px', background: 'linear-gradient(rgba(250,249,246,0), #FAF9F6 42%)' });
    stage.appendChild(capBg);
    const capEls = CAPS.map(([, , html]) => { const e = h('div', 'cap', html); e.style.visibility = 'hidden'; stage.appendChild(e); return e; });
    let showCaptions = true;

    // ---------------- the timeline ----------------
    const T_A2B = 13.6, T_B2C = 34.8, T_WIKI = 52.6, T_END = 57.2;
    const DUR = 63.6;

    async function seek(t) {
      // ----- Act 1 -----
      const aOut = seg(t, T_A2B, T_A2B + 0.8);
      const phA = t < T_A2B + 1;
      put(A.phone.el, { o: phA ? 1 : 0, dx: lerp(0, -280, eio(aOut)), dy: lerp(0, 70, eio(aOut)), s: lerp(1, 0.86, eio(aOut)) });
      const xr = seg(t, 10.2, 10.8) * (1 - seg(t, T_A2B - 0.4, T_A2B));
      if (phA) await A.phone.show(Math.min(t, MAN_END + 3), ms, D.manual.frames, { xray: xr * 0.78 });
      const a1 = 1 - seg(t, 10.0, 10.5);
      put(title, { o: a1 });
      const MF = D.manual.frames;
      const tapsShown = MF ? MF.taps.filter((p) => t >= p.t).length : ms.filter((s) => s.tap && t >= s.t - 0.18).length;
      const tapsTotal = MF ? MF.taps.length : ms.filter((s) => s.tap).length;
      // the count runs to the real total; the stand-in script has fewer taps than a person makes, so scale it
      const tapsNow = Math.min(D.manual.taps, Math.round(tapsShown * D.manual.taps / Math.max(1, tapsTotal)));
      const manEnd = MF ? MF.map[MF.map.length - 1][0] : MAN_END;
      const tp = seg(t, 0.3, manEnd);
      [kTaps, vTaps, kScr, vScr, kTime, vTime].forEach((e) => put(e, { o: a1 }));
      vTaps.textContent = tapsNow;
      const screensNow = MF && MF.cuts ? MF.cuts.filter((c) => t >= c).length + 1 : Math.min(D.manual.screens, 1 + Math.floor(tp * D.manual.screens));
      vScr.textContent = Math.min(D.manual.screens, screensNow);
      vTime.textContent = fmtTime(MF ? Math.min(D.manual.seconds, Math.floor(mapT(MF.map, t) - MF.clock0)) : tp * D.manual.seconds);
      tallyMarks.forEach((m, i) => m.draw(i < tapsNow ? 1 : 0, a1));
      const crumbsNow = MF && MF.crumbs ? MF.crumbs.filter((c) => t >= c).length : Math.min(crumbs.length, Math.floor(tp * crumbs.length + 0.6));
      crumbEls.forEach((e, i) => { const u = i < crumbsNow ? 1 : 0; e.style.opacity = (u * a1).toFixed(3); });
      apiEls.forEach((e, i) => { const u = seg(t, 10.6 + i * 0.32, 11.0 + i * 0.32); put(e, { o: eo(u) * (1 - aOut), dx: lerp(-24, 0, eo(u)) }); });
      apiWires.forEach((w, i) => w.draw(seg(t, 10.5 + i * 0.32, 10.9 + i * 0.32), 1 - aOut));

      // ----- Act 2 -----
      const bIn = seg(t, T_A2B + 0.2, T_A2B + 1.0), bOut = seg(t, T_B2C - 0.5, T_B2C + 0.1);
      const bOn = t >= T_A2B && t < T_B2C + 0.6;
      const typed = 'unremote learn showtime';
      put(term, { o: bOn ? eo(bIn) * (1 - bOut) : 0, dy: lerp(-16, 0, eo(bIn)) });
      termCaret.style.opacity = t > 15.2 ? 0 : (Math.floor(t * 2.5) % 2 ? 1 : 0.2);
      // the agent's current step
      let cur = -1;
      for (let i = 0; i < D.actions.length; i++) if (t >= actT(i) - 0.3) cur = i;
      const tOff = t >= SCAN_END + 0.4;
      termAct.innerHTML = cur < 0 ? '<span style="color:#8E8A84">reading the store listing → 7 goals</span>' :
        tOff ? `<span style="color:#1FB57A">✓ ${D.actions.length} steps · 7 of 7 goals · ${D.stats.requests} requests</span>` :
          `<span style="color:#1FB57A">agent</span> <span style="color:#8E8A84">${String(cur + 1).padStart(2, '0')}/${D.actions.length}</span> ${esc(D.actions[cur][0])}`;
      const whyOp = cur >= 1 && !tOff ? win(t, actT(1) - 0.3, SCAN_END + 0.2, 0.3, 0.4) : 0;
      why.textContent = cur >= 0 ? D.actions[cur][2] : '';
      put(why, { o: whyOp * (1 - bOut) });
      put(goals, { o: win(t, 14.9, actT(1) + 0.2, 0.35, 0.4), dy: lerp(14, 0, eo(seg(t, 14.9, 15.4))), r: -1.2 });
      const phB = bOn && t >= T_A2B + 0.8;
      put(B.phone.el, { o: phB ? 1 - bOut : 0, dx: -280 + lerp(0, -140, eio(bOut)), dy: 70, s: 0.86 });
      if (phB) await B.phone.show(t, as, D.scan.frames, {});
      // endpoints appear when the agent's action calls them; the call travels from the phone to the card
      const tools01 = seg(t, 29.0, 29.8);
      const mapDim = 1 - 0.93 * eio(tools01);
      for (const k in EP) {
        const ta = actT(D.trig[k]) + 0.35;
        const u = seg(t, ta, ta + 0.4);
        put(epEl[k], { o: eo(u) * mapDim * (1 - bOut), s: lerp(0.92, 1, back(u)), dx: lerp(-30, 0, eo(u)) * 0 });
      }
      const live = Object.keys(EP).map((k) => actT(D.trig[k]) + 0.35).filter((ta) => t >= ta - 0.35 && t < ta).slice(0, 2);
      pings.forEach((p, i) => {
        const ta = live[i];
        if (ta == null || tools01 > 0) { put(p, { o: 0 }); return; }
        const k = Object.keys(EP).find((q) => actT(D.trig[q]) + 0.35 === ta);
        const u = eio((t - (ta - 0.35)) / 0.35), [, , , c, r] = EP[k];
        const from = [80 + 330, 560], to = [COLS[c] + 20, ROWS[r] + 42];
        p.style.left = lerp(from[0], to[0], u) + 'px'; p.style.top = (lerp(from[1], to[1], u) - Math.sin(u * Math.PI) * 60) + 'px';
        put(p, { o: 1 - seg(u, 0.85, 1) });
      });
      flows.forEach((f, i) => {
        const ta = actT(D.trig[f.to]) + 0.55;
        const u = seg(t, ta, ta + 0.55);
        f.arrow.draw(u, mapDim * (1 - bOut));
        f.chipEl.style.left = (f.c[0] - f.chipEl.offsetWidth / 2) + 'px'; f.chipEl.style.top = (f.c[1] - 15) + 'px';
        put(f.chipEl, { o: seg(u, 0.5, 0.9) * mapDim * (1 - bOut), s: lerp(0.7, 1, back(seg(u, 0.5, 1))) });
      });
      const pu = seg(t, actT(D.trig.checkout) + 0.9, actT(D.trig.checkout) + 1.4);
      payArrow.draw(pu, mapDim * (1 - bOut));
      put(payChip, { o: seg(pu, 0.6, 1) * mapDim * (1 - bOut), s: lerp(0.7, 1, back(seg(pu, 0.6, 1))) });
      strike.draw(seg(t, actT(4), actT(4) + 0.4), mapDim * (1 - bOut));
      const tk = seg(t, actT(D.trig.login) + 0.8, actT(D.trig.login) + 1.2);
      tokenArrow.draw(tk, mapDim * (1 - bOut)); put(tokenNote, { o: seg(tk, 0.5, 1) * mapDim * (1 - bOut) });
      const seen = Object.keys(EP).filter((k) => t >= actT(D.trig[k]) + 0.35).length;
      const reqs = Math.round(D.stats.requests * seg(t, actT(0), actT(D.actions.length - 1) + 0.4));
      stats.innerHTML = `<b>${reqs}</b> requests captured · <b>${seen}</b> endpoints · <b>1</b> login`;
      put(stats, { o: (t >= actT(0) ? 1 : 0) * eo(bIn) * mapDim * (1 - bOut) });
      put(tools, { o: eo(seg(t, 29.1, 29.6)) * (1 - bOut), dy: lerp(30, 0, eo(seg(t, 29.1, 29.7))) });
      toolRows.forEach((r, i) => { const u = seg(t, 29.5 + i * 0.3, 29.85 + i * 0.3); r.style.opacity = eo(u).toFixed(3); r.style.transform = `translateX(${lerp(-18, 0, eo(u)).toFixed(1)}px)`; });
      put(file, { o: eo(seg(t, 32.0, 32.4)) * (1 - bOut), dy: lerp(16, 0, eo(seg(t, 32.0, 32.5))) });

      // ----- Act 3 -----
      const cIn = seg(t, T_B2C - 0.05, T_B2C + 0.6);
      const cOn = t >= T_B2C;
      put(cc, { o: cOn ? eo(cIn) : 0, dx: lerp(60, 0, eo(cIn)) });
      const P0 = 35.9, P1 = 38.5;
      const np = Math.round(BK.prompt.length * seg(t, P0, P1));
      ccPrompt.textContent = BK.prompt.slice(0, np);
      ccCaret.style.display = t < P1 + 0.3 ? 'inline-block' : 'none';
      ccCaret.style.opacity = t > P0 && t < P1 ? 1 : (Math.floor(t * 2.5) % 2 ? 1 : 0.15);
      const C0 = 39.0, CS = 0.82;
      callEls.forEach((e, i) => {
        const u = seg(t, C0 + i * CS, C0 + i * CS + 0.2), r = seg(t, C0 + i * CS + 0.35, C0 + i * CS + 0.5);
        e.style.display = u > 0 ? 'block' : 'none';
        e.style.opacity = eo(u).toFixed(3);
        e.children[1].style.opacity = eo(r).toFixed(3);
      });
      const A0 = C0 + calls.length * CS + 0.3;
      const au = seg(t, A0, A0 + 2.6);
      ccAns.style.display = au > 0 ? 'block' : 'none';
      // the answer streams in word by word, and the transcript scrolls to keep its end in view
      if (au > 0) {
        const words = answer.split(' ');
        const n = Math.ceil(words.length * au);
        if (ansTxt._n !== n) { ansTxt._n = n; ansTxt.innerHTML = closeTags(words.slice(0, n).join(' ')); }
      } else ansTxt._n = 0;
      const over = Math.max(0, ccIn.offsetHeight - (ccBody.clientHeight - 44));
      ccIn.style.marginTop = (-over).toFixed(0) + 'px';
      const ansLink = au >= 1 ? ccAns.querySelector('u') : null;
      const ti = C0 + 2 * CS + 0.4, si = C0 + 3 * CS + 0.4, hi = C0 + 4 * CS + 0.4;
      put(sideTh, { o: cOn ? eo(seg(t, ti, ti + 0.35)) : 0, dy: lerp(16, 0, eo(seg(t, ti, ti + 0.4))) });
      put(sideSeats, { o: cOn ? eo(seg(t, si, si + 0.35)) : 0, dy: lerp(16, 0, eo(seg(t, si, si + 0.4))) });
      seatEls.forEach((e) => e.classList.toggle('g', t >= hi));
      put(sideTime, { o: cOn ? eo(seg(t, A0 + 2.0, A0 + 2.4)) : 0, dy: lerp(16, 0, eo(seg(t, A0 + 2.0, A0 + 2.5))) });
      if (!thLoop && cOn) {
        const th = offsetIn(sideTh.querySelector('.th'), world);
        thLoop = stroke(inkC, loopPts(th.x + th.w / 2, th.y + th.h / 2, th.w / 2 + 18, th.h / 2 + 10, 2), '#D92D20', 4);
        cheaper.style.left = (th.x + th.w - 90) + 'px'; cheaper.style.top = (th.y - 34) + 'px';
        seatLoop = stroke(inkC, loopPts(0, 0, 70, 30, 5), '#D92D20', 4);
      }
      if (!thLoop) { put(cheaper, { o: 0 }); put(nextTo, { o: 0 }); }
      if (thLoop) {
        thLoop.draw(seg(t, ti + 0.5, ti + 1.0), 1);
        put(cheaper, { o: seg(t, ti + 0.9, ti + 1.2) });
        const s0 = seatEls[0], s1 = seatEls[1];
        if (s0 && !seatLoop._placed) {
          const x0 = offsetIn(s0, world), x1 = offsetIn(s1, world);
          const cx = (x0.x + x1.x + x1.w) / 2, cy = x0.y + x0.h / 2;
          seatLoop.el.setAttribute('transform', `translate(${cx.toFixed(1)} ${cy.toFixed(1)})`);
          nextTo.style.left = (cx - 120) + 'px'; nextTo.style.top = (offsetIn(sideSeats, world).y + offsetIn(sideSeats, world).h + 6) + 'px';
          seatLoop._placed = true;
        }
        seatLoop.draw(seg(t, hi + 0.1, hi + 0.6), 1);
        put(nextTo, { o: seg(t, hi + 0.5, hi + 0.8), r: -3 });
      }
      // the payment link, circled, then the camera leans in
      const L0 = A0 + 2.8;
      let cam = { x: 0, y: 0, s: 1 };
      if (cOn && ansLink) {
        const r = offsetIn(ansLink, world);
        if (!linkLoop || linkLoop._k !== r.x + ',' + r.y) {
          if (linkLoop) linkLoop.el.remove();
          linkLoop = stroke(inkC, loopPts(r.x + r.w / 2, r.y + r.h / 2, r.w / 2 + 26, r.h / 2 + 16, 7), '#D92D20', 4.5);
          linkLoop._k = r.x + ',' + r.y; linkLoop._c = [r.x + r.w / 2, r.y + r.h / 2];
        }
        linkLoop.draw(seg(t, L0, L0 + 0.7), 1);
        const z = eio(seg(t, L0 + 0.6, L0 + 2.6));
        const [lx, ly] = linkLoop._c, S = lerp(1, 1.45, z);
        cam = { s: S, x: lerp(0, 960 - lx * S, z), y: lerp(0, 470 - ly * S, z) };
      } else if (linkLoop) { linkLoop.draw(0, 0); }
      capBg.style.opacity = clamp((cam.s - 1) / 0.15).toFixed(3);
      const camTf = `translate(${cam.x.toFixed(2)}px, ${cam.y.toFixed(2)}px) scale(${cam.s.toFixed(4)})`;
      if (world._tf !== camTf) { world.style.transform = camTf; world._tf = camTf; }

      // ----- Wikipedia -----
      const wk = seg(t, T_WIKI, T_WIKI + 0.5);
      wiki.style.visibility = wk > 0 && t < T_END + 0.7 ? 'visible' : 'hidden';
      wiki.style.opacity = eio(wk).toFixed(3);
      if (wk > 0) await wPhone.show(t, [{ t: 0, screen: 'login' }], wikiFrames, {});
      put(wPhone.el, { o: eo(seg(t, T_WIKI + 0.2, T_WIKI + 0.7)), dy: lerp(20, 0, eo(seg(t, T_WIKI + 0.2, T_WIKI + 0.8))) });
      [[wTitle, 0.4], [wStats, 0.8], [wTools, 1.2], [wAns, 1.8]].forEach(([e, d]) => put(e, { o: eo(seg(t, T_WIKI + d, T_WIKI + d + 0.45)), dy: lerp(16, 0, eo(seg(t, T_WIKI + d, T_WIKI + d + 0.5))) }));

      // ----- end card: a crossfade -----
      const e = seg(t, T_END, T_END + 0.6);
      end.style.visibility = e > 0 ? 'visible' : 'hidden';
      end.style.opacity = eio(e).toFixed(3);
      const E = T_END + 0.5;
      put(endMark, { o: eo(seg(t, E, E + 0.5)), s: lerp(0.6, 1, back(seg(t, E, E + 0.7))) });
      put(endName, { o: eo(seg(t, E + 0.25, E + 0.75)), dy: lerp(20, 0, eo(seg(t, E + 0.25, E + 0.85))) });
      put(endTag, { o: eo(seg(t, E + 0.8, E + 1.3)), dy: lerp(14, 0, eo(seg(t, E + 0.8, E + 1.4))) });
      put(endSub, { o: eo(seg(t, E + 1.3, E + 1.8)), dy: lerp(14, 0, eo(seg(t, E + 1.3, E + 1.9))) });
      put(endFoot, { o: eo(seg(t, E + 2.0, E + 2.5)), dy: lerp(14, 0, eo(seg(t, E + 2.0, E + 2.6))) });

      // ----- captions -----
      CAPS.forEach(([a, b], i) => { const u = showCaptions ? win(t, a, b, 0.25, 0.25) : 0; put(capEls[i], { o: u, dy: lerp(10, 0, eo(seg(t, a, a + 0.35))) }); });
    }
    function closeTags(s) { for (const tag of ['b', 'u']) { const open = (s.match(new RegExp('<' + tag + '>', 'g')) || []).length - (s.match(new RegExp('</' + tag + '>', 'g')) || []).length; s += ('</' + tag + '>').repeat(Math.max(0, open)); } return s; }
    function offsetIn(el, top) { let x = 0, y = 0, e = el; while (e && e !== top) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent; } return { x, y, w: el.offsetWidth, h: el.offsetHeight }; }

    return { seek, duration: DUR, stage, captions(on) { showCaptions = on; } };
  }

  window.UnremoteFilm = { mount, DEFAULTS };
})();
