import test from 'node:test';
import assert from 'node:assert/strict';
import { addSecrets, maskText, maskValue, globMatch, shellSplit, parseMcpCommand } from '../src/util.js';
import { mdStream } from '../src/ui.js';

test('masquage des secrets', () => {
  addSecrets(['supersecretvalue123']);
  assert.equal(maskText('x supersecretvalue123 y'), 'x *** y');
  assert.equal(maskText('Authorization: Bearer abc.def-123'), 'Authorization: Bearer ***');
  assert.deepEqual(maskValue({ token: 'a', nested: { password: 'b', ok: 'c' } }), { token: '***', nested: { password: '***', ok: 'c' } });
});

test('glob', () => {
  assert.ok(globMatch('get_*', 'get_children'));
  assert.ok(!globMatch('get_*', 'execute_luau'));
  assert.ok(globMatch('screen_capture', 'SCREEN_CAPTURE'));
});

test('shellSplit', () => {
  assert.deepEqual(shellSplit('nom npx -y "mon pkg" \'a b\''), ['nom', 'npx', '-y', 'mon pkg', 'a b']);
});

test('parseMcpCommand accepte uniquement les commandes mcp', () => {
  const s = ['Roblox'];
  assert.deepEqual(parseMcpCommand('mcp call Roblox get_children {"p":1}', s), { kind: 'call', server: 'Roblox', tool: 'get_children', arguments: { p: 1 } });
  assert.deepEqual(parseMcpCommand('mcp tools Roblox x', s), { kind: 'tools', server: 'Roblox', tool: 'x' });
  assert.deepEqual(parseMcpCommand('mcp list', s), { kind: 'list' });
  assert.throws(() => parseMcpCommand('rm -rf /', s), /refusée/);
  assert.throws(() => parseMcpCommand('mcp call Inconnu x', s), /inconnu/);
  assert.throws(() => parseMcpCommand('mcp call Roblox x {oops', s), /JSON/);
  assert.throws(() => parseMcpCommand('mcp call Roblox x [1]', s), /objet/);
});

test('rendu markdown en streaming', () => {
  let out = '';
  const md = mdStream((s) => { out += s; });
  md.push('# Titre\n- **gras** et `code`\n``` js\nlet a\n```\nfin');
  md.end();
  assert.match(out, /Titre/);
  assert.match(out, /• /);
  assert.ok(!out.includes('**'));
  assert.ok(out.trimEnd().endsWith('fin'));
});
