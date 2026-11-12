const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

test('per-server tool policy validates, hides, and blocks tools', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-tool-policy-'));
  process.env.DATA_DIR = directory;
  const { saveConfig } = require('../lib/storage');
  const { createGatewayServer, validateServer } = require('../lib/mcp');

  // Validation: normalises, de-duplicates, keeps through edits, and clears with empty lists.
  const base = { name: 'Memory', slug: 'memory', transport: 'http', url: 'http://example.test/mcp' };
  const made = validateServer({ ...base, toolPolicy: { allow: [' retain ', 'recall', 'retain'], deny: ['delete_bank'] } });
  assert.deepEqual(made.toolPolicy, { allow: ['retain', 'recall'], deny: ['delete_bank'] });
  assert.deepEqual(validateServer({ ...base }, made).toolPolicy, made.toolPolicy);
  assert.equal(validateServer({ ...base, toolPolicy: { allow: [], deny: [] } }, made).toolPolicy, undefined);
  assert.throws(() => validateServer({ ...base, toolPolicy: { allow: 'retain' } }), /list/);
  assert.throws(() => validateServer({ ...base, toolPolicy: { deny: ['a\nb'] } }), /single-line/);
  assert.throws(() => validateServer({ ...base, toolPolicy: [] }), /object/);

  const tools = ['retain', 'recall', 'reflect', 'delete_bank', 'clear_memories'].map(name => ({ name, inputSchema: { type: 'object' } }));
  const called = [];
  const backend = {
    getServerCapabilities: () => ({ tools: {} }),
    listTools: async () => ({ tools }),
    callTool: async params => { called.push(params.name); return { content: [{ type: 'text', text: 'ok' }] }; },
  };
  const connect = async policy => {
    saveConfig({ providers: [], mcpServers: [{ id: 'one', slug: 'memory', enabled: true, timeoutMs: 1000, ...(policy ? { toolPolicy: policy } : {}) }] });
    const pool = { metadata: new Map(), get: async () => backend };
    const gateway = createGatewayServer({ id: 'key', serverIds: ['one'] }, pool);
    const client = new Client({ name: 'fixture', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await gateway.connect(st); await client.connect(ct);
    return { client, gateway };
  };
  const names = async client => (await client.listTools()).tools.map(tool => tool.name).sort();
  try {
    let session = await connect(null);
    assert.equal((await names(session.client)).length, 5);
    await session.client.close(); await session.gateway.close();

    session = await connect({ allow: ['retain', 'recall', 'reflect'], deny: [] });
    assert.deepEqual(await names(session.client), ['memory__recall', 'memory__reflect', 'memory__retain']);
    await session.client.callTool({ name: 'memory__recall', arguments: {} });
    await assert.rejects(session.client.callTool({ name: 'memory__delete_bank', arguments: {} }), /not available/);
    assert.deepEqual(called, ['recall']);
    await session.client.close(); await session.gateway.close();

    session = await connect({ allow: [], deny: ['delete_bank', 'clear_memories'] });
    assert.deepEqual(await names(session.client), ['memory__recall', 'memory__reflect', 'memory__retain']);
    await assert.rejects(session.client.callTool({ name: 'memory__clear_memories', arguments: {} }), /not available/);
    await session.client.close(); await session.gateway.close();

    // Deny wins over allow.
    session = await connect({ allow: ['retain', 'delete_bank'], deny: ['delete_bank'] });
    assert.deepEqual(await names(session.client), ['memory__retain']);
    await session.client.close(); await session.gateway.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
