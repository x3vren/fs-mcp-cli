// Faux serveur MCP (stdio) pour les tests.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const tools = [
  { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'slow', description: 'Lent', inputSchema: { type: 'object', properties: {} } },
];

rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  const ok = (result) => out({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize': return ok({ protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'mock', version: '1' } });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools });
    case 'resources/list': return ok({ resources: [{ uri: 'mock://a', name: 'A' }] });
    case 'resources/read': return ok({ contents: [{ uri: m.params.uri, text: 'contenu ' + m.params.uri }] });
    case 'tools/call': {
      const a = m.params.arguments || {};
      if (a.crash) process.exit(1);
      if (m.params.name === 'slow') return void setTimeout(() => ok({ content: [{ type: 'text', text: 'fini' }] }), 5000);
      return ok({ content: [{ type: 'text', text: 'echo:' + a.text }] });
    }
    default: return out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
  }
});
