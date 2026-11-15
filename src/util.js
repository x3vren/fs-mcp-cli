// Utilitaires purs (testables) : masquage de secrets, glob, découpage shell, analyse des commandes MCP.

export const SECRET_KEY = /token|secret|password|passwd|authorization|api[-_]?key|cookie/i;
const secrets = new Set();

/** Enregistre des valeurs sensibles à masquer dans tout affichage / journal. */
export function addSecrets(list) {
  for (const s of list) if (typeof s === 'string' && s.length >= 8) secrets.add(s);
}

export function maskText(s) {
  let out = String(s);
  for (const v of secrets) out = out.split(v).join('***');
  return out.replace(/(Bearer\s+)[\w.\-~+/]+=*/gi, '$1***');
}

export function maskValue(v, key = '') {
  if (SECRET_KEY.test(key)) return '***';
  if (typeof v === 'string') return maskText(v);
  if (Array.isArray(v)) return v.map((x) => maskValue(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskValue(x, k)]));
  return v;
}

export function globMatch(pattern, s) {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  return re.test(s);
}

/** Découpe une ligne en arguments en respectant les guillemets simples et doubles. */
export function shellSplit(str) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str))) out.push(m[1] !== undefined ? m[1].replace(/\\(["\\])/g, '$1') : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

/**
 * Analyse une commande envoyée par le modèle via run_command. Seules les commandes `mcp ...` sont acceptées :
 *   mcp list | mcp tools <s> [outil] | mcp resources <s> | mcp read <s> <uri> | mcp call <s> <outil> [json]
 */
export function parseMcpCommand(cmd, servers) {
  const s = String(cmd || '').trim();
  const need = (n) => {
    if (!servers.includes(n)) throw new Error(`Serveur MCP inconnu: ${n}`);
    return n;
  };
  let m;
  if (/^mcp\s+list$/.test(s)) return { kind: 'list' };
  if ((m = /^mcp\s+call\s+(\S+)\s+(\S+)\s*([\s\S]*)$/.exec(s))) {
    let args = {};
    const raw = m[3].trim();
    if (raw) {
      try { args = JSON.parse(raw); } catch { throw new Error('Arguments JSON invalides.'); }
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('Les arguments doivent être un objet JSON.');
    return { kind: 'call', server: need(m[1]), tool: m[2], arguments: args };
  }
  if ((m = /^mcp\s+tools\s+(\S+)(?:\s+(\S+))?$/.exec(s))) return { kind: 'tools', server: need(m[1]), tool: m[2] };
  if ((m = /^mcp\s+resources\s+(\S+)$/.exec(s))) return { kind: 'resources', server: need(m[1]) };
  if ((m = /^mcp\s+read\s+(\S+)\s+(\S+)$/.exec(s))) return { kind: 'read', server: need(m[1]), uri: m[2] };
  throw new Error('Commande refusée: seules les commandes "mcp call|tools|resources|read|list" sont autorisées.');
}
