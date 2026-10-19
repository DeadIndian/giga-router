const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { createServer } = require('node:http');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmrouter-test-'));
process.env.DATA_DIR = dataDir;
process.env.ROUTER_KEY = 'test-router-key';
const { app, readSSE } = require('./server');

let router, upstream, origin, respond;
const requests = [];
const completion = {
  id: 'chatcmpl_test', model: 'gpt-6-astra',
  choices: [{ message: { role: 'assistant', content: 'ROUTER_OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 3 },
};
const prompt = { model: 'claude-sonnet-4-6', max_tokens: 128, messages: [{ role: 'user', content: 'Say ROUTER_OK' }] };
const frame = (data) => `data: ${JSON.stringify(data)}\n\n`;
const eventsOf = (text) => text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
const post = (endpoint, body, key = 'test-router-key') => fetch(origin + endpoint, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key },
  body: JSON.stringify(body), signal: AbortSignal.timeout(3000),
});

before(async () => {
  upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) });
    respond(res);
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    providers: [{
      id: 'agentrouter', name: 'AgentRouter', type: 'openai',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      apiKey: 'test-provider-key', defaultModel: 'gpt-6-astra',
      compat: { noReasoningEffortWithTools: true },
    }],
    activeId: 'agentrouter', routing: { mode: 'manual' },
  }));
  router = app.listen(0, '127.0.0.1');
  await once(router, 'listening');
  origin = `http://127.0.0.1:${router.address().port}`;
});

after(async () => {
  for (const server of [router, upstream]) {
    if (!server) continue;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('router authentication rejects requests before contacting a provider', async () => {
  const count = requests.length;
  const res = await post('/v1/messages', prompt, 'wrong-key');
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.type, 'authentication_error');
  assert.equal(requests.length, count);
});

test('Claude Code receives a non-streaming Anthropic message from an OpenAI upstream', async () => {
  respond = (res) => res.end(JSON.stringify(completion));
  const res = await post('/v1/messages', prompt);
  assert.equal(res.status, 200);
  const message = await res.json();
  assert.equal(message.type, 'message');
  assert.equal(message.content[0].text, 'ROUTER_OK');
  assert.equal(message.stop_reason, 'end_turn');
  assert.deepEqual(message.usage, { input_tokens: 12, output_tokens: 3 });
  assert.equal(requests.at(-1).url, '/v1/chat/completions');
  assert.equal(requests.at(-1).body.model, 'gpt-6-astra');
  assert.equal(requests.at(-1).headers.authorization, 'Bearer test-provider-key');
});

test('native fetch response bytes become a complete Anthropic text stream', async () => {
  respond = (res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.end(
      frame({ id: 'chatcmpl_test', model: 'gpt-6-astra', choices: [{ delta: { content: 'ROUTER_OK' } }] }) +
      frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
      frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }) + 'data: [DONE]\n\n'
    );
  };
  const res = await post('/v1/messages?beta=true', { ...prompt, stream: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const events = eventsOf(await res.text());
  assert.equal(events[0].type, 'message_start');
  assert.equal(events.find((e) => e.delta?.type === 'text_delta').delta.text, 'ROUTER_OK');
  assert.deepEqual(events.findLast((e) => e.usage).usage, { input_tokens: 12, output_tokens: 3 });
  assert.equal(events.at(-1).type, 'message_stop');
});

test('Claude Code tools, adaptive thinking, and tool results survive the HTTP round trip', async () => {
  respond = (res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.end(
      frame({ id: 'chatcmpl_tool', model: 'gpt-6-astra', choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call_read', type: 'function', function: { name: 'Read', arguments: '{"file_path":' } },
      ] } }] }) +
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"example.txt"}' } }] } }] }) +
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n'
    );
  };
  const body = {
    ...prompt, stream: true, thinking: { type: 'adaptive' },
    tools: [{ name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
    tool_choice: { type: 'any', disable_parallel_tool_use: true },
  };
  const res = await post('/v1/messages', body);
  const events = eventsOf(await res.text());
  const tool = events.find((e) => e.content_block?.type === 'tool_use')?.content_block;
  assert.equal(tool?.name, 'Read');
  const input = JSON.parse(events.filter((e) => e.delta?.type === 'input_json_delta').map((e) => e.delta.partial_json).join(''));
  assert.deepEqual(input, { file_path: 'example.txt' });
  assert.equal(events.find((e) => e.delta?.stop_reason).delta.stop_reason, 'tool_use');
  const sent = requests.at(-1).body;
  assert.equal(sent.tool_choice, 'required');
  assert.equal(sent.parallel_tool_calls, false);
  assert.equal(sent.reasoning_effort, 'none');

  respond = (res) => res.end(JSON.stringify(completion));
  const final = await post('/v1/messages', {
    ...prompt,
    messages: [...prompt.messages,
      { role: 'assistant', content: [{ ...tool, input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: 'file contents' }] },
    ],
  });
  assert.equal((await final.json()).content[0].text, 'ROUTER_OK');
  assert.deepEqual(requests.at(-1).body.messages.at(-1), { role: 'tool', tool_call_id: 'call_read', content: 'file contents' });
});

test('OpenCode non-streaming requests keep the OpenAI response format', async () => {
  respond = (res) => res.end(JSON.stringify(completion));
  const res = await post('/v1/chat/completions', prompt);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), completion);
});

test('OpenCode streaming requests pass through unchanged', async () => {
  const stream = frame({ choices: [{ delta: { content: 'OK' } }] }) + 'data: [DONE]\n\n';
  respond = (res) => { res.setHeader('content-type', 'text/event-stream'); res.end(stream); };
  const res = await post('/v1/chat/completions', { ...prompt, stream: true });
  assert.equal(await res.text(), stream);
});

test('explicit provider/model aliases route the requested model without mutating global routing', async () => {
  respond = (res) => res.end(JSON.stringify(completion));
  const response = await post('/v1/messages', { ...prompt, model: 'agentrouter/explicit-model' });
  assert.equal(response.status, 200);
  assert.equal(requests.at(-1).body.model, 'explicit-model');
  assert.equal(response.headers.get('x-llmrouter-reason'), 'provider:AgentRouter');
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(config.providers[0].defaultModel, 'gpt-6-astra');
  assert.equal(config.routing.mode, 'manual');
});

test('token counts are marked as estimates and reflect prompt size', async () => {
  const small = await post('/v1/messages/count_tokens', prompt).then((response) => response.json());
  const large = await post('/v1/messages/count_tokens', { ...prompt, system: 'A long instruction. '.repeat(100) }).then((response) => response.json());
  assert.equal(small.estimated, true);
  assert.ok(large.input_tokens > small.input_tokens);
});

test('HTTP provider failures return an Anthropic error', async () => {
  respond = (res) => { res.statusCode = 429; res.end(JSON.stringify({ error: { message: 'test quota exhausted' } })); };
  const res = await post('/v1/messages', prompt);
  assert.equal(res.status, 429);
  const data = await res.json();
  assert.equal(data.type, 'error');
  assert.match(data.error.message, /test quota exhausted/);
});

test('invalid upstream JSON returns an error without crashing the router', async () => {
  respond = (res) => res.end('<html>not a completion</html>');
  const res = await post('/v1/messages', prompt);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).type, 'error');
  assert.equal((await fetch(origin + '/api/ping')).status, 200);
});

test('upstream stream errors are not disguised as successful empty messages', async () => {
  respond = (res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.end(frame({ error: { message: 'test stream failed' } }));
  };
  const res = await post('/v1/messages', { ...prompt, stream: true });
  const events = eventsOf(await res.text());
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).error.message, /test stream failed/);
  assert.ok(!events.some((e) => e.type === 'message_stop'));
});

test('SSE parser handles split UTF-8 bytes, CRLF, multiline data, and final data without a newline', async () => {
  const bytes = new TextEncoder().encode(': ping\r\nevent: chunk\r\ndata: {"text":\r\ndata: "caf\u00e9"}\r\n\r\ndata: {"last":true}');
  const body = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } });
  const events = [];
  await readSSE(body, (event) => events.push(event));
  assert.deepEqual(events, [{ text: 'caf\u00e9' }, { last: true }]);
});

test('SSE parser stops at DONE and does not swallow callback failures or malformed JSON', async () => {
  const events = [];
  await readSSE(new Response('data: {"ok":true}\n\ndata: [DONE]\n\ndata: {"extra":true}\n\n').body, (e) => events.push(e));
  assert.deepEqual(events, [{ ok: true }]);
  await assert.rejects(readSSE(new Response('data: {}\n\n').body, () => { throw Error('conversion failed'); }), /conversion failed/);
  await assert.rejects(readSSE(new Response('data: invalid\n\n').body, () => {}));
});
