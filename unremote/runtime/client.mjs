// Runtime client shared by every generated server: replays the app's private API the way the app does.
// Handles the login, token refresh on 401, and the constant headers the app always sends.
import fs from 'node:fs';
import path from 'node:path';

const pick = (obj, p) => (p || '$').replace(/^\$\.?/, '').split('.').filter(Boolean).reduce((o, k) => (o == null ? o : o[k]), obj);
const split = ep => { const i = ep.indexOf(' '); return [ep.slice(0, i), ep.slice(i + 1)]; };

export function loadConfig(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'unremote.config.json'), 'utf8'));
}

export class Client {
  constructor(cfg, env = process.env) {
    this.cfg = cfg;
    this.env = env;
    this.token = null;
    this.refreshToken = null;
  }

  async raw(method, url, body, withAuth = true) {
    // Identify honestly: many APIs (Wikimedia's included) ask clients to name themselves.
    const headers = { 'user-agent': 'unremote/0.1 (+https://github.com/pulkitnagpal/unremote)', ...this.cfg.headers, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (withAuth && this.token) headers[this.cfg.auth?.header || 'authorization'] = 'Bearer ' + this.token;
    // Endpoints on the app's other API hosts carry their full origin.
    const target = /^https?:\/\//.test(url) ? url : this.cfg.base_url + url;
    const send = () => fetch(target, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let res = await send();
    if (res.status === 429) {  // rate limited: wait as asked (at most 5 s), then try once more
      const wait = Math.min(5, +(res.headers.get('retry-after') || 2));
      await new Promise(r => setTimeout(r, wait * 1000));
      res = await send();
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data };
  }

  async login() {
    const a = this.cfg.auth;
    if (!a) throw new Error('This app has no login');
    const body = {};
    for (const [field, envVar] of Object.entries(a.login.fields)) {
      if (!this.env[envVar]) throw new Error(`Set ${envVar} to log in`);
      body[field] = this.env[envVar];
    }
    const [m, p] = split(a.login.endpoint);
    const r = await this.raw(m, p, body, false);
    if (r.status >= 400) throw new Error(`Login failed (${r.status})`);
    this.token = pick(r.data, a.token_path);
    this.refreshToken = pick(r.data, a.refresh_token_path);
  }

  async refresh() {
    const a = this.cfg.auth;
    if (!a?.refresh || !this.refreshToken) return this.login();
    const [m, p] = split(a.refresh.endpoint);
    const r = await this.raw(m, p, { [a.refresh.field]: this.refreshToken }, false);
    if (r.status >= 400) return this.login();
    this.token = pick(r.data, a.token_path);
    this.refreshToken = pick(r.data, a.refresh_token_path) || this.refreshToken;
  }

  /** Call one generated tool with the agent's arguments. */
  async call(tool, args = {}) {
    const [method, full] = split(tool.endpoint);
    let [url, mode] = full.split('?');
    const query = new URLSearchParams();
    // Fixed query values select the operation (e.g. action=query&list=search); the agent never sets them.
    for (const [k, v] of Object.entries(tool.fixed || {})) query.set(k, String(v));
    for (const kv of (mode || '').split('&').filter(s => s.includes('='))) { const [k, v] = kv.split('='); query.set(k, v); }
    let body;
    for (const inp of tool.inputs || []) {
      const v = args[inp.name];
      if (v === undefined || v === null) continue;
      if (inp.in === 'path') url = url.replace(`{${inp.field}}`, encodeURIComponent(String(v)));
      else if (inp.in === 'query') query.set(inp.field, String(v));
      else (body ??= {})[inp.field] = v;
    }
    if (query.size) url += '?' + query;
    let r = await this.raw(method, url, body);
    if (r.status === 401 && this.cfg.auth) {
      await (this.token ? this.refresh() : this.login());
      r = await this.raw(method, url, body);
    }
    return r;
  }
}
