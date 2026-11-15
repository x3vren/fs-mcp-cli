import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-'));
const server = fileURLToPath(new URL('./fixtures/mock-server.mjs', import.meta.url));
fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ autoDetect: false, mcpServers: { mock: { command: 'node', args: [server] } } }));
process.env.FS_MCP_CONFIG = path.join(dir, 'mcp.json');
process.env.FS_MCP_CACHE = path.join(dir, 'cache.json');

const mcp = await import('../src/mcp.js');
mcp.loadConfig();
after(() => mcp.closeAll());

test('liste les outils et remplit le cache disque', async () => {
  const tools = await mcp.listTools('mock');
  assert.deepEqual(tools.map((t) => t.name), ['echo', 'slow']);
  assert.ok(fs.existsSync(process.env.FS_MCP_CACHE));
  assert.equal(mcp.cachedTools('mock').length, 2);
});

test('déduplique les connexions concurrentes', async () => {
  mcp.closeAll();
  const [a, b] = await Promise.all([mcp.connect('mock'), mcp.connect('mock')]);
  assert.equal(a, b);
  assert.equal(mcp.activeClients.size, 1);
});

test('appels parallèles', async () => {
  const r = await mcp.callMany([1, 2, 3].map((n) => ({ server: 'mock', tool: 'echo', arguments: { text: 'n' + n } })));
  assert.deepEqual(r.map((x) => x.result.content[0].text), ['echo:n1', 'echo:n2', 'echo:n3']);
});

test('reconnexion automatique après plantage du serveur', async () => {
  const r = await mcp.callMany([{ server: 'mock', tool: 'echo', arguments: { crash: true } }]);
  assert.ok(r[0].error); // le serveur plante aussi au 2e essai
  const ok = await mcp.callMany([{ server: 'mock', tool: 'echo', arguments: { text: 'revenu' } }]);
  assert.equal(ok[0].result.content[0].text, 'echo:revenu');
});

test('annulation d\'un appel en cours', async () => {
  const ac = new AbortController();
  const p = mcp.callMany([{ server: 'mock', tool: 'slow', arguments: {} }], ac.signal);
  setTimeout(() => ac.abort(), 100);
  const [r] = await p;
  assert.equal(r.aborted, true);
});

test('ping, ressources', async () => {
  assert.ok((await mcp.ping('mock')) >= 0);
  assert.equal((await mcp.listResources('mock'))[0].uri, 'mock://a');
  assert.equal((await mcp.readResource('mock', 'mock://a')).contents[0].text, 'contenu mock://a');
});

test('ajout / retrait de serveur dans mcp.json', () => {
  mcp.addServer('autre', { command: 'node', args: [server] });
  assert.ok(mcp.serverNames().includes('autre'));
  mcp.removeServer('autre');
  assert.ok(!mcp.serverNames().includes('autre'));
});
