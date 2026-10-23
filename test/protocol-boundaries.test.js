const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../lib/llm/protocol');
const { matchSchedule, scheduleOccurrences } = require('../lib/llm/routing');
test('unsupported translated features are explicit while native extensions survive', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } } };
  assert.throws(() => p.openAIToAnthropicReq(body), /Cannot translate response_format/);
  assert.deepEqual(p.buildUpstream({ type: 'openai', defaultModel: 'm' }, body, 'openai').upstreamBody.response_format, body.response_format);
  assert.throws(() => p.anthropicToOpenAI({ messages: [{ role: 'user', content: [{ type: 'document', source: {} }] }] }), /Cannot translate/);
  assert.throws(() => p.anthropicToOpenAIResp({ content: [{ type: 'thinking', thinking: 'private', signature: 'signed' }] }), /Cannot translate upstream/);
  for (const detail of ['low', 'high']) {
    const content = [{ type: 'image_url', image_url: { url: 'https://example.invalid/image.png', detail } }];
    assert.throws(() => p.openAIToAnthropicReq({ messages: [{ role: 'user', content }] }), /Cannot translate image detail/);
  }
  assert.throws(() => p.openAIToAnthropicReq({ messages: [{ role: 'user', content: 'Hi', name: 'speaker' }] }), /Cannot translate named messages/);
  assert.throws(() => p.anthropicToOpenAI({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'Failed' }] }] }), /Cannot translate error-marked/);
  assert.throws(() => p.anthropicToOpenAIResp({ content: [], stop_reason: 'pause_turn' }), /Cannot translate upstream stop reason/);
});
test('Anthropic stream length, usage, tool arguments and truncation preserve outcomes', () => {
  const stream = p.anthropicStreamToOpenAI({ includeUsage: true }), output = [];
  for (const event of [
    { type: 'message_start', message: { id: 'm', model: 'm', usage: { input_tokens: 2, cache_read_input_tokens: 3 } } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't', name: 'get', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]) output.push(...stream.onEvent(event));
  stream.forceStop(output);
  assert.equal(output.at(-2).choices[0].finish_reason, 'length'); assert.equal(output.at(-1).usage.total_tokens, 9);
  const incomplete = p.anthropicStreamToOpenAI(); incomplete.onEvent({ type: 'message_start', message: { id: 'm' } });
  assert.throws(() => incomplete.forceStop([]), /before message_stop/);
});
test('schedule clocks cover Sunday rollover, DST gaps/folds and future starts', () => {
  const overnight = { providerId: 'p', timezone: 'UTC', days: ['sun'], start: '23:00', end: '02:00' };
  assert.equal(matchSchedule([overnight], new Date('2026-10-26T01:00:00Z')), overnight);
  assert.equal(matchSchedule([overnight], new Date('2026-10-26T02:00:00Z')), null);
  const dst = { providerId: 'p', timezone: 'America/New_York', start: '01:30', end: '01:45' };
  for (const instant of ['2026-11-01T05:35:00Z', '2026-11-01T06:35:00Z']) assert.equal(matchSchedule([dst], new Date(instant)), dst);
  assert.equal(matchSchedule([{ ...dst, start: '02:30', end: '02:45' }], new Date('2026-03-08T07:35:00Z')), null);
  assert.equal(scheduleOccurrences(overnight, new Date('2026-10-25T22:00:00Z')).starts[0], '2026-10-25T23:00:00.000Z');
});
