// Steps dist/film/index.html frame by frame in headless Brave and pipes the frames to ffmpeg.
//   node film/render.mjs stills 0,12.5,40 [dir]     PNG stills (default dist/film/stills)
//   node film/render.mjs video out.mp4 [crf]         the film (FILM_FPS=30 for a quicker pass)
//   node film/render.mjs frames dir from to fps      PNG frames for the GIF
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withBrowser } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..');
const PAGE = pathToFileURL(join(ROOT, 'dist', 'film', 'index.html')).href;
const [mode, a1, a2, a3, a4] = process.argv.slice(2);

await withBrowser(async (open) => {
  const nocap = process.env.FILM_NOCAPTIONS ? '?nocap=1' : '';
  const tab = await open(PAGE + nocap, { width: 1920, height: 1080, scale: Number(process.env.FILM_SCALE || 1) });
  await tab.eval('window.ready');
  const seek = (t) => tab.eval(`film.seek(${t}).then(() => new Promise((r) => requestAnimationFrame(() => r(1))))`);
  if (mode === 'stills') {
    const dir = a2 || join(ROOT, 'dist', 'film', 'stills');
    mkdirSync(dir, { recursive: true });
    for (const t of a1.split(',').map(Number)) {
      await seek(t);
      const f = join(dir, process.env.FILM_NAME || `t${t.toFixed(2).padStart(5, '0')}.png`);
      writeFileSync(f, await tab.shot());
      console.log(f);
    }
  } else if (mode === 'frames') {
    const [dir, from, to, fps] = [a1, Number(a2), Number(a3), Number(a4)];
    mkdirSync(dir, { recursive: true });
    let i = 0;
    for (let t = from; t < to - 1e-6; t += 1 / fps) { await seek(t); writeFileSync(join(dir, String(++i).padStart(5, '0') + '.png'), await tab.shot()); }
    console.log(i, 'frames to', dir);
  } else if (mode === 'video') {
    const out = a1, crf = a2 || '18', fps = Number(process.env.FILM_FPS || 60);
    const dur = Number(process.env.FILM_DURATION || (await tab.eval('film.duration')));
    const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
      '-vf', 'scale=1920:1080:out_color_matrix=bt709:out_range=tv,format=yuv420p',
      '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', crf, '-tune', 'animation',
      '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', '-colorspace', 'bt709', '-color_primaries', 'bt709',
      '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', '-an', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    const n = Math.round(dur * fps), t0 = Date.now();
    for (let i = 0; i < n; i++) {
      await seek(i / fps);
      const buf = await tab.shot({ format: 'jpeg', quality: 96 });
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
      if (i % 300 === 0) console.error(`frame ${i}/${n}  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
    ff.stdin.end();
    await new Promise((r) => ff.on('close', r));
    console.log('wrote', out);
  }
});
