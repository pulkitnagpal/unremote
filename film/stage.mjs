// Gathers what the film draws from into dist/film: the stage (film.html/js/css + fonts), data.js with the real values,
// and the phone recordings from media/raw as image sequences when they are there. Re-run after new captures arrive.
//   node film/stage.mjs
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markBody } from './logo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..');
const OUT = join(ROOT, 'dist', 'film'), RAW = join(ROOT, 'media', 'raw');
mkdirSync(OUT, { recursive: true });
for (const f of ['film.html', 'film.js', 'film.css']) cpSync(join(HERE, f), join(OUT, f === 'film.html' ? 'index.html' : f));
cpSync(join(HERE, 'fonts'), join(OUT, 'fonts'), { recursive: true });

const data = {};
// the latest ShowTime run: actions, triggers, tools
const runs = readdirSync(join(ROOT, 'runs')).filter((d) => d.startsWith('showtime-')).sort();
const run = runs.reverse().find((d) => existsSync(join(ROOT, 'runs', d, 'tools.json')) && existsSync(join(ROOT, 'runs', d, 'actions.jsonl')));
if (run) {
  const dir = join(ROOT, 'runs', run);
  const acts = readFileSync(join(dir, 'actions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const tidy = (a) => a.replace(/\s+\(UA, \d+ min\)/, '').replace(/\s{2,}/g, ' ');
  const shortWhy = (w) => (w || '').split(/(?<=[.!])\s/)[0].replace(/ goal \d( is done| is confirmed)?/g, '');
  data.actions = acts.map((a, i) => [tidy(a.action), a.screen, i ? shortWhy(a.why) : 'Opening ShowTime for the first time.']);
  const map = JSON.parse(readFileSync(join(dir, 'api_map.json'), 'utf8'));
  const key = { 'GET /v2/config': 'config', 'POST /collect': 'collect', 'POST /v2/auth/login': 'login', 'GET /v2/cities': 'cities', 'GET /v2/movies': 'movies',
    'GET /v2/movies/{movie_id}/shows': 'shows', 'GET /v2/shows/{show_id}/seatmap': 'seatmap', 'POST /v2/shows/{show_id}/hold': 'hold',
    'POST /v2/holds/{hold_id}/checkout': 'checkout', 'GET /v2/me/bookings': 'bookings' };
  data.trig = {};
  for (const [ep, e] of Object.entries(map.endpoints)) {
    if (!key[ep]) continue;
    const tr = e.triggers?.[0];
    const idx = tr ? acts.findIndex((a) => a.action === tr.action && a.screen === tr.screen) : 0;
    data.trig[key[ep]] = Math.max(0, idx);
  }
  data.stats = { requests: map.stats?.flows ?? 21, endpoints: Object.keys(map.endpoints).length };
  console.log('run', run, 'triggers', JSON.stringify(data.trig));
}

// real recordings: media/raw/<name>.mp4 → dist/film/frames/<name>/00001.jpg at 30 fps, 540 px wide
function frames(name) {
  const src = join(RAW, name + '.mp4');
  if (!existsSync(src)) return null;
  const dir = join(OUT, 'frames', name), stamp = join(dir, '.src');
  const st = String(readFileSync(src).length);
  if (!(existsSync(stamp) && readFileSync(stamp, 'utf8') === st)) {
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-i', src, '-vf', 'fps=30,scale=540:-2:flags=lanczos', '-q:v', '3', join(dir, '%05d.jpg')]);
    writeFileSync(stamp, st);
  }
  const count = readdirSync(dir).filter((f) => f.endsWith('.jpg')).length;
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src], { encoding: 'utf8' }));
  console.log(name, count, 'frames,', dur.toFixed(1), 's');
  return { dir: `frames/${name}`, count, fps: 30, ext: 'jpg', duration: dur };
}
const timing = existsSync(join(HERE, 'timing.json')) ? JSON.parse(readFileSync(join(HERE, 'timing.json'), 'utf8')) : {};
// video time → scene time, through a rising map of [sceneT, videoT] knots
const toScene = (map, v) => {
  for (let i = 0; i < map.length - 1; i++) {
    const [a, va] = map[i], [b, vb] = map[i + 1];
    if (v >= va && v <= vb && vb > va) return a + (b - a) * (v - va) / (vb - va);
  }
  return v < map[0][1] ? map[0][0] : map[map.length - 1][0];
};
const man = frames('manual-booking');
if (man && timing.manual) {
  const tm = timing.manual;
  const taps = tm.videoTaps.map(([v, x, y]) => ({ t: +toScene(tm.map, v).toFixed(3), x, y }));
  data.manual = { frames: { ...man, map: tm.map, taps, cuts: tm.videoCuts.map((v) => +toScene(tm.map, v).toFixed(3)), crumbs: (tm.videoCrumbs ?? []).map((v) => +toScene(tm.map, v).toFixed(3)), clock0: tm.clock0 },
    taps: taps.length, screens: tm.screens, seconds: Math.round(tm.map[tm.map.length - 1][1] - tm.clock0) };
}
const scan = frames('agent-scan');
if (scan && timing.scan) data.scan = { frames: { ...scan, map: timing.scan.map, taps: timing.scan.taps } };
if (timing.booking) data.booking = timing.booking;
// Claude Code's real reply (media/raw/claude-booking.txt), without the app name line and the timing line
const reply = join(RAW, 'claude-booking.txt');
if (existsSync(reply)) {
  const lines = readFileSync(reply, 'utf8').trim().split('\n').filter((l, i) => !(i === 0 && /^\w+$/.test(l)) && !/^took \d+s$/.test(l));
  (data.booking ??= {}).reply = lines;
}
// the second, real app: Wikipedia (the latest learn run, and Claude's reply in media/raw/claude-wikipedia.txt)
const wruns = readdirSync(join(ROOT, 'runs')).filter((d) => d.startsWith('wikipedia-')).sort().reverse();
const wrun = wruns.find((d) => existsSync(join(ROOT, 'runs', d, 'tools.json')));
const wreply = join(RAW, 'claude-wikipedia.txt');
if (wrun && existsSync(wreply)) {
  const dir = join(ROOT, 'runs', wrun);
  const steps = readFileSync(join(dir, 'actions.jsonl'), 'utf8').trim().split('\n').length - 1;
  const names = JSON.parse(readFileSync(join(dir, 'tools.json'), 'utf8')).tools.map((x) => x.name);
  const lines = readFileSync(wreply, 'utf8').split('\n').filter((l) => /featured article|Hindi Wikipedia/.test(l));
  data.wiki = { steps, tools: names.length, checked: `${names.length} / ${names.length}`, names, lines };
  console.log('wikipedia', wrun, steps, 'steps,', names.length, 'tools');
}
const toolsFile = join(RAW, 'showtime-tools.json');
if (existsSync(toolsFile)) {
  const t = JSON.parse(readFileSync(toolsFile, 'utf8'));
  data.toolEffects = Object.fromEntries((t.tools ?? t).map((x) => [x.name, x.effect]));
}
writeFileSync(join(OUT, 'data.js'), `window.UNREMOTE_MARK = ${JSON.stringify(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="180" height="180">${markBody()}</svg>`)};\nwindow.UNREMOTE_DATA = ${JSON.stringify(data, null, 1)};\n`);
console.log('staged', OUT);
