const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-reliability-'));
process.env.DATA_DIR = directory;
process.env.ROUTER_KEY = 'fixture-key';
process.env.user = 'fixture';
process.env.password = 'fixture-password';
const router = require('../server');
const storage = require('../lib/storage');
const skills = require('../lib/skills');
let upstream, listener, origin, cookie, a, b, respond, calls;
const message = { model: 'default', max_tokens: 64, messages: [{ role: 'user', content: 'Hello' }] };
const completion = { id: 'test', model: 'test', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] };
const frame = data => `data: ${JSON.stringify(data)}\n\n`;
const configure = (providers = [a, b], routing = { mode: 'auto' }) => {
  router.health.clear(); calls = [];
  storage.saveConfig({ providers, activeId: providers[0]?.id, routing, sources: [], skills: [], mcpServers: [], accessKeys: [] });
  respond = (req, res) => res.end(JSON.stringify(completion));
};
const post = (body = message, endpoint = '/v1/chat/completions', signal) => fetch(origin + endpoint, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-key' },
  body: JSON.stringify(body), signal: signal || AbortSignal.timeout(5000),
});
const admin = (endpoint, body, method = 'POST') => fetch(origin + endpoint, {
  method: body === undefined ? 'GET' : method, headers: { cookie, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async response => ({ status: response.status, body: await response.json() }));

before(async () => {
  upstream = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    calls.push({ path: req.url, body: JSON.parse(text) });
    respond(req, res);
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  listener = router.app.listen(0, '127.0.0.1'); await once(listener, 'listening');
  origin = `http://127.0.0.1:${listener.address().port}`;
  const base = `http://127.0.0.1:${upstream.address().port}`;
  a = { id: 'a', name: 'Alpha', type: 'openai', baseUrl: base + '/a', defaultModel: 'one' };
  b = { ...a, id: 'b', name: 'Beta', baseUrl: base + '/b', defaultModel: 'two' };
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'fixture', password: 'fixture-password' }) });
  assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  await router.closeAllMcp();
  for (const server of [listener, upstream]) if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.rmSync(directory, { recursive: true, force: true });
});

test('Anthropic stream errors and truncation remain failures', async () => {
  for (const tail of [frame({ type: 'error', error: { message: 'overloaded' } }), '']) {
    configure([{ ...a, type: 'anthropic' }]);
    respond = (req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(
      frame({ type: 'message_start', message: { id: 'm', model: 'one' } }) +
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }) + tail); };
    const wire = await (await post({ ...message, stream: true })).text();
    assert.match(wire, /"error"/); assert.doesNotMatch(wire, /\[DONE\]/);
    assert.equal(router.health.get('a').fails, 1);
  }
});
test('native Anthropic requests preserve adaptive thinking', async () => {
  configure([{ ...a, type: 'anthropic' }]);
  respond = (req, res) => res.end(JSON.stringify({ id: 'm', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }));
  await (await post({ ...message, thinking: { type: 'adaptive' } }, '/v1/messages')).text();
  assert.deepEqual(calls[0].body.thinking, { type: 'adaptive' });
});
test('conversion preserves instruction priority, tool constraints, limits and URL images', () => {
  const result = router.openAIToAnthropicReq({ ...message, max_tokens: undefined, max_completion_tokens: 17,
    tool_choice: 'required', parallel_tool_calls: false, tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
    messages: [{ role: 'developer', content: 'Follow these instructions' }, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } }] }] });
  assert.equal(result.system, 'Follow these instructions'); assert.equal(result.max_tokens, 17);
  assert.deepEqual(result.tool_choice, { type: 'any', disable_parallel_tool_use: true });
  assert.equal(result.messages[0].content[0].source.url, 'https://example.invalid/image.png');
  assert.equal(router.anthropicToOpenAIResp({ content: [], stop_reason: 'max_tokens' }).choices[0].finish_reason, 'length');
});
test('malformed request responses do not penalize providers', async () => {
  configure(); respond = (req, res) => { res.statusCode = 400; res.end('{"error":{"message":"invalid request"}}'); };
  assert.equal((await post()).status, 400); assert.equal(router.health.has('a'), false); assert.equal(calls.length, 1);
});
test('cancelled streams do not penalize providers', async () => {
  configure([a]); let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  respond = (req, res) => { res.on('close', closed); res.setHeader('content-type', 'text/event-stream'); res.write(frame({ choices: [{ delta: { content: 'started' } }] })); };
  const abort = new AbortController(); const response = await post({ ...message, stream: true }, undefined, abort.signal);
  await response.body.getReader().read(); abort.abort(); await disconnected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(router.health.has('a'), false);
});
test('overload and invalid HTTP-200 responses reach a healthy fallback', async () => {
  for (const status of [529, 200]) {
    configure(); respond = (req, res) => {
      if (req.url.startsWith('/a/')) { res.statusCode = status; res.end(status === 200 ? '<html>bad upstream</html>' : '{"error":{"message":"overloaded"}}'); }
      else res.end(JSON.stringify(completion));
    };
    const response = await post(); assert.equal(response.status, 200); assert.equal((await response.json()).choices[0].message.content, 'OK'); assert.equal(calls.length, 2);
  }
});
test('retry hints control cooldown and survive downstream', async () => {
  configure([a]); respond = (req, res) => { res.statusCode = 429; res.setHeader('Retry-After', '300'); res.end('{"error":{"message":"rate limit"}}'); };
  const response = await post(); await response.text();
  assert.equal(response.headers.get('retry-after'), '300'); assert.ok(router.health.get('a').until - Date.now() > 290000);
});
test('preview matches routing and disabled aliases fail explicitly', async () => {
  configure(); router.markFailure('a');
  assert.equal((await admin('/api/route-now')).body.provider, 'Beta');
  const response = await post(); await response.text(); assert.equal(response.headers.get('x-llmrouter-provider'), 'Beta');
  configure([{ ...a, enabled: false }, b]); assert.equal((await post({ ...message, model: 'alpha/one' })).status, 404); assert.equal(calls.length, 0);
});
test('schedules use start-day semantics and validate zones and days', async () => {
  configure(); const schedule = { providerId: 'a', days: ['mon'], start: '23:00', end: '02:00', timezone: 'UTC' };
  assert.equal(router.matchSchedule([schedule], { minutes: 60, day: 'mon' }), null);
  assert.equal(router.matchSchedule([schedule], { minutes: 60, day: 'tue' }), schedule);
  assert.equal((await admin('/api/schedules', { ...schedule, timezone: 'Invalid/Zone' })).status, 400);
  assert.equal((await admin('/api/schedules', { ...schedule, days: ['noday'] })).status, 400);
  assert.equal((await admin('/api/schedules', { ...schedule, end: '23:00' })).status, 400);
});
test('SSE accepts CR-only framing', async () => {
  const events = []; await router.readSSE(new Response('data: {"text":"ok"}\r\rdata: [DONE]\r\r').body, event => events.push(event));
  assert.deepEqual(events, [{ text: 'ok' }]);
});
test('skill updates commit a complete generation for file/directory changes', async () => {
  configure([]);
  const raw = '---\nname: fixture\ndescription: Fixture\n---\n\nInstructions.';
  const source = { id: 'source', owner: 'fixture', repo: 'fixture', name: 'fixture', commit: 'one' };
  let index = { source, entries: [{ name: 'fixture', path: '', sha: 's1', bundleHash: 'one' }], tree: [{ path: 'SKILL.md', sha: 'skill', size: raw.length }, { path: 'references', sha: 'old', size: 3 }] };
  storage.writeJson(path.join(directory, 'marketplace/source.json'), index); storage.updateConfig(cfg => cfg.sources.push(source));
  const github = { request: async () => [], blob: async (source, sha) => Buffer.from(sha === 'skill' ? raw : 'reference') };
  const skill = await skills.installSkill('source', '', github);
  index = { ...index, entries: [{ ...index.entries[0], sha: 's2', bundleHash: 'two' }], tree: [index.tree[0], { path: 'references/info.txt', sha: 'new', size: 9 }] };
  storage.writeJson(path.join(directory, 'marketplace/source.json'), index);
  const updated = await skills.installSkill('source', '', github);
  assert.equal(updated.id, skill.id); assert.equal(updated.bundleHash, 'two');
  assert.ok(skills.skillFiles(updated).some(file => file.path === 'references/info.txt'));
  assert.equal(fs.readFileSync(path.join(directory, updated.portablePath || `skills/${skill.id}/files`, 'references/info.txt'), 'utf8'), 'reference');
});
test('MCP tool resource links round-trip through the namespace', async () => {
  const { createGatewayServer } = require('../lib/mcp');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  configure([]); storage.updateConfig(cfg => { cfg.mcpServers = [{ id: 'mock', slug: 'notes', enabled: true, timeoutMs: 1000 }]; });
  const backend = { callTool: async () => ({ content: [{ type: 'resource_link', uri: 'notes://one', name: 'Note' }] }), readResource: async params => ({ contents: [{ uri: params.uri, text: 'hello' }] }) };
  const gateway = createGatewayServer({ id: 'fixture', serverIds: null }, { get: async () => backend });
  const client = new Client({ name: 'fixture', version: '1' }); const [ct, st] = InMemoryTransport.createLinkedPair();
  await gateway.connect(st); await client.connect(ct);
  try {
    const result = await client.callTool({ name: 'notes__get' }); assert.equal(result.content[0].uri, 'giga://notes/notes://one');
    assert.equal((await client.readResource({ uri: result.content[0].uri })).contents[0].text, 'hello');
  } finally { await client.close(); await gateway.close(); }
});

test('startup stream errors can fall back but partial output never mixes providers', async () => {
  for (const partial of [false, true]) {
    configure();
    respond = (req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      if (req.url.startsWith('/a/')) res.end((partial ? frame({ choices: [{ delta: { content: 'Alpha' } }] }) : frame({ choices: [{ delta: { role: 'assistant' } }] })) + frame({ error: { message: 'overload' } }));
      else res.end(frame({ choices: [{ delta: { content: 'Beta' } }] }) + frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    };
    const response = await post({ ...message, stream: true });
    const wire = await response.text();
    assert.equal(calls.length, partial ? 1 : 2);
    assert.match(wire, partial ? /Alpha/ : /Beta/);
    if (partial) { assert.match(wire, /"error"/); assert.doesNotMatch(wire, /Beta|\[DONE\]/); }
    else assert.match(wire, /\[DONE\]/);
  }
});
test('timeouts bound headers, initial output and stalled streams', async () => {
  for (const stage of ['HEADERS', 'FIRST_TOKEN', 'STREAM_IDLE']) {
    configure(); process.env[`LLM_${stage}_TIMEOUT_MS`] = '100';
    respond = (req, res) => {
      if (req.url.startsWith('/a/')) {
        if (stage !== 'HEADERS') { res.setHeader('content-type', 'text/event-stream'); res.flushHeaders(); }
        if (stage === 'STREAM_IDLE') res.write(frame({ choices: [{ delta: { content: 'partial' } }] }));
      } else res.end(frame({ choices: [{ delta: { content: 'fallback' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    };
    try {
      const text = await (await post({ ...message, stream: true })).text();
      assert.equal(router.health.get('a').category, 'timeout');
      assert.equal(calls.length, stage === 'STREAM_IDLE' ? 1 : 2);
      assert.match(text, stage === 'STREAM_IDLE' ? /stalled/ : /fallback/);
    } finally { delete process.env[`LLM_${stage}_TIMEOUT_MS`]; }
  }
});
test('overall deadline does not restart with each fallback', async () => {
  configure(); process.env.LLM_REQUEST_TIMEOUT_MS = '250'; process.env.LLM_HEADERS_TIMEOUT_MS = '150';
  respond = () => {};
  try {
    const start = Date.now(), response = await post();
    assert.equal(response.status, 504); assert.match(await response.text(), /deadline/);
    assert.equal(calls.length, 2); assert.ok(Date.now() - start < 1500);
  } finally { delete process.env.LLM_REQUEST_TIMEOUT_MS; delete process.env.LLM_HEADERS_TIMEOUT_MS; }
});
test('shared account quota skips sibling models but leaves independent accounts eligible', async () => {
  configure([{ ...a, apiKey: 'same-account' }, { ...b, apiKey: 'same-account' }, { ...b, id: 'c', apiKey: 'independent' }]);
  respond = (req, res) => { if (req.url.startsWith('/a/')) { res.statusCode = 429; res.end('{"error":{"message":"quota exhausted"}}'); } else res.end(JSON.stringify(completion)); };
  assert.equal((await post()).status, 200); assert.equal(calls.length, 2);
  assert.equal(router.health.get('b').category, 'quota'); assert.equal(router.health.has('c'), false);
});
test('profiles and previews skip explicit incompatibilities while retaining unknowns', async () => {
  configure([{ ...a, capabilities: { vision: false } }, b], { mode: 'manual', profiles: [{ id: 'vision', providerIds: ['a', 'b'], requirements: { vision: true } }] });
  const body = { ...message, model: 'profile/vision' };
  const preview = await admin('/api/route-now', body);
  assert.equal(preview.body.provider, 'Beta'); assert.match(preview.body.skipped[0].reason, /Image/);
  const response = await post(body); await response.text(); assert.equal(response.headers.get('x-giga-provider-id'), 'b');
});
test('format-aware preview excludes translations that execution cannot preserve', async () => {
  configure([{ ...a, type: 'anthropic' }, b]);
  const body = { ...message, response_format: { type: 'json_object' } };
  const preview = await admin('/api/route-now?format=openai', body);
  assert.equal(preview.body.providerId, 'b'); assert.match(preview.body.skipped[0].reason, /response_format/);
  const response = await post(body); await response.text(); assert.equal(response.headers.get('x-giga-provider-id'), 'b');
  assert.equal(calls.length, 1);
});
test('Responses preserves native state, extensions and terminal events', async () => {
  configure([{ ...a, capabilities: { responses: true } }]);
  const body = { model: 'alpha/one', input: [{ role: 'user', content: 'Hello' }], previous_response_id: 'resp_prior', metadata: { fixture: 'yes' } };
  respond = (req, res) => res.end(JSON.stringify({ id: 'resp_one', status: 'completed', output: [], usage: { input_tokens: 3 } }));
  const data = await (await post(body, '/v1/responses')).json(); assert.equal(data.id, 'resp_one');
  assert.equal(calls[0].path, '/a/v1/responses'); assert.equal(calls[0].body.previous_response_id, 'resp_prior'); assert.deepEqual(calls[0].body.metadata, body.metadata);
  respond = (req, res) => res.end(frame({ type: 'response.created', response: { id: 'r' } }) + frame({ type: 'response.output_text.delta', delta: 'Hi' }) + frame({ type: 'response.completed', response: { id: 'r', output: [] } }));
  const wire = await (await post({ ...body, stream: true }, '/v1/responses')).text(); assert.match(wire, /response.completed/); assert.doesNotMatch(wire, /\[DONE\]/);
  configure([a]); assert.equal((await post(body, '/v1/responses')).status, 400); assert.equal(calls.length, 0);
});
test('native token counting forwards content and reports actual provider counts', async () => {
  configure([{ ...a, type: 'anthropic' }]);
  respond = (req, res) => res.end('{"input_tokens":42}');
  assert.deepEqual(await (await post(message, '/v1/messages/count_tokens')).json(), { input_tokens: 42 });
  assert.equal(calls[0].path, '/a/v1/messages/count_tokens');
});
test('provider diagnostics, Unicode headers and request histories use real inference', async () => {
  configure([{ ...a, name: '模型' }]);
  const response = await admin('/api/providers/a/test', {}); assert.equal(response.body.ok, true); assert.equal(calls.length, 1);
  const activity = (await admin('/api/activity')).body.recent[0];
  assert.equal(activity.attempts.length, 1); assert.equal(activity.status, 'ok'); assert.ok(activity.requestId); assert.ok(activity.durationMs >= 0);
  assert.equal((await admin('/api/providers', { ...a, name: 'bad\nheader' })).status, 400);
});
test('recovery permits only one concurrent half-open probe', async () => {
  configure(); router.health.set('a', { fails: 1, until: 0, trippedUntil: 0 });
  let arrive, finish;
  const arrived = new Promise(resolve => { arrive = resolve; });
  respond = (req, res) => { if (req.url.startsWith('/a/')) { finish = () => res.end(JSON.stringify(completion)); arrive(); } else res.end(JSON.stringify(completion)); };
  const first = post(); await arrived;
  const second = await post(); assert.equal(second.headers.get('x-giga-provider-id'), 'b'); await second.text();
  finish(); await (await first).text(); assert.equal(calls.filter(call => call.path.startsWith('/a/')).length, 1);
});

test('official OpenAI and Anthropic clients recognize translated completion and stream failure', async () => {
  const openai = new OpenAI({ apiKey: 'fixture-key', baseURL: origin + '/v1', maxRetries: 0 });
  const anthropic = new Anthropic({ apiKey: 'fixture-key', baseURL: origin, maxRetries: 0 });
  for (const failed of [false, true]) {
    configure([{ ...a, type: 'anthropic' }]);
    respond = (req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.end(frame({ type: 'message_start', message: { id: 'm', model: 'one', usage: { input_tokens: 2, output_tokens: 0 } } }) +
        frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Hello' } }) +
        (failed ? frame({ type: 'error', error: { message: 'fixture failure' } }) :
          frame({ type: 'content_block_stop', index: 0 }) + frame({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } }) + frame({ type: 'message_stop' })));
    };
    const chunks = [], collect = async () => { for await (const chunk of await openai.chat.completions.create({ ...message, stream: true, stream_options: { include_usage: true } })) chunks.push(chunk); };
    if (failed) await assert.rejects(collect(), /fixture failure/);
    else { await collect(); assert.equal(chunks.at(-2).choices[0].finish_reason, 'length'); assert.equal(chunks.at(-1).usage.total_tokens, 3); }
    assert.equal(chunks.flatMap(c => c.choices).map(c => c.delta.content || '').join(''), 'Hello');

    configure();
    respond = (req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.end(frame({ id: 'c', model: 'one', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }] }) +
        (failed ? frame({ error: { message: 'fixture failure' } }) : frame({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }) + frame({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } }) + 'data: [DONE]\n\n'));
    };
    const stream = anthropic.messages.stream(message);
    if (failed) await assert.rejects(stream.finalMessage(), /fixture failure/);
    else { const final = await stream.finalMessage(); assert.equal(final.stop_reason, 'max_tokens'); assert.equal(final.content[0].text, 'Hello'); assert.equal(final.usage.output_tokens, 1); }
  }
});

test('official Responses stream helper receives in-band errors after partial output', async () => {
  configure([{ ...a, capabilities: { responses: true } }]);
  const openai = new OpenAI({ apiKey: 'fixture-key', baseURL: origin + '/v1', maxRetries: 0 });
  respond = (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.end([
      { type: 'response.created', response: { id: 'r', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: 'm', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: 'Hello' },
      { type: 'response.failed', response: { id: 'r', status: 'failed', error: { message: 'fixture Responses failure' } } },
    ].map((data, sequence_number) => frame({ ...data, sequence_number })).join(''));
  };
  await assert.rejects(openai.responses.stream({ model: 'alpha/one', input: 'Hello' }).finalResponse(), /fixture Responses failure/);
});
