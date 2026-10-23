let parserModule;
const MAX_EVENT_BYTES = 1024 * 1024;

// Yield one decoded frame at a time so callers can await downstream backpressure.
async function* sseFrames(body) {
  if (!body) throw new Error('Upstream returned no event stream');
  const { createParser } = await (parserModule ||= import('eventsource-parser'));
  const decoder = new TextDecoder(); let queue = [], done = false;
  const parser = createParser({ maxBufferSize: MAX_EVENT_BYTES,
    onError(error) { if (error.type === 'max-buffer-size-exceeded') throw new Error('Upstream event exceeds 1 MiB'); },
    onEvent(event) {
      if (done) return;
      if (event.data.trim() === '[DONE]') { done = true; return; }
      if (!event.data.trim()) return;
      if (Buffer.byteLength(event.data) > MAX_EVENT_BYTES || queue.length >= 4096) throw new Error('Upstream event buffer exceeds its limit');
      let data; try { data = JSON.parse(event.data); } catch { throw new Error('Invalid JSON in upstream event stream'); }
      queue.push({ ...event, data });
    },
  });
  for await (const bytes of body) {
    // Fetch chunks are not constrained to an SSE event, or even a UTF-8 character.
    parser.feed(decoder.decode(bytes, { stream: true }));
    for (const event of queue) yield event;
    queue = []; if (done) return;
  }
  parser.feed(decoder.decode() + '\n\n');
  for (const event of queue) yield event;
}
async function readSSE(body, onData) { for await (const frame of sseFrames(body)) await onData(frame.data); }
const encodeSSE = (data, event) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
const writeSSE = (res, event) => res.write(encodeSSE(event, event.type));
module.exports = { sseFrames, readSSE, encodeSSE, writeSSE, MAX_EVENT_BYTES };
