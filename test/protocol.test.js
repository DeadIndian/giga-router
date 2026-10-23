// Self-check: sanitize + translation logic. Run: node --test test/protocol.test.js
const assert = require('assert');
const S = require('../server');

// sanitize: adaptive -> enabled with budget
{
  const b = { thinking: { type: 'adaptive' } };
  S.sanitizeThinking(b, { adaptiveToEnabled: true });
  assert.deepStrictEqual(b.thinking, { type: 'enabled', budget_tokens: 1024 });
}
{ const b = { thinking: { type: 'adaptive', budget_tokens: 500 } };
  S.sanitizeThinking(b, { adaptiveToEnabled: true });
  assert.strictEqual(b.thinking.budget_tokens, 1024); }
{ const b = { thinking: { type: 'enabled', budget_tokens: 2048 } };
  S.sanitizeThinking(b);
  assert.deepStrictEqual(b.thinking, { type: 'enabled', budget_tokens: 2048 }); } // untouched
{ const b = {};
  S.sanitizeThinking(b);
  assert.strictEqual(b.thinking, undefined); }

// anthropicToOpenAI: system, text, tool_use, tool_result
{
  const out = S.anthropicToOpenAI({
    model: 'claude-sonnet-5', system: 'be brief', max_tokens: 100,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [
        { type: 'text', text: 'calling' },
        { type: 'tool_use', id: 'tu1', name: 'get_weather', input: { city: 'Delhi' } } ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'sunny' },
        { type: 'text', text: 'thanks' } ] },
    ],
    tools: [{ name: 'get_weather', description: 'weather', input_schema: { type: 'object' } }],
    stream: true,
  });
  assert.deepStrictEqual(out.messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'calling' }],
      tool_calls: [{ id: 'tu1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Delhi"}' } }] },
    { role: 'tool', tool_call_id: 'tu1', content: 'sunny' },
    { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
  ]);
  assert.strictEqual(out.tools[0].function.name, 'get_weather');
  assert.strictEqual(out.max_tokens, 100);
  assert.strictEqual(out.stream, true);
}

// openAIToAnthropicReq: system, tool calls, merge consecutive
{
  const out = S.openAIToAnthropicReq({
    model: 'gpt-5',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"x":1}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '42' },
      { role: 'user', content: 'next' },
    ],
  });
  assert.deepStrictEqual(out.messages, [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'f', input: { x: 1 } }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'c1', content: '42' },
      { type: 'text', text: 'next' } ] }, // merged consecutive user messages
  ]);
  assert.strictEqual(out.system, 'sys');
  assert.strictEqual(out.max_tokens, 4096);
}

// openAIToAnthropicResp: text + tool call
{
  const out = S.openAIToAnthropicResp({
    id: 'abc', model: 'gpt-5',
    choices: [{ message: { role: 'assistant', content: 'hi', tool_calls: [
      { id: 'c1', function: { name: 'f', arguments: '{"x":1}' } } ] } }],
    usage: { prompt_tokens: 3, completion_tokens: 5 },
  });
  assert.deepStrictEqual(out.content, [
    { type: 'text', text: 'hi' },
    { type: 'tool_use', id: 'c1', name: 'f', input: { x: 1 } },
  ]);
  assert.strictEqual(out.stop_reason, 'tool_use');
  assert.strictEqual(out.usage.input_tokens, 3);
}

// anthropicToOpenAIResp
{
  const out = S.anthropicToOpenAIResp({
    id: 'msg_1', model: 'claude', content: [{ type: 'text', text: 'yo' }],
    stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 4 },
  });
  assert.strictEqual(out.choices[0].message.content, 'yo');
  assert.strictEqual(out.choices[0].finish_reason, 'stop');
  assert.strictEqual(out.usage.total_tokens, 6);
}

// openaiStreamToAnthropic: text stream then finish
{
  const conv = S.openaiStreamToAnthropic();
  const ev1 = conv.onData({ id: 'x', model: 'gpt', choices: [{ delta: { content: 'Hel' } }] });
  assert.strictEqual(ev1[0].type, 'message_start');
  assert.strictEqual(ev1[1].type, 'content_block_start');
  assert.strictEqual(ev1[1].content_block.type, 'text');
  assert.deepStrictEqual(ev1[2].delta, { type: 'text_delta', text: 'Hel' });
  const ev2 = conv.onData({ choices: [{ delta: { content: 'lo' } }] });
  assert.deepStrictEqual(ev2[0].delta, { type: 'text_delta', text: 'lo' });
  const ev3 = conv.onData({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  conv.forceStop(ev3);
  assert.strictEqual(ev3.at(-1).type, 'message_stop');
  assert.strictEqual(ev3.at(-2).delta.stop_reason, 'end_turn');
  const tail = []; conv.forceStop(tail);
  assert.strictEqual(tail.length, 0); // already finished
}

// openaiStreamToAnthropic: tool call stream
{
  const conv = S.openaiStreamToAnthropic();
  conv.onData({ id: 'x', model: 'gpt', choices: [{ delta: {} }] });
  const ev = conv.onData({ choices: [{ delta: { tool_calls: [
    { id: 'c1', function: { name: 'f', arguments: '{"a"' } } ] } }] });
  assert.deepStrictEqual(ev, []); // tool arguments are buffered independently
  conv.onData({ choices: [{ delta: { tool_calls: [{ function: { arguments: ':1}' } }] } }] });
  conv.onData({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  conv.forceStop(ev);
  assert.strictEqual(ev[0].type, 'content_block_start');
  assert.strictEqual(ev[0].content_block.type, 'tool_use');
  assert.strictEqual(ev[0].content_block.name, 'f');
  assert.deepStrictEqual(ev[1].delta, { type: 'input_json_delta', partial_json: '{"a":1}' });
  assert.strictEqual(ev.at(-2).delta.stop_reason, 'tool_use');
}

// openaiStreamToAnthropic: an interrupted upstream must not fake success
{
  const conv = S.openaiStreamToAnthropic();
  conv.onData({ id: 'x', model: 'gpt', choices: [{ delta: { content: 'z' } }] });
  assert.throws(() => conv.forceStop([]), /ended before finish_reason/);
}

// anthropicStreamToOpenAI: text + tool
{
  const conv = S.anthropicStreamToOpenAI();
  const c1 = conv.onEvent({ type: 'message_start', message: { id: 'm1', model: 'claude' } });
  assert.strictEqual(c1[0].choices[0].delta.role, 'assistant');
  const c2 = conv.onEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ab' } });
  assert.strictEqual(c2[0].choices[0].delta.content, 'ab');
  const c3 = conv.onEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'f' } });
  assert.deepStrictEqual(c3[0].choices[0].delta.tool_calls[0].function, { name: 'f', arguments: '' });
  const c4 = conv.onEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"x":' } });
  assert.strictEqual(c4[0].choices[0].delta.tool_calls[0].function.arguments, '{"x":');
  conv.onEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '1}' } });
  conv.onEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  conv.onEvent({ type: 'message_stop' });
  const c5 = []; conv.forceStop(c5);
  assert.strictEqual(c5.at(-1).choices[0].finish_reason, 'tool_calls');
}

// endpointUrl: with and without trailing /v1
assert.strictEqual(S.endpointUrl({ type: 'openai', baseUrl: 'https://x.example/v1' }), 'https://x.example/v1/chat/completions');
assert.strictEqual(S.endpointUrl({ type: 'anthropic', baseUrl: 'https://x.example' }), 'https://x.example/v1/messages');
assert.strictEqual(S.endpointUrl({ type: 'openai', baseUrl: 'https://x.example/v1/' }), 'https://x.example/v1/chat/completions');

console.log('all tests passed');
