#!/usr/bin/env node
import readline from 'node:readline';
import * as api from './api.js';
import * as mcp from './mcp.js';
import { detectLocal } from './discover.js';
import { c, spinner, mdStream } from './ui.js';
import { maskText, maskValue, globMatch, shellSplit, parseMcpCommand } from './util.js';
import { logAction, readLog, loadHistory, addHistory } from './store.js';

const VERSION = '1.1.0';
const MAX_STEPS = 12;
const MAX_OUT = 20000;
const CMDS = ['login', 'model', 'mcp', 'auto', 'history', 'resume', 'log', 'debug', 'clear', 'help', 'exit'];
const MCP_SUBS = ['list', 'status', 'detect', 'import', 'add', 'remove', 'test', 'tools', 'call', 'resources', 'read', 'prompts', 'reload'];
const SAFE_TOOLS = ['get_*', 'list_*', 'search_*', 'read_*', 'inspect_*', 'describe_*', 'find_*', 'wait_*', 'screen_capture'];

// ---------- Arguments ----------
const argv = process.argv.slice(2);
const flag = (...n) => n.some((x) => argv.includes(x));
const opt = (...n) => { for (const x of n) { const i = argv.indexOf(x); if (i >= 0) return argv[i + 1]; } return undefined; };
if (flag('-h', '--help')) {
  console.log(`fs-mcp-cli ${VERSION} — MCP locaux × modèles France Student

Usage:
  fs-mcp-cli                     mode interactif
  fs-mcp-cli -p "prompt" [--yes] exécute un prompt puis quitte (--yes: approuve tous les appels MCP)
  fs-mcp-cli -v                  version`);
  process.exit(0);
}
if (flag('-v', '--version')) { console.log(VERSION); process.exit(0); }
const oneShot = opt('-p', '--prompt');

// ---------- État ----------
let busy = null;
let ctxDirty = false;
let lastChats = [];
const approval = { all: flag('--yes') || process.env.FS_AUTO_APPROVE === '1', safe: false, session: [] };

// ---------- Terminal ----------
function completer(line) {
  if (!line.startsWith('/')) return [[], line];
  const parts = line.split(/\s+/);
  const ends = /\s$/.test(line);
  const cur = ends ? '' : parts[parts.length - 1];
  const idx = ends ? parts.length : parts.length - 1;
  const servers = mcp.serverNames();
  let cands = [];
  if (idx === 0) cands = CMDS.map((x) => '/' + x);
  else if (parts[0] === '/mcp') {
    if (idx === 1) cands = MCP_SUBS;
    else if (idx === 2 && ['call', 'tools', 'test', 'remove', 'resources', 'read', 'prompts', 'status'].includes(parts[1])) cands = servers;
    else if (idx === 2 && parts[1] === 'import') cands = [...servers, 'all'];
    else if (idx === 3 && ['call', 'tools'].includes(parts[1])) cands = (mcp.cachedTools(parts[2]) || []).map((t) => t.name);
  } else if (parts[0] === '/auto') {
    if (idx === 1) cands = ['on', 'off', 'safe', 'allow', 'list'];
    else if (idx === 2 && parts[1] === 'allow') cands = servers;
  } else if (parts[0] === '/debug' && idx === 1) cands = ['on', 'off'];
  return [cands.filter((x) => x.startsWith(cur)), cur];
}

const rl = readline.createInterface({
  input: process.stdin, output: process.stdout, completer, history: loadHistory(), historySize: 500,
  prompt: '\x1b[36m\x1b[1mfs-mcp>\x1b[0m ',
});

const ask = (q, mute = false) => new Promise((res) => {
  if (mute) rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); };
  rl.question(q, (a) => {
    if (mute) { delete rl._writeToOutput; process.stdout.write('\n'); }
    if (rl.history && rl.history[0] === a) rl.history.shift(); // ne jamais garder un mot de passe en historique
    res(a.trim());
  });
});

function banner() {
  const w = 46;
  console.log(c.cyan(`\n  ╭${'─'.repeat(w)}╮`));
  console.log(c.cyan('  │') + `  ${c.bold(c.cyan('◆ fs-mcp-cli'))}  ${c.dim('MCP × France Student')}` + ' '.repeat(w - 36) + c.cyan('│'));
  console.log(c.cyan(`  ╰${'─'.repeat(w)}╯`));
  const user = api.userName();
  const n = mcp.serverNames().length;
  console.log(`  ${user ? c.green('●') : c.red('●')} ${user || c.red('non connecté')}  ${c.dim('·')}  ${c.magenta(api.getModel() || 'aucun modèle')}  ${c.dim('·')}  ${c.yellow(n + ' serveur' + (n > 1 ? 's' : '') + ' MCP')}`);
  console.log(c.dim('  /help pour les commandes · Tab pour compléter · Ctrl+C interrompt\n'));
}

const HELP = `${c.bold('Compte')}      /login [token]  /model  /history  /resume [n]  /clear
${c.bold('MCP')}         /mcp list|status|detect|import|add|remove|test|tools|call|resources|read|prompts|reload
${c.bold('Sécurité')}    /auto on|off|safe|allow <serveur> <motif>|list   /log [n]
${c.bold('Divers')}      /debug on|off  /help  /exit`;

// ---------- Formatage ----------
function fmtResult(r) {
  let s = r.error ? `ERREUR: ${r.error}` : (r.result?.content || []).map((p) => p.text ?? `[${p.type}]`).join('\n') || JSON.stringify(r.result);
  if (!r.error && r.result?.isError) s = 'ERREUR OUTIL: ' + s;
  s = maskText(s);
  return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n[...tronqué, ${s.length - MAX_OUT} caractères]` : s;
}
const fmtResource = (r) => maskText((r.contents || []).map((x) => x.text ?? `[binaire ${x.mimeType || ''}]`).join('\n')).slice(0, MAX_OUT);
const sig = (t) => {
  const req = new Set(t.inputSchema?.required || []);
  return Object.entries(t.inputSchema?.properties || {}).map(([k, v]) => `${k}${req.has(k) ? '*' : ''}: ${v.type || 'any'}`).join(', ');
};
const firstLine = (s = '', n = 90) => { const l = s.split('\n')[0]; return l.length > n ? l.slice(0, n - 1) + '…' : l; };

// ---------- Contexte MCP (léger : le détail d'un outil se demande à la volée) ----------
async function mcpContext() {
  const names = mcp.serverNames();
  const all = await Promise.all(names.map((n) => mcp.cachedTools(n) || mcp.listTools(n).catch(() => null)));
  const lines = [];
  for (const [i, n] of names.entries()) {
    if (!all[i]?.length) continue;
    lines.push(`Serveur "${n}":`);
    for (const t of all[i]) lines.push(`- ${t.name}(${(t.inputSchema?.required || []).join(', ')}): ${firstLine(t.description, 80)}`);
  }
  if (!lines.length) return null;
  return `[Contexte client] Ce terminal exécute pour toi des outils MCP locaux, via l'outil client run_command, uniquement avec ces commandes:
  mcp call <serveur> <outil> <json des arguments>
  mcp tools <serveur> <outil>      (schéma complet d'un outil)
  mcp resources <serveur>   |   mcp read <serveur> <uri>
Exemple: mcp call Roblox get_children {"path":"Workspace"}
Les résultats te sont renvoyés comme résultats de run_command. Plusieurs appels run_command dans le même tour sont exécutés en parallèle. Toute autre commande est refusée. Entre parenthèses: paramètres requis.

${lines.join('\n')}`;
}

// ---------- Approbation ----------
function isApproved(server, tool) {
  if (approval.all) return true;
  const rules = mcp.getAutoApprove();
  const pats = [...(rules[server] || []), ...(rules['*'] || []), ...approval.session.filter((s) => s.server === server).map((s) => s.pattern), ...(approval.safe ? SAFE_TOOLS : [])];
  return pats.some((p) => globMatch(p, tool));
}

async function decide(pending) {
  if (!process.stdin.isTTY) return false; // non interactif : refus sauf --yes / règles
  const a = (await ask(c.bold('Exécuter ? ') + c.dim('(o)ui · (n)on · (t)oujours cet outil · (a) tout : '))).toLowerCase();
  if (a === 'a') { approval.all = true; return true; }
  if (a === 't') { for (const p of pending) approval.session.push({ server: p.cmd.server, pattern: p.cmd.tool }); return true; }
  return a === 'o' || a === 'oui' || a === 'y';
}

// ---------- Exécution des appels d'outils client ----------
async function runCommand(cmd, signal) {
  switch (cmd.kind) {
    case 'list': return mcp.serverNames().join('\n') || '(aucun serveur)';
    case 'resources': return JSON.stringify(await mcp.listResources(cmd.server), null, 1);
    case 'read': return fmtResource(await mcp.readResource(cmd.server, cmd.uri, signal));
    case 'tools': {
      const tools = await mcp.listTools(cmd.server);
      if (!cmd.tool) return tools.map((t) => `${t.name}(${sig(t)}): ${firstLine(t.description)}`).join('\n');
      const t = tools.find((x) => x.name === cmd.tool);
      if (!t) throw new Error(`Outil inconnu: ${cmd.tool}`);
      return JSON.stringify(t, null, 1);
    }
    default: throw new Error('Commande inconnue');
  }
}

async function execToolCalls(calls, signal) {
  const plan = calls.map((tc) => {
    try {
      if (tc.name !== 'run_command') throw new Error(`Outil non pris en charge: ${tc.name}`);
      return { tc, cmd: parseMcpCommand(tc.arguments?.command, mcp.serverNames()) };
    } catch (e) { return { tc, error: e.message }; }
  });
  for (const p of plan.filter((x) => x.cmd)) {
    const k = p.cmd;
    console.log(c.yellow(`⚙ ${k.server ? k.server + '.' : ''}${k.tool || k.kind}`) + (k.arguments ? c.dim(' ' + maskText(JSON.stringify(maskValue(k.arguments))).slice(0, 120)) : ''));
  }
  const pending = plan.filter((p) => p.cmd?.kind === 'call' && !isApproved(p.cmd.server, p.cmd.tool));
  if (pending.length && !(await decide(pending))) {
    for (const p of pending) { p.error = process.stdin.isTTY ? "Refusé par l'utilisateur" : 'Refusé: mode non interactif (utilisez --yes ou /auto)'; delete p.cmd; }
  }
  const out = await Promise.all(plan.map(async (p) => {
    if (p.error) return { p, output: p.error, isError: true, ms: 0 };
    const t0 = Date.now();
    try {
      if (p.cmd.kind === 'call') {
        const [r] = await mcp.callMany([p.cmd], signal);
        if (r.aborted) throw Object.assign(new Error('Interrompu'), { name: 'AbortError' });
        const bad = !!(r.error || r.result?.isError);
        const ms = Date.now() - t0;
        logAction({ server: p.cmd.server, tool: p.cmd.tool, args: maskValue(p.cmd.arguments), ok: !bad, ms, error: r.error ? maskText(r.error) : undefined });
        return { p, output: fmtResult(r), isError: bad, ms };
      }
      return { p, output: await runCommand(p.cmd, signal), isError: false, ms: Date.now() - t0 };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      return { p, output: `ERREUR: ${maskText(e.message)}`, isError: true, ms: Date.now() - t0 };
    }
  }));
  return out.map((o) => {
    console.log(o.isError ? c.red('  ✖ ' + o.output.replace(/\s+/g, ' ').slice(0, 200)) : c.green('  ✔ ok') + c.dim(` ${o.ms}ms`));
    return { callId: o.p.tc.callId, output: o.output, isError: o.isError };
  });
}

// ---------- Boucle ReAct ----------
async function runChat(input) {
  const ac = new AbortController();
  busy = ac;
  try {
    let msg = input;
    let results = null;
    if (api.chat.isNew || ctxDirty) {
      ctxDirty = false;
      const ctx = await mcpContext();
      if (ctx) msg = `${ctx}\n\n---\n${input}`;
    }
    for (let step = 0; step < MAX_STEPS; step++) {
      const stop = spinner('réflexion');
      let started = false;
      const md = mdStream((s) => {
        if (!started) { started = true; stop(); process.stdout.write(c.magenta('◆ ')); }
        process.stdout.write(s);
      });
      try {
        for await (const t of api.chat.stream(results ? { toolResults: results } : msg, ac.signal)) md.push(t);
        md.end();
      } finally { stop(); }
      const calls = api.chat.toolCalls;
      if (!calls.length) return;
      results = await execToolCalls(calls, ac.signal);
    }
    console.log(c.red(`Arrêt: ${MAX_STEPS} étapes atteintes.`));
  } finally { busy = null; }
}

async function withBusy(fn) {
  const ac = new AbortController();
  busy = ac;
  try { return await fn(ac.signal); } finally { busy = null; }
}

// ---------- Commandes : compte ----------
async function cmdLoginPassword() {
  const email = await ask(c.bold('Email: '));
  const pass = await ask(c.bold('Mot de passe: '), true);
  const stop = spinner('connexion');
  try { await api.loginPassword(email, pass); } finally { stop(); }
  console.log(c.green(`✔ Connecté (${email}) — session enregistrée.`));
  if (api.getModel() == null) await cmdModel();
}

async function cmdLogin() {
  console.log(c.dim('Collez le cookie "next-auth.session-token" de ia.francestudent.org (F12 > Application > Cookies),'));
  console.log(c.dim('ou un en-tête Cookie complet.'));
  await api.login(await ask('Session token: ', true));
  console.log(c.green('Connecté.'));
  if (api.getModel() == null) await cmdModel();
}

async function firstRun() {
  if (api.isLoggedIn()) return;
  console.log(c.bold('Première connexion — compte France Student'));
  for (;;) {
    try { return await cmdLoginPassword(); } catch (e) {
      console.log(c.red(`✖ ${e.message}`));
      const a = (await ask('Réessayer (r), token de session (t), ignorer (Entrée) ? ')).toLowerCase();
      if (a === 't') return cmdLogin();
      if (a !== 'r') return;
    }
  }
}

async function cmdModel() {
  const models = await api.listModels();
  models.forEach((m, i) => console.log(`${String(i + 1).padStart(3)}. ${m.name} ${c.dim(m.info)}`));
  const a = await ask('Numéro: ');
  const m = models[Number(a) - 1] || models.find((x) => String(x.id) === a);
  if (!m) return console.log(c.red('Choix invalide.'));
  api.setModel(m);
  console.log(c.green(`Modèle: ${m.name}`));
}

async function cmdHistory() {
  lastChats = await api.listChats(20);
  if (!lastChats.length) return console.log(c.dim('Aucun chat.'));
  lastChats.forEach((ch, i) => console.log(`${String(i + 1).padStart(3)}. ${ch.title.slice(0, 60)} ${c.dim(String(ch.at).slice(0, 16).replace('T', ' '))}`));
}

async function cmdResume(arg) {
  if (!lastChats.length) await cmdHistory();
  if (!lastChats.length) return;
  const a = arg || (await ask('Numéro du chat à reprendre: '));
  const ch = lastChats[Number(a) - 1] || lastChats.find((x) => x.id === a);
  if (!ch) return console.log(c.red('Choix invalide.'));
  const msgs = await api.resumeChat(ch.id);
  ctxDirty = true; // le contexte MCP est renvoyé au prochain message
  console.log(c.green(`✔ Chat repris: ${ch.title}`));
  for (const m of msgs.slice(-4)) console.log(c.dim(`${m.role === 'user' ? 'vous' : 'ia'}: `) + firstLine(m.content.replace(/^\[Contexte client\][\s\S]*?\n---\n/, ''), 200));
}

// ---------- Commandes : MCP ----------
async function cmdMcp(args, raw) {
  const [sub, server, tool] = args;
  const need = () => { if (!mcp.serverNames().includes(server)) throw new Error(`Serveur inconnu: ${server || '(manquant)'}`); };
  switch (sub) {
    case 'list':
      for (const n of mcp.serverNames()) {
        const live = mcp.activeClients.get(n);
        const cached = mcp.cachedTools(n);
        const st = live && !live.closed ? c.green('connecté') : cached ? c.cyan(`en cache (${cached.length} outils)`) : c.dim('inactif');
        console.log(`${n.padEnd(20)} ${st} ${c.dim(mcp.origins[n] ? `[détecté: ${mcp.origins[n]}]` : '[mcp.json]')}`);
      }
      if (!mcp.serverNames().length) console.log(c.dim('Aucun serveur — /mcp add <nom> <commande|url>'));
      break;
    case 'status': {
      const lines = await Promise.all(mcp.serverNames().map(async (n) => {
        try {
          const ms = await mcp.ping(n);
          return `${c.green('●')} ${n.padEnd(20)} ${String(ms).padStart(5)}ms  ${c.dim((mcp.cachedTools(n)?.length ?? '?') + ' outils')}`;
        } catch (e) { return `${c.red('●')} ${n.padEnd(20)} ${c.red(maskText(e.message))}`; }
      }));
      lines.forEach((l) => console.log(l));
      break;
    }
    case 'test': {
      need();
      const t0 = Date.now();
      const tools = await mcp.listTools(server, { fresh: true });
      console.log(c.green(`OK ${Date.now() - t0}ms — ${tools.length} outils: `) + tools.map((t) => t.name).join(', '));
      break;
    }
    case 'tools': {
      need();
      for (const t of await mcp.listTools(server)) {
        if (tool && t.name !== tool) continue;
        console.log(c.cyan(t.name) + ` (${sig(t)})`);
        if (t.description) console.log(c.dim('  ' + firstLine(t.description, 160)));
      }
      break;
    }
    case 'call': {
      need();
      if (!tool) throw new Error('Usage: /mcp call <serveur> <outil> [json]');
      const j = (/^\/mcp\s+call\s+\S+\s+\S+\s*([\s\S]*)$/.exec(raw)?.[1] || '').trim();
      let a = {};
      if (j) try { a = JSON.parse(j); } catch { throw new Error('JSON invalide'); }
      const t0 = Date.now();
      const [r] = await withBusy((sig_) => mcp.callMany([{ server, tool, arguments: a }], sig_));
      if (r.aborted) return;
      logAction({ server, tool, args: maskValue(a), ok: !(r.error || r.result?.isError), ms: Date.now() - t0, error: r.error ? maskText(r.error) : undefined, manual: true });
      console.log(fmtResult(r) + c.dim(` (${Date.now() - t0}ms)`));
      break;
    }
    case 'resources': {
      need();
      const list = await mcp.listResources(server).catch((e) => { throw new Error(/-32601/.test(e.message) ? 'Ressources non supportées par ce serveur' : e.message); });
      list.forEach((r) => console.log(c.cyan(r.uri) + c.dim(` ${r.name || ''} ${r.mimeType || ''}`)));
      if (!list.length) console.log(c.dim('Aucune ressource.'));
      break;
    }
    case 'read': {
      need();
      if (!tool) throw new Error('Usage: /mcp read <serveur> <uri>');
      console.log(fmtResource(await withBusy((s) => mcp.readResource(server, tool, s))));
      break;
    }
    case 'prompts': {
      need();
      const list = await mcp.listPrompts(server).catch((e) => { throw new Error(/-32601/.test(e.message) ? 'Prompts non supportés par ce serveur' : e.message); });
      list.forEach((p) => console.log(c.cyan(p.name) + c.dim(` ${firstLine(p.description || '', 100)}`)));
      if (!list.length) console.log(c.dim('Aucun prompt.'));
      break;
    }
    case 'add': {
      const [name, first, ...rest] = shellSplit(raw.replace(/^\/mcp\s+add\s*/, ''));
      if (!name || !first) throw new Error('Usage: /mcp add <nom> <url | commande [args...]>');
      const cfg = /^https?:\/\//.test(first) ? { url: first, ...(/\/sse\/?$/.test(first) ? { type: 'sse' } : {}) } : { command: first, args: rest };
      mcp.addServer(name, cfg);
      ctxDirty = true;
      console.log(c.green(`✔ "${name}" ajouté à mcp.json`) + c.dim(` — essayez /mcp test ${name}`));
      break;
    }
    case 'remove':
      need();
      mcp.removeServer(server);
      ctxDirty = true;
      console.log(c.green(`✔ "${server}" retiré de mcp.json`));
      break;
    case 'detect': {
      const { found } = detectLocal();
      if (!found.length) console.log(c.dim('Aucun MCP local détecté (Claude, Cursor, Windsurf, Gemini, Antigravity, VS Code).'));
      for (const f of found) console.log(c.cyan(f.source) + c.dim(' ' + f.file) + '\n  ' + f.names.join(', '));
      break;
    }
    case 'import': {
      if (!server) throw new Error('Usage: /mcp import <serveur|all>');
      const names = server === 'all' ? Object.keys(mcp.origins) : [server];
      for (const n of names) mcp.importServer(n);
      console.log(c.green(`Importé dans mcp.json: ${names.join(', ') || '(rien)'}`));
      break;
    }
    case 'reload':
      await mcp.reload();
      ctxDirty = true;
      mcp.warmup();
      console.log(c.green(`Rechargé: ${mcp.serverNames().length} serveur(s), cache vidé.`));
      break;
    default: console.log(`Usage: /mcp ${MCP_SUBS.join(' | ')}`);
  }
}

function cmdAuto(args) {
  const [a, s, p] = args;
  if (a === 'on') approval.all = true;
  else if (a === 'off') { approval.all = false; approval.safe = false; approval.session = []; }
  else if (a === 'safe') approval.safe = true;
  else if (a === 'allow') {
    if (!s || !p) throw new Error('Usage: /auto allow <serveur|*> <motif, ex: get_*>');
    mcp.addAutoApprove(s, p);
    console.log(c.green(`✔ ${s}: ${p} approuvé automatiquement (enregistré dans mcp.json)`));
  } else if (a && a !== 'list') throw new Error('Usage: /auto on|off|safe|allow <serveur> <motif>|list');
  console.log(c.dim(`Approbation: tout=${approval.all ? 'oui' : 'non'}, lecture seule (${SAFE_TOOLS.slice(0, 3).join(', ')}…)=${approval.safe ? 'oui' : 'non'}`));
  const rules = { ...mcp.getAutoApprove() };
  for (const [k, v] of Object.entries(rules)) console.log(c.dim(`  ${k}: ${v.join(', ')}`));
  for (const x of approval.session) console.log(c.dim(`  (session) ${x.server}: ${x.pattern}`));
}

function cmdLog(n) {
  const entries = readLog(Number(n) || 15);
  if (!entries.length) return console.log(c.dim('Journal vide.'));
  for (const e of entries) {
    console.log(`${c.dim(e.ts.slice(5, 19).replace('T', ' '))} ${e.ok ? c.green('✔') : c.red('✖')} ${e.server}.${e.tool} ${c.dim((e.ms ?? '?') + 'ms' + (e.manual ? ' manuel' : ''))} ${c.dim(JSON.stringify(e.args || {}).slice(0, 80))}`);
  }
}

async function handle(line) {
  if (!line.startsWith('/') || line.includes('\n')) {
    if (!api.isLoggedIn()) throw new Error('Non connecté — /login');
    if (api.getModel() == null) throw new Error('Aucun modèle — /model');
    return runChat(line);
  }
  const [cmd, ...args] = line.slice(1).split(/\s+/);
  switch (cmd) {
    case 'login': return args[0] === 'token' ? cmdLogin() : cmdLoginPassword();
    case 'model': return cmdModel();
    case 'mcp': return cmdMcp(args, line);
    case 'auto': return cmdAuto(args);
    case 'history': return cmdHistory();
    case 'resume': return cmdResume(args[0]);
    case 'log': return cmdLog(args[0]);
    case 'debug':
      if (args[0] === 'off') delete process.env.FS_DEBUG; else process.env.FS_DEBUG = '1';
      return console.log(c.dim(`Debug: ${process.env.FS_DEBUG ? 'activé' : 'désactivé'}`));
    case 'clear': api.chat.reset(); console.clear(); return banner();
    case 'help': return console.log(HELP);
    case 'exit': return shutdown();
    default: console.log(c.red(`Commande inconnue: /${cmd} — /help`));
  }
}

function explain(e) {
  if (e.name === 'AbortError') return null;
  const hint = e.code === 'SESSION' ? c.dim(' (tapez /login)') : '';
  return c.red(`Erreur: ${maskText(e.message)}`) + hint;
}

// ---------- Arrêt & démarrage ----------
let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  mcp.closeAll();
  process.exit(code);
}

try { mcp.loadConfig(); } catch (e) { console.log(c.red(e.message)); }
mcp.warmup();

process.on('SIGINT', () => { if (busy) { busy.abort(); console.log(c.dim('\n(interrompu)')); } else shutdown(); });
rl.on('SIGINT', () => process.emit('SIGINT'));
process.on('SIGTERM', () => shutdown());

let inputEnded = false;
let chain = Promise.resolve();
rl.on('close', () => { inputEnded = true; chain.then(() => shutdown()); });

if (oneShot !== undefined) {
  chain = chain.then(async () => {
    try {
      if (!api.isLoggedIn()) throw new Error('Non connecté — lancez fs-mcp-cli une fois en interactif (/login)');
      if (api.getModel() == null) throw new Error('Aucun modèle — lancez fs-mcp-cli une fois en interactif (/model)');
      await runChat(oneShot);
      shutdown(0);
    } catch (e) { const m = explain(e); if (m) console.error(m); shutdown(1); }
  });
} else {
  chain = chain
    .then(async () => { if (api.isLoggedIn()) banner(); else { console.log(c.cyan(c.bold('\n  ◆ fs-mcp-cli'))); await firstRun(); banner(); } })
    .catch((e) => console.log(explain(e)))
    .then(() => { if (!inputEnded) rl.prompt(); });

  const enqueue = (text) => {
    chain = chain.then(async () => {
      const line = text.trim();
      if (line) {
        addHistory(line);
        try { await handle(line); } catch (e) { const m = explain(e); if (m) console.log(m); }
      }
      if (!inputEnded) rl.prompt();
    });
  };

  // Collage multi-lignes : les lignes qui arrivent en rafale (< 40 ms) forment un seul message.
  let paste = [];
  let timer = null;
  rl.on('line', (l) => {
    if (!process.stdin.isTTY) return enqueue(l);
    paste.push(l);
    clearTimeout(timer);
    timer = setTimeout(() => { const t = paste.join('\n'); paste = []; enqueue(t); }, 40);
  });
}
