import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectLocal } from './discover.js';
import { addSecrets, SECRET_KEY } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = process.env.FS_MCP_CONFIG || path.join(ROOT, 'mcp.json');
const CACHE_FILE = process.env.FS_MCP_CACHE || path.join(os.homedir(), '.fs_mcp_cache.json');
const TTL = 24 * 3600 * 1000;
const DEFAULT_TIMEOUT = 60000;

let config = {};
let autoApprove = {};
let cache = {};
let cacheLoaded = false;
export const activeClients = new Map();
const pending = new Map();
export const origins = {}; // nom -> source de détection (absent = mcp.json)
export let ownConfig = {};
export const getAutoApprove = () => autoApprove;

// ---------- Configuration ----------
function readConfigFile() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`mcp.json illisible: ${e.message}`);
  }
}
const writeConfigFile = (o) => fs.writeFileSync(CONFIG_FILE, JSON.stringify(o, null, 2));

function collectSecrets() {
  const s = [];
  for (const c of Object.values(config)) {
    if (c.token) s.push(c.token);
    for (const v of Object.values(c.headers || {})) s.push(String(v).replace(/^Bearer\s+/i, ''));
    for (const [k, v] of Object.entries(c.env || {})) if (SECRET_KEY.test(k)) s.push(String(v));
  }
  addSecrets(s);
}

export function loadConfig() {
  for (const k of Object.keys(origins)) delete origins[k];
  let file;
  try { file = readConfigFile(); } catch (e) { config = ownConfig = {}; autoApprove = {}; throw e; }
  ownConfig = file.mcpServers || {};
  autoApprove = file.autoApprove || {};
  config = { ...ownConfig };
  if (file.autoDetect !== false) {
    const d = detectLocal();
    for (const [n, c] of Object.entries(d.servers)) if (!config[n]) { config[n] = c; origins[n] = d.origin[n]; }
  }
  collectSecrets();
  return config;
}

export const serverNames = () => Object.keys(config);
const cfgHash = (n) => crypto.createHash('sha1').update(JSON.stringify(config[n])).digest('hex');

export function importServer(name) {
  if (!config[name]) throw new Error(`Serveur inconnu: ${name}`);
  const file = readConfigFile();
  file.mcpServers = { ...(file.mcpServers || {}), [name]: config[name] };
  writeConfigFile(file);
  delete origins[name];
}

export function addServer(name, cfg) {
  const file = readConfigFile();
  file.mcpServers = { ...(file.mcpServers || {}), [name]: cfg };
  writeConfigFile(file);
  drop(name);
  loadConfig();
}

export function removeServer(name) {
  const file = readConfigFile();
  if (!file.mcpServers?.[name]) throw new Error(origins[name] ? `"${name}" vient de ${origins[name]}, pas de mcp.json` : `Serveur inconnu: ${name}`);
  delete file.mcpServers[name];
  writeConfigFile(file);
  drop(name);
  readCache();
  delete cache[name];
  writeCache();
  loadConfig();
}

export function addAutoApprove(server, pattern) {
  const file = readConfigFile();
  file.autoApprove = file.autoApprove || {};
  file.autoApprove[server] = [...new Set([...(file.autoApprove[server] || []), pattern])];
  writeConfigFile(file);
  autoApprove = file.autoApprove;
}

// ---------- Cache disque ----------
function readCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; }
}
const writeCache = () => { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch { /* non bloquant */ } };
export function clearCache() { cache = {}; cacheLoaded = true; try { fs.unlinkSync(CACHE_FILE); } catch { /* absent */ } }

const transportError = (m) => Object.assign(new Error(m), { transport: true });
const abortError = () => Object.assign(new Error('Interrompu'), { name: 'AbortError' });

// ---------- Utilitaire SSE ----------
async function readSSE(body, onEvent) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      let event = 'message'; const data = [];
      for (const l of raw.split('\n')) {
        if (l.startsWith('event:')) event = l.slice(6).trim();
        else if (l.startsWith('data:')) data.push(l.slice(5).replace(/^ /, ''));
      }
      if (data.length && onEvent(event, data.join('\n')) === false) return;
    }
  }
}

// ---------- Clients ----------
class Base {
  constructor() { this.id = 0; this.waiting = new Map(); this.closed = false; this.timeout = DEFAULT_TIMEOUT; }

  /** Requête JSON-RPC ; `signal` permet d'annuler (notifications/cancelled envoyé au serveur). */
  request(method, params, signal) {
    if (!signal) return this._request(method, params);
    if (signal.aborted) return Promise.reject(abortError());
    const p = this._request(method, params);
    const id = this.id;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.waiting.delete(id);
        this.notify('notifications/cancelled', { requestId: id, reason: 'Interrompu par l\'utilisateur' });
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  _request(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting.delete(id); reject(new Error(`Timeout MCP (${method})`)); }, this.timeout);
      this.waiting.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.send({ jsonrpc: '2.0', id, method, params }).catch((e) => { clearTimeout(t); this.waiting.delete(id); reject(e); });
    });
  }

  notify(method, params) { return this.send({ jsonrpc: '2.0', method, params }).catch(() => {}); }

  dispatch(msg) {
    if (msg.method && msg.id !== undefined) { // requête serveur→client : on répond pour ne pas bloquer le serveur
      const reply = msg.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Method not found' } };
      this.send({ jsonrpc: '2.0', id: msg.id, ...reply }).catch(() => {});
      return;
    }
    const w = this.waiting.get(msg.id);
    if (!w) return;
    this.waiting.delete(msg.id);
    msg.error ? w.reject(new Error(`MCP ${msg.error.code}: ${msg.error.message}`)) : w.resolve(msg.result);
  }

  fail(err) {
    const wasClosed = this.closed;
    this.closed = true;
    for (const w of this.waiting.values()) w.reject(err);
    this.waiting.clear();
    if (!wasClosed) this.onExit?.(err);
  }
}

const quoteArg = (a) => (/[\s&|<>^"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a);

class StdioClient extends Base {
  constructor(c) {
    super();
    const win = process.platform === 'win32';
    this.p = spawn(win ? [c.command, ...(c.args || [])].map(quoteArg).join(' ') : c.command, win ? [] : c.args || [], {
      env: { ...process.env, ...(c.env || {}) }, stdio: ['pipe', 'pipe', 'ignore'], shell: win,
    });
    let buf = '';
    this.p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line) try { this.dispatch(JSON.parse(line)); } catch { /* sortie non JSON */ }
      }
    });
    this.p.on('error', (e) => this.fail(transportError(`Lancement impossible: ${e.message}`)));
    this.p.on('exit', (code) => this.fail(transportError(`Processus MCP terminé (code ${code})`)));
    this.p.stdin.on('error', () => {});
  }
  async send(m) {
    if (this.closed) throw transportError('Connexion fermée');
    this.p.stdin.write(JSON.stringify(m) + '\n');
  }
  close() {
    this.closed = true;
    try { this.p.stdin?.destroy(); this.p.stdout?.destroy(); } catch { /* ignore */ }
    try {
      // Sous Windows (shell: true) kill() ne tue que cmd.exe : on termine tout l'arbre de processus.
      if (process.platform === 'win32' && this.p.pid) spawnSync('taskkill', ['/pid', String(this.p.pid), '/T', '/F'], { stdio: 'ignore' });
      else this.p.kill();
    } catch { /* déjà mort */ }
  }
}

const authHeaders = (c) => ({ ...(c.headers || {}), ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}) });

class HttpClient extends Base {
  constructor(c) { super(); this.c = c; this.session = null; }
  async send(m) {
    if (this.closed) throw transportError('Connexion fermée');
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...authHeaders(this.c) };
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    let res;
    try { res = await fetch(this.c.url, { method: 'POST', headers, body: JSON.stringify(m) }); }
    catch (e) { throw transportError(`Réseau: ${e.message}`); }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (res.status === 404 && this.session) throw transportError('Session MCP expirée');
    if (!res.ok) throw transportError(`HTTP ${res.status}`);
    if (m.id === undefined) return;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
      readSSE(res.body, (_e, d) => { try { const j = JSON.parse(d); this.dispatch(j); return j.id !== m.id; } catch { /* ignore */ } })
        .catch((e) => this.fail(transportError(e.message)));
    } else this.dispatch(await res.json());
  }
  close() {
    this.closed = true;
    if (this.session) fetch(this.c.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': this.session, ...authHeaders(this.c) } }).catch(() => {});
  }
}

class SseClient extends Base {
  constructor(c) { super(); this.c = c; this.ac = new AbortController(); }
  async open() {
    let res;
    try { res = await fetch(this.c.url, { headers: { Accept: 'text/event-stream', ...authHeaders(this.c) }, signal: this.ac.signal }); }
    catch (e) { throw transportError(`Réseau: ${e.message}`); }
    if (!res.ok) throw transportError(`HTTP ${res.status}`);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(transportError('Pas d\'événement endpoint')), DEFAULT_TIMEOUT);
      readSSE(res.body, (ev, d) => {
        if (ev === 'endpoint') { this.post = new URL(d, this.c.url).href; clearTimeout(t); resolve(); }
        else try { this.dispatch(JSON.parse(d)); } catch { /* ignore */ }
      }).then(() => this.fail(transportError('Flux SSE fermé'))).catch((e) => { clearTimeout(t); reject(transportError(e.message)); this.fail(transportError(e.message)); });
    });
  }
  async send(m) {
    if (this.closed) throw transportError('Connexion fermée');
    let res;
    try { res = await fetch(this.post, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders(this.c) }, body: JSON.stringify(m) }); }
    catch (e) { throw transportError(`Réseau: ${e.message}`); }
    if (!res.ok) throw transportError(`HTTP ${res.status}`);
  }
  close() { this.closed = true; this.ac.abort(); }
}

// ---------- Pool ----------
async function create(name) {
  const c = config[name];
  if (!c) throw new Error(`Serveur inconnu: ${name}`);
  let client;
  if (!c.url) {
    if (!c.command) throw new Error(`"${name}": command ou url requis`);
    client = new StdioClient(c);
  } else if (c.type === 'sse') { client = new SseClient(c); client.timeout = c.timeout || DEFAULT_TIMEOUT; await client.open(); }
  else client = new HttpClient(c);
  client.timeout = c.timeout || DEFAULT_TIMEOUT;
  try {
    await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fs-mcp-cli', version: '1.1.0' } });
    await client.notify('notifications/initialized');
  } catch (e) { client.intentional = true; client.close(); throw e; }
  return client;
}

const restarts = new Map();

/** Redémarrage automatique (3 essais max par minute) d'un serveur actif qui s'arrête sans qu'on l'ait demandé. */
function respawn(name, client) {
  if (client.intentional || activeClients.get(name) !== client) return;
  activeClients.delete(name);
  const r = restarts.get(name) || { n: 0, at: 0 };
  if (Date.now() - r.at > 60000) r.n = 0;
  if (r.n >= 3) return;
  r.n++; r.at = Date.now();
  restarts.set(name, r);
  setTimeout(() => connect(name).catch(() => {}), 1000 * r.n).unref?.();
}

export function connect(name) {
  const a = activeClients.get(name);
  if (a && !a.closed) return Promise.resolve(a);
  if (pending.has(name)) return pending.get(name);
  const p = create(name)
    .then((c) => { c.onExit = () => respawn(name, c); activeClients.set(name, c); return c; })
    .finally(() => pending.delete(name));
  pending.set(name, p);
  return p;
}

function drop(name) {
  const c = activeClients.get(name);
  if (c) { c.intentional = true; c.close(); }
  activeClients.delete(name);
}

/** Exécute fn(client) ; en cas d'erreur de transport, reconnecte et réessaie une fois. */
async function withClient(name, fn) {
  try { return await fn(await connect(name)); } catch (e) {
    if (e.name === 'AbortError' || (!e.transport && !activeClients.get(name)?.closed)) throw e;
    drop(name);
    return fn(await connect(name));
  }
}

async function paged(name, method, key) {
  return withClient(name, async (c) => {
    const all = [];
    let cursor;
    do {
      const r = await c.request(method, cursor ? { cursor } : {});
      all.push(...(r[key] || []));
      cursor = r.nextCursor;
    } while (cursor);
    return all;
  });
}

// ---------- API publique ----------
export async function listTools(name, { fresh = false } = {}) {
  readCache();
  const e = cache[name];
  if (!fresh && e && e.hash === cfgHash(name) && Date.now() - e.at < TTL) return e.tools;
  const tools = await paged(name, 'tools/list', 'tools');
  cache[name] = { hash: cfgHash(name), at: Date.now(), tools };
  writeCache();
  return tools;
}

export const callTool = (server, tool, args = {}, signal) =>
  withClient(server, (c) => c.request('tools/call', { name: tool, arguments: args }, signal));

export const callMany = (calls, signal) =>
  Promise.all(calls.map((c) => callTool(c.server, c.tool, c.arguments, signal).then((result) => ({ ...c, result }), (error) => ({ ...c, error: error.message, aborted: error.name === 'AbortError' }))));

export const listResources = (name) => paged(name, 'resources/list', 'resources');
export const listPrompts = (name) => paged(name, 'prompts/list', 'prompts');
export const readResource = (name, uri, signal) => withClient(name, (c) => c.request('resources/read', { uri }, signal));
export const getPrompt = (name, prompt, args = {}) => withClient(name, (c) => c.request('prompts/get', { name: prompt, arguments: args }));

/** Latence (ms) d'un aller-retour `ping` ; un serveur sans `ping` répond « méthode inconnue » ce qui prouve qu'il est vivant. */
export async function ping(name) {
  const t0 = Date.now();
  await withClient(name, async (c) => {
    try { await c.request('ping', {}); } catch (e) { if (!/-32601|-32602/.test(e.message)) throw e; }
  });
  return Date.now() - t0;
}

/** Pré-chauffage silencieux : rafraîchit les schémas absents/expirés sans bloquer ni afficher d'erreur. */
export function warmup() {
  readCache();
  for (const n of serverNames()) {
    const e = cache[n];
    if (e && e.hash === cfgHash(n) && Date.now() - e.at < TTL) continue;
    listTools(n).catch(() => {});
  }
}

export function cachedTools(name) {
  readCache();
  const e = cache[name];
  return e && e.hash === cfgHash(name) ? e.tools : null;
}

export async function reload() {
  closeAll();
  clearCache();
  loadConfig();
}

process.on('exit', () => closeAll());
export function closeAll() { for (const n of [...activeClients.keys()]) drop(n); }
