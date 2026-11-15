import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { addSecrets, maskText } from './util.js';

// API non officielle, d'après https://github.com/FranceStudent/francestudent-ai-sdk
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SESSION_FILE = path.join(ROOT, '.session');
export const BASE_URL = (process.env.FS_ORIGIN || 'https://ia.francestudent.org').replace(/\/$/, '');
const API_URL = (process.env.FS_API_URL || 'https://api.francestudent.ai').replace(/\/$/, '');
const COOKIE = 'next-auth.session-token';

let session = null; // { sessionToken, agentId, agentName }
try { session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { /* pas de session */ }
if (!session && process.env.FS_SESSION_TOKEN) session = { sessionToken: extractToken(process.env.FS_SESSION_TOKEN) };

let access = { token: '', exp: 0 };
let renewing = null;
let chatId = null;
const deviceId = session?.deviceId || crypto.randomUUID();

function extractToken(v) {
  v = v.trim();
  const m = v.match(/(?:^|;\s*)(?:__Secure-)?next-auth\.session-token=([^;]+)/);
  return m ? m[1] : v;
}
const save = () => fs.writeFileSync(SESSION_FILE, JSON.stringify({ ...session, deviceId }), { mode: 0o600 });
const baseHeaders = () => ({
  Accept: 'application/json, text/plain, */*', Origin: BASE_URL, Referer: BASE_URL + '/',
  'francestudent-client-platform': 'web_fs_ai', 'francestudent-client-version': '4005601', 'francestudent-device-id': deviceId,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0',
});

export const isLoggedIn = () => !!session?.sessionToken;
export const getModel = () => (session?.agentId != null ? session.agentName || String(session.agentId) : null);
export const setModel = (agent) => { session = { ...session, agentId: agent.id, agentName: agent.name }; chatId = null; save(); };
export const userName = () => (session?.sessionToken ? session.email || 'session France Student' : null);

/** Échange le cookie de session contre un JWT court (GET /api/auth/api-token). */
function renew() {
  renewing ||= (async () => {
    let res;
    try { res = await fetch(`${BASE_URL}/api/auth/api-token`, { headers: { ...baseHeaders(), Cookie: `${COOKIE}=${session.sessionToken}` } }); }
    catch (e) { throw new Error(`France Student injoignable: ${e.message}`); }
    if (res.status === 401) throw Object.assign(new Error('Session invalide ou expirée — utilisez /login'), { code: 'SESSION' });
    if (!res.ok) throw new Error(`api-token HTTP ${res.status} (blocage Cloudflare ?)`);
    const d = await res.json();
    if (!d.accessToken) throw new Error('Aucun accessToken reçu');
    access = { token: d.accessToken, exp: d.expiresAt ? d.expiresAt * 1000 : Date.now() + (Number(d.expiresIn) || 300) * 1000 };
    addSecrets([access.token, session.sessionToken]);
    const set = res.headers.getSetCookie?.().map((c) => c.match(new RegExp(`${COOKIE}=([^;]+)`))?.[1]).find(Boolean);
    if (set && set !== session.sessionToken) { session.sessionToken = set; save(); }
  })().finally(() => { renewing = null; });
  return renewing;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch avec 2 nouvelles tentatives sur erreur réseau ou 502/503/504 (requête non traitée par le serveur). */
async function doFetch(url, init) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, init);
      if (i < 2 && [502, 503, 504].includes(r.status)) { await sleep(500 * 2 ** i); continue; }
      return r;
    } catch (e) {
      if (e.name === 'AbortError' || i >= 2) throw e;
      await sleep(500 * 2 ** i);
    }
  }
}

async function http(p, { clientTools, ...opts } = {}, retry = true) {
  opts.clientTools = clientTools;
  if (!isLoggedIn()) throw new Error('Non connecté — utilisez /login');
  if (!access.token || access.exp - Date.now() < 60000) await renew();
  let res;
  try {
    res = await doFetch(API_URL + p, {
      ...opts, headers: { ...baseHeaders(), 'Content-Type': 'application/json', Authorization: `Bearer ${access.token}`, ...(opts.headers || {}) },
    });
  } catch (e) { if (e.name === 'AbortError') throw e; throw new Error(`API France Student injoignable: ${e.message}`); }
  if (res.status === 401 && retry) { access = { token: '', exp: 0 }; await renew(); return http(p, opts, false); }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    const hint = opts.clientTools ? (res.status === 403 ? ' — outils client désactivés pour ce compte (flag 2026_11_client_tools)' : res.status === 400 ? ' — modèle sans support des outils client (essayez un modèle OpenAI ou Claude via /model)' : '') : '';
    throw new Error(`France Student HTTP ${res.status}: ${body}${hint}`);
  }
  return res;
}

/** Connexion via le cookie `next-auth.session-token` (ou un en-tête Cookie complet). */
export async function login(input) {
  const token = extractToken(input || '');
  if (!token) throw new Error('Token vide');
  session = { ...session, sessionToken: token };
  access = { token: '', exp: 0 };
  try { await renew(); } catch (e) { session.sessionToken = null; throw e; }
  save();
}

/** Connexion e-mail / mot de passe (flux OAuth WHMCS via francestudent-ai-sdk). Seul le session token est conservé. */
export async function loginPassword(email, password) {
  let SDK;
  try { SDK = await import('francestudent-ai-sdk'); }
  catch { throw new Error('Module "francestudent-ai-sdk" absent — lancez: npm install (ou utilisez un session token)'); }
  const client = new SDK.FranceStudent({ origin: BASE_URL });
  let token;
  try { token = await client.login(email, password); }
  catch (e) { throw new Error(`Connexion refusée: ${e.message}`); }
  await login(token);
  session.email = email;
  save();
}

export const userEmail = () => session?.email || null;

export async function listModels() {
  const arr = await (await http('/chats/agents')).json();
  return (Array.isArray(arr) ? arr : arr.data || [])
    .filter((a) => a.id !== undefined && a.isActive !== false)
    .map((a) => ({ id: a.id, name: a.name || a.model || String(a.id), info: [a.provider || a.modelProvider, a.model].filter(Boolean).join(' / ') }));
}

async function* parseSse(body) {
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
      const p = data.join('\n');
      if (!p) continue;
      if (p === '[DONE]') return;
      let d = p; try { d = JSON.parse(p); } catch { /* texte brut */ }
      yield { event, data: d };
    }
  }
}

let toolCalls = [];
const CLIENT_TOOLS = ['run_command']; // pont MCP: le client n'exécute que des commandes `mcp call ...`

/**
 * Envoie un message (string) ou des résultats d'outils ({toolResults}) et yield les deltas de texte.
 * Les appels d'outils client en attente sont disponibles dans chat.toolCalls après le flux.
 */
async function* stream(input, signal) {
  if (session?.agentId == null) throw new Error('Aucun modèle sélectionné — utilisez /model');
  toolCalls = [];
  const isResults = typeof input === 'object';
  const common = { agentId: session.agentId, enableWebSearch: false, files: [], images: [], clientTools: CLIENT_TOOLS };
  let p; let body;
  if (chatId) {
    p = `/chats/${encodeURIComponent(chatId)}`;
    body = isResults ? { toolResults: input.toolResults, clientTools: CLIENT_TOOLS } : { ...common, content: input };
  } else {
    if (isResults) throw new Error('Résultats d\'outils sans chat en cours');
    p = '/chats/stream';
    body = { ...common, chatId: null, initialContent: input, enableCanvas: false, isIncognito: false, isPrivate: true };
  }
  if (process.env.FS_DEBUG) console.error(maskText(`[debug] POST ${p} ${JSON.stringify({ ...body, initialContent: undefined, content: undefined })}`));
  const res = await http(p, { method: 'POST', signal, headers: { Accept: 'text/event-stream' }, clientTools: true, body: JSON.stringify(body) });
  let got = false;
  for await (const { event, data } of parseSse(res.body)) {
    const d = data && typeof data === 'object' ? data : {};
    if (process.env.FS_DEBUG && !/output_text\.delta|reasoning_summary_text\.delta|function_call_arguments\.delta/.test(event)) console.error(maskText(`[debug] ${event} ${JSON.stringify(data).slice(0, 400)}`));
    if (d.chat_id || d.chatId) chatId = d.chat_id || d.chatId;
    if (event === 'response.output_text.delta' && typeof d.delta === 'string') { got = true; yield d.delta; }
    else if (event === 'error' || event === 'response.failed') throw new Error(`Erreur de flux: ${JSON.stringify(d.error || d).slice(0, 300)}`);
    else if (event === 'completed') {
      const tc = d.message?.toolCalls;
      if (Array.isArray(tc)) toolCalls = tc.map((x) => ({ callId: x.callId ?? x.call_id, name: x.name, arguments: typeof x.arguments === 'string' ? safeJson(x.arguments) : x.arguments || {} }));
      if (!got && typeof d.message?.content === 'string' && d.message.content) { got = true; yield d.message.content; }
      return;
    }
  }
  if (!got && !toolCalls.length) throw new Error('Le flux s\'est terminé sans réponse');
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

export const chat = {
  stream,
  async send(content) { let out = ''; for await (const t of stream(content)) out += t; return out; },
  reset() { chatId = null; toolCalls = []; },
  get isNew() { return chatId === null; },
  get toolCalls() { return toolCalls; },
};
/** Derniers chats du compte. */
export async function listChats(limit = 20) {
  const d = await (await http(`/chats?limit=${limit}`)).json();
  const arr = Array.isArray(d) ? d : d.chats || d.data || d.items || [];
  return arr
    .map((x) => ({ id: x.id || x.chatId, title: x.title || x.name || '(sans titre)', at: x.lastMessageAt || x.updatedAt || x.createdAt || '' }))
    .filter((x) => x.id);
}

/** Reprend un chat existant ; retourne ses messages texte (pour affichage). */
export async function resumeChat(id) {
  const d = await (await http(`/chats/${encodeURIComponent(id)}`)).json();
  chatId = id;
  toolCalls = [];
  const msgs = d.messages || d.chat?.messages || [];
  return msgs.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })).filter((m) => m.content);
}
