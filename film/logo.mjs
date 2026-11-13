// Writes the Unremote logo files to docs/img: logo.svg / logo.png (mark + wordmark), logo-mark.svg / logo-mark.png (square).
//   node film/logo.mjs
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import opentype from 'opentype.js';
import { withBrowser } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'docs', 'img');
export const INK = '#16161A', GREEN = '#1FB57A', PAPER = '#FFFFFF';

/** The mark in a 512 box: an ink tile, a phone outline, and the app's insides (a chain of values) leaving through its side. */
export function markBody() {
  return `<rect width="512" height="512" rx="118" fill="${INK}"/>
<mask id="cut"><rect width="512" height="512" fill="#fff"/><rect x="286" y="226" width="36" height="60" fill="#000"/></mask>
<g mask="url(#cut)" fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round">
  <rect x="120" y="96" width="184" height="320" rx="44" stroke-width="24"/>
  <path d="M184 372h56" stroke-width="16"/>
</g>
<g fill="none" stroke="${GREEN}" stroke-linecap="round" stroke-linejoin="round" stroke-width="24">
  <path d="M176 176 C 176 226, 196 256, 236 256 H 352"/>
</g>
<circle cx="176" cy="168" r="22" fill="${GREEN}"/>
<circle cx="382" cy="256" r="40" fill="${GREEN}"/>
<circle cx="382" cy="256" r="14" fill="${INK}"/>`;
}
const markSvg = (size = 512) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}"><title>Unremote</title>${markBody()}</svg>`;

function wordmark() {
  const font = opentype.loadSync(join(HERE, 'fonts', 'Inter-700.ttf'));
  const size = 168, tracking = -0.025 * size;
  let x = 0; const parts = [];
  const glyphs = font.stringToGlyphs('Unremote');
  glyphs.forEach((g, i) => {
    parts.push(g.getPath(x, 0, size).toPathData(2));
    x += g.advanceWidth * size / font.unitsPerEm + tracking;
    if (i < glyphs.length - 1) x += font.getKerningValue(g, glyphs[i + 1]) * size / font.unitsPerEm;
  });
  return { d: parts.join(''), width: x - tracking, capH: font.tables.os2.sCapHeight * size / font.unitsPerEm };
}

export function logoSvg() {
  const w = wordmark();
  const H = 248, mark = 200, gap = 56, pad = 24;
  const W = Math.ceil(pad + mark + gap + w.width + pad);
  const baseline = H / 2 + w.capH / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><title>Unremote</title>
<g transform="translate(${pad} ${(H - mark) / 2}) scale(${mark / 512})">${markBody()}</g>
<path fill="${INK}" transform="translate(${pad + mark + gap} ${baseline.toFixed(2)})" d="${w.d}"/></svg>`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const logo = logoSvg();
  writeFileSync(join(OUT, 'logo.svg'), logo + '\n');
  writeFileSync(join(OUT, 'logo-mark.svg'), markSvg() + '\n');
  const [, W, H] = logo.match(/viewBox="0 0 (\d+) (\d+)"/).map(Number);
  await withBrowser(async (open) => {
    const shot = async (file, w, h, scale) => {
      const tab = await open(pathToFileURL(join(OUT, file)).href, { width: w, height: h, scale, transparent: true });
      return tab.shot();
    };
    writeFileSync(join(OUT, 'logo.png'), await shot('logo.svg', W, H, 2));
    writeFileSync(join(OUT, 'logo-mark.png'), await shot('logo-mark.svg', 512, 512, 2));
  });
  console.log('wrote docs/img/logo.svg, logo.png, logo-mark.svg, logo-mark.png');
}
