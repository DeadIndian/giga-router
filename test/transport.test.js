const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { write } = require('../lib/llm/proxy');
const { readSSE } = require('../lib/llm/sse');
test('transport waits for a slow reader and cancellation interrupts backpressure', async () => {
  const sink = new PassThrough({ highWaterMark: 8 }), signal = new AbortController();
  let completed = false;
  const pending = write(sink, 'a'.repeat(1024), signal.signal).then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false, 'a blocked write must not consume more upstream events');
  sink.resume(); await pending; assert.equal(completed, true); sink.destroy();
  const blocked = new PassThrough({ highWaterMark: 8 });
  const cancelled = write(blocked, 'b'.repeat(1024), signal.signal); signal.abort();
  await assert.rejects(cancelled, { name: 'AbortError' }); blocked.destroy();
});
test('oversized complete and unterminated SSE events fail within the buffer limit', async () => {
  for (const end of ['', '\n\n']) {
    const body = new Response('data: ' + 'x'.repeat(1024 * 1024 + 32) + end).body;
    await assert.rejects(readSSE(body, () => {}), /exceed|limit/i);
  }
});
