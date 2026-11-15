import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG_FILE = process.env.FS_MCP_LOG || path.join(os.homedir(), '.fs_mcp_actions.log');
const HIST_FILE = process.env.FS_MCP_HISTORY || path.join(os.homedir(), '.fs_mcp_history');

/** Journal des appels d'outils MCP (une ligne JSON par action). Les arguments doivent déjà être masqués. */
export function logAction(entry) {
  try { fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch { /* non bloquant */ }
}

export function readLog(n = 20) {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l));
  } catch { return []; }
}

/** Historique de saisie (flèches haut/bas), le plus récent en premier. */
export function loadHistory() {
  try { return fs.readFileSync(HIST_FILE, 'utf8').split('\n').filter(Boolean).slice(-500).reverse(); } catch { return []; }
}

export function addHistory(line) {
  if (!line || line.includes('\n')) return;
  try { fs.appendFileSync(HIST_FILE, line + '\n'); } catch { /* non bloquant */ }
}
