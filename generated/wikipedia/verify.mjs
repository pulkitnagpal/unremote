// Check the generated tools against the live API: every read tool is called with arguments the app really
// used, and its reply must have the same top-level shape the app saw. Write tools are never called here.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client, loadConfig } from './client.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig(dir);
const checks = JSON.parse(fs.readFileSync(path.join(dir, 'checks.json'), 'utf8'));
const client = new Client(cfg);
let ok = 0;
for (const c of checks) {
  const tool = cfg.tools.find(t => t.name === c.tool);
  const r = await client.call(tool, c.args);
  const keys = r.data && typeof r.data === 'object' ? Object.keys(r.data).sort() : [];
  const pass = r.status < 400 && c.expect_keys.every(k => keys.includes(k));
  if (pass) ok++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.tool.padEnd(22)} ${JSON.stringify(c.args)} → HTTP ${r.status}${pass ? '' : ' keys ' + keys.join(',')}`);
}
const writes = cfg.tools.filter(t => t.effect === 'write').map(t => t.name);
console.log(`${ok}/${checks.length} read tools verified; not called (change state): ${writes.join(', ') || 'none'}`);
process.exit(ok === checks.length ? 0 : 1);
