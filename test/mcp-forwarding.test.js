const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

test('MCP forwards scoped embedded resources, cached discovery, progress and cancellation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-mcp-forward-'));
  process.env.DATA_DIR = directory;
  const { saveConfig } = require('../lib/storage');
  const { createGatewayServer } = require('../lib/mcp');
  saveConfig({ providers: [], mcpServers: [{ id: 'one', slug: 'notes', enabled: true, timeoutMs: 1000 }, { id: 'two', slug: 'private', enabled: true, timeoutMs: 1000 }] });
  let lists = 0, fail = false, resource, started;
  const backend = {
    getServerCapabilities: () => ({ tools: {}, prompts: {}, resources: {} }),
    listTools: async () => { lists++; if (fail) throw new Error('fixture offline'); return { tools: [{ name: 'get', inputSchema: { type: 'object' } }] }; },
    getPrompt: async () => ({ messages: [{ role: 'user', content: { type: 'resource', resource: { uri: 'notes://one', text: 'embedded' } } }] }),
    readResource: (...args) => resource(...args),
    callTool: async (params, schema, options) => { await options.onprogress?.({ progress: 1, total: 1 }); return { content: [{ type: 'resource_link', uri: 'notes://one', name: 'note' }], structuredContent: { uri: 'opaque://value' } }; },
  };
  const pool = { metadata: new Map(), get: async server => { assert.equal(server.id, 'one'); return backend; } };
  const gateway = createGatewayServer({ id: 'key', serverIds: ['one'] }, pool);
  const client = new Client({ name: 'fixture', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await gateway.connect(st); await client.connect(ct);
  try {
    assert.equal((await client.listTools()).tools[0].name, 'notes__get');
    await client.listTools(); assert.equal(lists, 1);
    for (const value of pool.metadata.values()) value.at = 0;
    fail = true; const stale = await client.listTools();
    assert.equal(stale.tools[0].name, 'notes__get'); assert.equal(stale._meta['giga-router/discovery'][0].status, 'unavailable');
    const prompt = await client.getPrompt({ name: 'notes__p' });
    assert.equal(prompt.messages[0].content.resource.uri, 'giga://notes/notes://one');
    const updates = [];
    const tool = await client.callTool({ name: 'notes__get' }, undefined, { onprogress: value => updates.push(value) });
    assert.equal(tool.content[0].uri, 'giga://notes/notes://one'); assert.equal(tool.structuredContent.uri, 'opaque://value');
    assert.equal(updates[0].progress, 1);
    await assert.rejects(client.readResource({ uri: 'giga://private/notes://one' }), /not available/);
    const ready = new Promise(resolve => { started = resolve; });
    let cancelled;
    const stopped = new Promise(resolve => { cancelled = resolve; });
    resource = (params, options) => new Promise((resolve, reject) => {
      started(); options.signal.addEventListener('abort', () => { cancelled(); reject(options.signal.reason); }, { once: true });
    });
    const abort = new AbortController();
    const reading = client.readResource({ uri: 'giga://notes/notes://one' }, { signal: abort.signal });
    await ready; abort.abort(); await assert.rejects(reading); await stopped;
  } finally { await client.close(); await gateway.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
