// Builds the design boards: six key frames of the film, each a live stage frozen at its moment.
//   node film/boards.mjs     → dist/boards/index.html (one self-contained page, for the Artifact)
//                             → media/boards/NN-name.png (1920×1080 renders of the same frames)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withBrowser } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..');
const FILM = join(ROOT, 'dist', 'film');
export const BOARDS = [
  { t: 7.6, slug: 'by-hand', title: 'By hand', at: '0:00 – 0:13',
    note: 'The real ShowTime recording, sped up. A tally counts every tap, keys included: 43 taps over 9 screens. Then the screen fades and the API calls under those taps show through.' },
  { t: 20.6, slug: 'agent-scans', title: 'The agent explores', at: '0:14 – 0:28',
    note: '<code>unremote learn showtime</code>. The goals come from the store listing; the agent’s own reason for each step is written above the phone. Green rings are the agent’s taps, on the real recording.' },
  { t: 28.4, slug: 'api-map', title: 'The API map', at: '0:17 – 0:29',
    note: 'Each endpoint lands when the tap that called it happens. The green chips are values flowing on: city_id → movie_id → show_id → hold_id → payment_url. Telemetry is struck out.' },
  { t: 33.6, slug: 'tools', title: 'Tools and the MCP server', at: '0:29 – 0:35',
    note: 'The map fades behind the 7 tools Claude designed from it. Two change state and are marked write. Then the generated server file.' },
  { t: 46.9, slug: 'claude-books', title: 'Just ask', at: '0:35 – 0:52',
    note: 'One sentence to Claude Code, then the real reply. Beside it, the cheaper theatre and seats C4–C5 are circled. It stops at the payment link, which gets circled before the camera leans in.' },
  { t: 56.6, slug: 'wikipedia', title: 'A real app', at: '0:53 – 0:57',
    note: 'The same learn run on the real Wikipedia app: 27 agent steps, 10 tools, each checked against the live API. Beside the app, Claude\u2019s own answers from those tools, word for word.' },
  { t: 62.0, slug: 'end-card', title: 'End card', at: '0:57 – 1:04',
    note: 'Name, tagline, the repo and “Open source”, held for three seconds.' },
];

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = join(ROOT, 'dist', 'boards'), pngDir = join(ROOT, 'media', 'boards');
  mkdirSync(outDir, { recursive: true }); mkdirSync(pngDir, { recursive: true });
  // which footage frames each board shows, so they can be embedded
  const used = new Set();
  await withBrowser(async (open) => {
    const tab = await open(pathToFileURL(join(FILM, 'index.html')).href + '?nocap=1', { width: 1920, height: 1080 });
    await tab.eval('window.ready');
    for (const [i, b] of BOARDS.entries()) {
      await tab.eval(`film.captions(true); film.seek(${b.t})`);
      for (const s of await tab.eval(`[...document.querySelectorAll('.screen img')].filter((i) => i.style.display !== 'none' && i.closest('.phone').style.visibility !== 'hidden').map((i) => i.getAttribute('src'))`)) used.add(s);
      writeFileSync(join(pngDir, `${String(i + 1).padStart(2, '0')}-${b.slug}.png`), await tab.shot());
    }
  });
  const uris = {};
  for (const s of used) if (!s.startsWith('data:')) uris[s] = 'data:image/jpeg;base64,' + readFileSync(join(FILM, s)).toString('base64');
  const css = readFileSync(join(HERE, 'film.css'), 'utf8'), js = readFileSync(join(HERE, 'film.js'), 'utf8');
  const data = readFileSync(join(FILM, 'data.js'), 'utf8');
  const logo = readFileSync(join(ROOT, 'docs', 'img', 'logo.svg'), 'utf8').replace(/<title>.*?<\/title>/, '');
  const tpl = readFileSync(join(HERE, 'boards.html'), 'utf8');
  const html = tpl
    .replace('/*FILM_CSS*/', () => css)
    .replace('<!--LOGO-->', () => logo.replace('<svg ', '<svg class="logo" role="img" aria-label="Unremote" '))
    .replace('/*FILM_DATA*/', () => data + `\nwindow.UNREMOTE_FRAME_URI = ${JSON.stringify(uris)};`)
    .replace('/*FILM_JS*/', () => js)
    .replace('/*BOARDS*/', () => JSON.stringify(BOARDS));
  writeFileSync(join(outDir, 'index.html'), html);
  console.log('wrote dist/boards/index.html', (html.length / 1e6).toFixed(2), 'MB; frames', [...used].join(', '));
  console.log('wrote media/boards/*.png');
}
