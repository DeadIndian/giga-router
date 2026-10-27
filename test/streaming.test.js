const test = require('node:test');
const assert = require('node:assert/strict');
const {
  anthropicToOpenAI,
  openAIToAnthropicResp,
  openaiStreamToAnthropic,
  buildUpstream,
} = require('../server');

function streamEvents(chunks, events = []) {
  const converter = openaiStreamToAnthropic();
  for (const chunk of chunks) {
    // Snapshot emitted batches just as serialization on the wire would.
    events.push(...structuredClone(converter.onData(chunk)));
  }
  const tail = [];
  converter.forceStop(tail);
  events.push(...structuredClone(tail));
  return events;
}

function assertCompleted(events, reason) {
  assert.equal(events[0]?.type, 'message_start');
  assert.equal(events.filter((ev) => ev.type === 'message_stop').length, 1);
  assert.equal(events.at(-1)?.type, 'message_stop', 'nothing may follow message_stop');
  const terminal = events.filter((ev) => ev.type === 'message_delta' && ev.delta?.stop_reason);
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].delta.stop_reason, reason);
  assert.equal(events.some((ev) => ev.type === 'error'), false);
}

function assertStreamFailure(chunks, expectedMessage) {
  const events = [];
  let thrown;
  try {
    streamEvents(chunks, events);
  } catch (error) {
    thrown = error;
  }
  const failure = thrown || events.find((ev) => ev.type === 'error')?.error;
  assert.ok(failure, 'upstream failure must throw or emit an Anthropic error');
  assert.equal(typeof failure.message, 'string');
  assert.ok(failure.message.length > 0);
  if (expectedMessage) assert.match(failure.message, expectedMessage);
  assert.equal(events.some((ev) => ev.type === 'message_delta' && ev.delta?.stop_reason), false,
    'failed streams must not claim a successful stop reason');
  assert.equal(events.some((ev) => ev.type === 'message_stop'), false,
    'failed streams must not claim successful completion');
}

test('text-to-tool transition closes the text block before starting the tool block', () => {
  const events = streamEvents([
    { id: 'chatcmpl_transition', model: 'gpt-6-astra', choices: [{ delta: { content: 'Checking the file.' } }] },
    { choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call_read', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
    ] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  const textStart = events.find((ev) => ev.type === 'content_block_start' && ev.content_block.type === 'text');
  const toolStart = events.find((ev) => ev.type === 'content_block_start' && ev.content_block.type === 'tool_use');
  assert.ok(textStart);
  assert.ok(toolStart);
  assert.notEqual(textStart.index, toolStart.index);
  const textStops = events.filter((ev) => ev.type === 'content_block_stop' && ev.index === textStart.index);
  assert.equal(textStops.length, 1, 'the prior text block must be closed exactly once');
  assert.ok(events.indexOf(textStops[0]) > events.indexOf(textStart));
  assert.ok(events.indexOf(textStops[0]) < events.indexOf(toolStart));
  const textDeltas = events.filter((ev) => ev.type === 'content_block_delta' && ev.index === textStart.index);
  assert.ok(textDeltas.every((ev) => events.indexOf(ev) < events.indexOf(textStops[0])));
  assert.equal(textStart.content_block.text + textDeltas.map((ev) => ev.delta.text).join(''), 'Checking the file.');
  assert.equal(events.filter((ev) => ev.type === 'content_block_stop' && ev.index === toolStart.index).length, 1);
  assertCompleted(events, 'tool_use');
});

test('parallel OpenAI tool indices retain distinct ids, names and interleaved JSON arguments', () => {
  const events = streamEvents([
    { id: 'chatcmpl_parallel', model: 'gpt-6-astra', choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call_read', type: 'function', function: { name: 'read_file', arguments: '{"path":' } },
      { index: 1, id: 'call_search', type: 'function', function: { name: 'search', arguments: '{"query":' } },
    ] } }] },
    { choices: [{ delta: { tool_calls: [
      { index: 1, function: { arguments: '"needle",' } },
      { index: 0, function: { arguments: '"a.txt"' } },
    ] } }] },
    { choices: [{ delta: { tool_calls: [
      { index: 0, function: { arguments: '}' } },
      { index: 1, function: { arguments: '"limit":2}' } },
    ] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  const starts = events.filter((ev) => ev.type === 'content_block_start');
  assert.equal(starts.length, 2, 'each OpenAI tool index needs its own Anthropic block');
  assert.equal(new Set(starts.map((ev) => ev.index)).size, 2);
  assert.ok(events.filter((ev) => ev.type === 'content_block_delta' || ev.type === 'content_block_stop')
    .every((ev) => starts.some((start) => start.index === ev.index)), 'all deltas and stops need a matching start');
  const tools = starts.map((start) => {
    assert.equal(start.content_block.type, 'tool_use');
    assert.ok(Number.isInteger(start.index) && start.index >= 0);
    const blockEvents = events.filter((ev) => ev.type.startsWith('content_block_') && ev.index === start.index);
    assert.equal(blockEvents[0], start);
    assert.equal(blockEvents.at(-1).type, 'content_block_stop');
    assert.equal(blockEvents.filter((ev) => ev.type === 'content_block_stop').length, 1);
    const deltas = blockEvents.slice(1, -1);
    for (const ev of deltas) {
      assert.equal(ev.type, 'content_block_delta');
      assert.equal(ev.delta.type, 'input_json_delta');
    }
    const json = deltas.map((ev) => ev.delta.partial_json).join('');
    return { ...start.content_block, input: json ? JSON.parse(json) : start.content_block.input };
  });
  tools.sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(tools, [
    { type: 'tool_use', id: 'call_read', name: 'read_file', input: { path: 'a.txt' } },
    { type: 'tool_use', id: 'call_search', name: 'search', input: { query: 'needle', limit: 2 } },
  ]);
  assertCompleted(events, 'tool_use');
});

test('streaming length finish_reason maps to max_tokens', () => {
  const events = streamEvents([
    { id: 'chatcmpl_length', model: 'gpt-6-astra', choices: [{ delta: { content: 'Partial answer' } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
  ]);
  assertCompleted(events, 'max_tokens');
});

for (const [name, message] of [
  ['text', { role: 'assistant', content: 'Partial answer' }],
  ['tool call', { role: 'assistant', content: null, tool_calls: [
    { id: 'call_read', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
  ] }],
]) {
  test(`nonstream length finish_reason maps to max_tokens for a ${name}`, () => {
    const result = openAIToAnthropicResp({
      id: 'chatcmpl_length', model: 'gpt-6-astra',
      choices: [{ index: 0, message, finish_reason: 'length' }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
    assert.equal(result.stop_reason, 'max_tokens');
    assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 3 });
  });
}

for (const [choice, expected] of [
  [{ type: 'auto' }, 'auto'],
  [{ type: 'any' }, 'required'],
  [{ type: 'tool', name: 'read_file' }, { type: 'function', function: { name: 'read_file' } }],
  [{ type: 'none' }, 'none'],
]) {
  test(`Anthropic tool_choice ${choice.type} maps to OpenAI tool_choice`, () => {
    const result = anthropicToOpenAI({
      model: 'claude-test', max_tokens: 32,
      messages: [{ role: 'user', content: 'Check the file.' }],
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
      tool_choice: choice,
    });
    assert.deepEqual(result.tool_choice, expected);
  });
}

for (const disabled of [true, false]) {
  test(`disable_parallel_tool_use=${disabled} maps to parallel_tool_calls=${!disabled}`, () => {
    const result = anthropicToOpenAI({
      model: 'claude-test', max_tokens: 32,
      messages: [{ role: 'user', content: 'Check the file.' }],
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto', disable_parallel_tool_use: disabled },
    });
    assert.equal(result.parallel_tool_calls, !disabled);
    assert.equal(result.tool_choice, 'auto');
  });
}

for (const [compat, effort] of [[false, 'medium'], [true, 'none']]) {
  test(`direct buildUpstream maps adaptive thinking with noReasoningEffortWithTools=${compat}`, () => {
    const { upstreamBody } = buildUpstream({
      type: 'openai', baseUrl: 'https://upstream.example/v1', apiKey: 'test-only',
      defaultModel: 'gpt-6-astra', compat: { noReasoningEffortWithTools: compat },
    }, {
      model: 'claude-test', max_tokens: 2048,
      messages: [{ role: 'user', content: 'Check the file.' }],
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
      thinking: { type: 'adaptive' },
    }, 'anthropic');
    assert.equal(upstreamBody.reasoning_effort, effort);
    assert.equal(upstreamBody.tools[0].function.name, 'read_file');
  });
}

for (const [name, prefix] of [
  ['before content', []],
  ['after partial content', [{ choices: [{ delta: { content: 'Starting' } }] }]],
]) {
  test(`in-band upstream SSE error ${name} does not become end_turn`, () => {
    assertStreamFailure([
      ...prefix,
      { error: { type: 'api_error', message: 'Fixture upstream unavailable' } },
    ], /Fixture upstream unavailable/);
  });
}

test('nonstream in-band upstream error does not become a successful message', () => {
  let result;
  let thrown;
  try {
    result = openAIToAnthropicResp({ error: { type: 'api_error', message: 'Fixture upstream unavailable' } });
  } catch (error) {
    thrown = error;
  }
  const failure = thrown || (result?.type === 'error' && result.error);
  assert.ok(failure, 'upstream error must throw or return an Anthropic error');
  assert.match(failure.message, /Fixture upstream unavailable/);
  assert.notEqual(result?.type, 'message');
});

for (const [name, chunks] of [
  ['empty stream', []],
  ['role-only stream', [{ choices: [{ delta: { role: 'assistant', content: '' } }] }]],
  ['unfinished text', [{ choices: [{ delta: { content: 'Partial answer' } }] }]],
  ['unfinished tool arguments', [{ choices: [{ delta: { tool_calls: [
    { index: 0, id: 'call_incomplete', type: 'function', function: { name: 'read_file', arguments: '{"path":' } },
  ] } }] }]],
]) {
  test(`forceStop rejects ${name} without a finish_reason instead of faking success`, () => {
    assertStreamFailure(chunks);
  });
}

test('usage-only chunk after finish_reason preserves token counts before a single message_stop', () => {
  const events = streamEvents([
    { id: 'chatcmpl_usage', model: 'gpt-6-astra', choices: [{ delta: { content: 'OK' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { id: 'chatcmpl_usage', model: 'gpt-6-astra', choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } },
  ]);
  assertCompleted(events, 'end_turn');
  assert.equal(events.filter((ev) => ev.type === 'content_block_start').length, 1,
    'usage-only chunks must not create content blocks');
  const usage = {};
  for (const ev of events) {
    if (ev.type === 'message_start') Object.assign(usage, ev.message.usage);
    if (ev.type === 'message_delta') Object.assign(usage, ev.usage);
  }
  assert.deepEqual({ input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
    { input_tokens: 11, output_tokens: 4 });
});
