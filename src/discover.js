import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, '.config');
const macSupport = path.join(home, 'Library', 'Application Support');
const claudeDir = process.platform === 'win32' ? path.join(appData, 'Claude') : process.platform === 'darwin' ? path.join(macSupport, 'Claude') : path.join(home, '.config', 'Claude');
const codeDir = process.platform === 'win32' ? path.join(appData, 'Code', 'User') : process.platform === 'darwin' ? path.join(macSupport, 'Code', 'User') : path.join(home, '.config', 'Code', 'User');

const SOURCES = () => [
  ['Claude Desktop', path.join(claudeDir, 'claude_desktop_config.json')],
  ['Claude Code', path.join(home, '.claude.json')],
  ['Claude Code (projet)', path.join(process.cwd(), '.mcp.json')],
  ['Cursor', path.join(home, '.cursor', 'mcp.json')],
  ['Cursor (projet)', path.join(process.cwd(), '.cursor', 'mcp.json')],
  ['Windsurf', path.join(home, '.codeium', 'windsurf', 'mcp_config.json')],
  ['Gemini CLI', path.join(home, '.gemini', 'settings.json')],
  ['Antigravity', path.join(home, '.gemini', 'antigravity', 'mcp_config.json')],
  ['VS Code', path.join(codeDir, 'mcp.json')],
  ['VS Code (projet)', path.join(process.cwd(), '.vscode', 'mcp.json')],
];

/** Normalise une entrée de config MCP d'un autre client vers notre format. Retourne null si inutilisable. */
function normalize(e) {
  if (!e || typeof e !== 'object' || e.disabled === true || e.enabled === false) return null;
  const url = e.url || e.serverUrl || e.httpUrl;
  if (url) {
    const out = { url };
    if (e.headers) out.headers = e.headers;
    if (e.token) out.token = e.token;
    if (e.type === 'sse' || (e.serverUrl && !e.httpUrl && /\/sse\/?$/.test(url))) out.type = 'sse';
    return out;
  }
  if (e.command) {
    const out = { command: e.command, args: e.args || [] };
    if (e.env) out.env = e.env;
    return out;
  }
  return null;
}

/** Scanne les configs des clients MCP installés. Retourne { servers: {nom: cfg}, found: [{source, file, names}] }. */
export function detectLocal() {
  const servers = {}; const origin = {}; const found = [];
  for (const [source, file] of SOURCES()) {
    let json;
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const block = json.mcpServers || json.servers || {};
    const names = [];
    for (const [name, raw] of Object.entries(block)) {
      if (/^fs-mcp-cli$/i.test(name)) continue;
      const cfg = normalize(raw);
      if (!cfg) continue;
      names.push(name);
      if (!servers[name]) { servers[name] = cfg; origin[name] = source; }
    }
    if (names.length) found.push({ source, file, names });
  }
  return { servers, origin, found };
}