// A small Chrome DevTools client for headless Brave (adapted from Storydiff's scripts/video/cdp.ts).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BROWSERS = [
  process.env.UNREMOTE_CHROME,
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function withBrowser(fn) {
  const bin = BROWSERS.find((p) => existsSync(p));
  if (!bin) throw new Error('No Chromium browser found. Set UNREMOTE_CHROME.');
  const profile = mkdtempSync(join(tmpdir(), 'unremote-film-'));
  const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--allow-file-access-from-files', '--force-color-profile=srgb', '--font-render-hinting=none',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 150 && !existsSync(portFile); i++) await sleep(100);
    if (!existsSync(portFile)) throw new Error('the browser did not start');
    await sleep(150);
    const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
    const open = async (url, o) => {
      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      let id = 0;
      const wait = new Map();
      const events = [];
      ws.onmessage = (m) => {
        const d = JSON.parse(String(m.data));
        if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } else if (d.method) events.push(d.method);
      };
      const send = (method, params = {}) => new Promise((res, rej) => {
        const k = ++id;
        wait.set(k, (d) => (d.error ? rej(new Error(`${method}: ${d.error.message}`)) : res(d.result)));
        ws.send(JSON.stringify({ id: k, method, params }));
      });
      const scale = o.scale ?? 1;
      const resize = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
      await send('Page.enable');
      await resize(o.width, o.height);
      if (o.transparent) await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
      await send('Page.navigate', { url });
      for (let i = 0; i < 150 && !events.includes('Page.loadEventFired'); i++) await sleep(100);
      await send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => 1)', awaitPromise: true, returnByValue: true });
      await sleep(300);
      return {
        send, resize,
        async eval(expr) {
          const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
          if (r.exceptionDetails) throw new Error('page script: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
          return r.result.value;
        },
        async shot(opts = {}) {
          const r = await send('Page.captureScreenshot', { format: opts.format ?? 'png', ...(opts.quality ? { quality: opts.quality } : {}),
            optimizeForSpeed: !!opts.fast, ...(opts.clip ? { clip: { ...opts.clip, scale: 1 } } : {}) });
          return Buffer.from(r.data, 'base64');
        },
      };
    };
    return await fn(open);
  } finally {
    try { proc.kill(); } catch { /* gone */ }
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500).unref();
  }
}
