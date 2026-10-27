// provider-quirk tests — run: node --test test/provider.test.js
const assert = require('assert');
const { buildUpstream } = require('../server');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const base = {
  id: 'p', name: 'p', type: 'openai', baseUrl: 'https://x/v1',
  apiKey: 'sk-test', defaultModel: 'm',
};

const TOOLS = [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }];

console.log('\nuser-agent');
t('no userAgent -> no header', () => {
  const { headers } = buildUpstream({ ...base }, { messages: [] }, 'openai');
  assert.strictEqual(headers['user-agent'], undefined);
});
t('userAgent set -> header present', () => {
  const { headers } = buildUpstream({ ...base, userAgent: 'claude-cli/2.1.220 (external, cli)' }, { messages: [] }, 'openai');
  assert.strictEqual(headers['user-agent'], 'claude-cli/2.1.220 (external, cli)');
});
t('blank userAgent ignored', () => {
  const { headers } = buildUpstream({ ...base, userAgent: '   ' }, { messages: [] }, 'openai');
  assert.strictEqual(headers['user-agent'], undefined);
});

console.log('\ncustom headers');
t('custom headers merged', () => {
  const { headers } = buildUpstream({ ...base, headers: { 'x-foo': 'bar' } }, { messages: [] }, 'openai');
  assert.strictEqual(headers['x-foo'], 'bar');
});
t('custom header cannot drop auth', () => {
  const { headers } = buildUpstream({ ...base, headers: { 'x-foo': 'bar' } }, { messages: [] }, 'openai');
  assert.strictEqual(headers.authorization, 'Bearer sk-test');
});

console.log('\nnoReasoningEffortWithTools');
t('flag off -> reasoning_effort preserved', () => {
  const body = { messages: [], tools: TOOLS, reasoning_effort: 'medium' };
  const { upstreamBody } = buildUpstream({ ...base }, body, 'openai');
  assert.strictEqual(upstreamBody.reasoning_effort, 'medium');
});
t('singleToolCall disables parallel tool calls without altering the caller body', () => {
  const body = { messages: [], tools: TOOLS, parallel_tool_calls: true };
  const { upstreamBody } = buildUpstream({ ...base, compat: { singleToolCall: true } }, body, 'openai');
  assert.strictEqual(upstreamBody.parallel_tool_calls, false);
  assert.strictEqual(body.parallel_tool_calls, true);
});
t('flag on + tools + effort -> forced to none', () => {
  const body = { messages: [], tools: TOOLS, reasoning_effort: 'medium' };
  const { upstreamBody } = buildUpstream({ ...base, compat: { noReasoningEffortWithTools: true } }, body, 'openai');
  assert.strictEqual(upstreamBody.reasoning_effort, 'none');
});
t('flag on but no tools -> effort preserved', () => {
  const body = { messages: [], reasoning_effort: 'medium' };
  const { upstreamBody } = buildUpstream({ ...base, compat: { noReasoningEffortWithTools: true } }, body, 'openai');
  assert.strictEqual(upstreamBody.reasoning_effort, 'medium');
});
t('flag on, tools, no effort -> adds nothing', () => {
  const body = { messages: [], tools: TOOLS };
  const { upstreamBody } = buildUpstream({ ...base, compat: { noReasoningEffortWithTools: true } }, body, 'openai');
  assert.strictEqual(upstreamBody.reasoning_effort, undefined);
});
t('converted anthropic thinking+tools -> none (the real bug path)', () => {
  // anthropicToOpenAI injects reasoning_effort='medium' when thinking is enabled,
  // so the fix must run after conversion or it never fires.
  const body = {
    model: 'claude-opus-4-8', max_tokens: 100,
    thinking: { type: 'enabled', budget_tokens: 2048 },
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'f', input_schema: { type: 'object' } }],
  };
  const { upstreamBody } = buildUpstream({ ...base, compat: { noReasoningEffortWithTools: true } }, body, 'anthropic');
  assert.ok(upstreamBody.tools?.length, 'tools should survive conversion');
  assert.strictEqual(upstreamBody.reasoning_effort, 'none');
});
t('converted anthropic thinking+no tools -> effort kept', () => {
  const body = {
    model: 'claude-opus-4-8', max_tokens: 100,
    thinking: { type: 'enabled', budget_tokens: 2048 },
    messages: [{ role: 'user', content: 'hi' }],
  };
  const { upstreamBody } = buildUpstream({ ...base, compat: { noReasoningEffortWithTools: true } }, body, 'anthropic');
  assert.strictEqual(upstreamBody.reasoning_effort, 'medium');
});

console.log('\nsame-format passthrough');
t('openai->openai keeps body, swaps model', () => {
  const { same, upstreamBody } = buildUpstream({ ...base }, { messages: [], model: 'ignored' }, 'openai');
  assert.strictEqual(same, true);
  assert.strictEqual(upstreamBody.model, 'm');
});
t('anthropic->anthropic uses x-api-key', () => {
  const { same, headers } = buildUpstream({ ...base, type: 'anthropic' }, { messages: [] }, 'anthropic');
  assert.strictEqual(same, true);
  assert.strictEqual(headers['x-api-key'], 'sk-test');
  assert.strictEqual(headers.authorization, undefined);
});
t('cross format sets same=false', () => {
  const { same } = buildUpstream({ ...base }, { messages: [] }, 'anthropic');
  assert.strictEqual(same, false);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
