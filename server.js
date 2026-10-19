// Giga Router — the existing Anthropic/OpenAI routing engine, with a unified
// MCP gateway, skills library, and GitHub-backed marketplace.
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { loadConfig, saveConfig } = require('./lib/storage');
const { mountAuth, sessionAuth, gatewayAuth, ROUTER_KEY } = require('./lib/auth');
const { mountSkills } = require('./lib/skills');
const { seedDefaultMarketplaces } = require('./lib/marketplace-defaults');
const mcpServices = require('./lib/mcp');
const { mountMcp, closeAllMcp, closeKeySessions, notifyMcpClients } = mcpServices;
const { mountIntegrations } = require('./lib/mcp-integrations');
const { recordActivity, activitySnapshot } = require('./lib/activity');
const { httpUrl, inputError, headerMap, maskedMap } = require('./lib/validation');

const PORT = process.env.PORT || 3002;

// ---------- routing: auto mode + time-window overrides ----------
// routing = {
//   mode: 'auto' | 'manual',
//   autoOrder: [providerId|name, ...],   // priority order for auto
//   schedules: [{ id, providerId, start:'HH:MM', end:'HH:MM',
//                 days:['mon'..], timezone:'Asia/Kolkata', label }]
// }
function routingOf(cfg) {
  const r = cfg.routing || {};
  return {
    mode: ['auto', 'manual'].includes(r.mode) ? r.mode : 'auto',
    autoOrder: Array.isArray(r.autoOrder) ? r.autoOrder : [],
    schedules: Array.isArray(r.schedules) ? r.schedules : [],
  };
}

const toMinutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = +m[1], min = +m[2];
  return h > 23 || min > 59 ? null : h * 60 + min;
};

// current { minutes, day } in a named IANA zone (falls back to UTC if unknown)
function nowInZone(tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date());
  } catch {
    return nowInZone('UTC');
  }
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { minutes: +hour * 60 + +get('minute'), day: get('weekday').toLowerCase().slice(0, 3) };
}

// first schedule window containing "now", or null
function matchSchedule(schedules, now) {
  for (const s of schedules) {
    if (!s || !s.providerId) continue;
    const cur = now || nowInZone(s.timezone);
    if (Array.isArray(s.days) && s.days.length && !s.days.includes(cur.day)) continue;
    const start = toMinutes(s.start), end = toMinutes(s.end);
    if (start == null || end == null) continue;
    // end < start means the window wraps past midnight
    const inWindow = start <= end
      ? cur.minutes >= start && cur.minutes < end
      : cur.minutes >= start || cur.minutes < end;
    if (inWindow) return s;
  }
  return null;
}

// which provider(s) may serve this request, in preference order
function resolveCandidates(cfg, now) {
  cfg = { ...cfg, providers: cfg.providers.filter((provider) => provider.enabled !== false) };
  const routing = routingOf(cfg);
  const byId = new Map(cfg.providers.map((p) => [p.id, p]));
  const byName = new Map(cfg.providers.map((p) => [p.name.toLowerCase(), p]));
  const lookup = (key) => byId.get(key) || byName.get(String(key || '').toLowerCase());

  // 1. manual mode → an explicit human pin beats every automation
  if (routing.mode === 'manual') {
    const p = byId.get(cfg.activeId);
    return { providers: p ? [p] : [], reason: 'manual' };
  }

  // 2. a scheduled window overrides auto routing
  const sched = matchSchedule(routing.schedules, now);
  if (sched) {
    const p = lookup(sched.providerId);
    if (p) {
      // Default: the window is the whole chain (determinism — a scheduled provider
      // that is down fails the request). fallbackOnFailure opts into degrading
      // gracefully: try the pinned provider first, then the normal auto chain.
      if (sched.fallbackOnFailure) {
        const rest = [];
        for (const key of routing.autoOrder) {
          const q = lookup(key);
          if (q && q.id !== p.id && !rest.includes(q)) rest.push(q);
        }
        for (const q of cfg.providers) if (q.id !== p.id && !rest.includes(q)) rest.push(q);

        // A pinned provider that has failed TRIP_AFTER times in a row is out of
        // the chain entirely, so the window stops paying a failed round-trip on
        // every request. The chain is recomputed from scratch each time, so the
        // provider returns automatically once the trip expires.
        if (isTripped(p)) {
          return {
            providers: rest,
            reason: `schedule:${sched.label || p.name}:tripped`,
            scheduled: sched,
            trippedProvider: p,
          };
        }
        return { providers: [p, ...rest], reason: `schedule:${sched.label || p.name}`, scheduled: sched };
      }
      return { providers: [p], reason: `schedule:${sched.label || p.name}`, scheduled: sched };
    }
  }

  // 3. auto mode → ordered list, then active, then anything left
  const ordered = [];
  for (const key of routing.autoOrder) {
    const p = lookup(key);
    if (p && !ordered.includes(p)) ordered.push(p);
  }
  const active = byId.get(cfg.activeId);
  if (active && !ordered.includes(active)) ordered.push(active);
  for (const p of cfg.providers) if (!ordered.includes(p)) ordered.push(p);
  return { providers: ordered, reason: 'auto' };
}

// ---------- provider health: cooldown + consecutive-failure trip ----------
// Two distinct mechanisms:
//  - cooldown: a short 60s bench after any retryable failure, so auto mode stops
//    retrying a provider that just failed on every single request.
//  - trip: after `tripAfter` CONSECUTIVE failures a provider is taken out of the
//    chain for `tripCooldownMs`. This is what makes a scheduled window stop
//    serving from a provider that is persistently down (e.g. gpt-6-astra with an
//    empty budget pool) instead of paying a failed round-trip on every request.
const health = new Map();
const FAIL_COOLDOWN_MS = 60_000;
const TRIP_AFTER = 5;
const TRIP_COOLDOWN_MS = 30 * 60_000;

const entryOf = (id) => health.get(id) || { fails: 0, until: 0, trippedUntil: 0, at: 0 };
const markFailure = (id) => {
  const e = entryOf(id);
  const fails = e.fails + 1;
  const tripped = fails >= TRIP_AFTER;
  health.set(id, {
    fails,
    until: Date.now() + FAIL_COOLDOWN_MS,
    trippedUntil: tripped ? Date.now() + TRIP_COOLDOWN_MS : e.trippedUntil || 0,
    at: Date.now(),
  });
  return tripped;
};
const markSuccess = (id) => health.delete(id);
// cooling = short bench (still in the chain); tripped = out of the chain entirely
const isCooling = (p) => {
  const e = health.get(p.id);
  return !!e && Date.now() < e.until;
};
const isTripped = (p) => {
  const e = health.get(p.id);
  return !!e && Date.now() < e.trippedUntil;
};
const healthy = (p) => !isCooling(p) && !isTripped(p);
const healthSnapshot = (providers) => providers.map((p) => {
  const e = health.get(p.id) || {};
  const now = Date.now();
  return {
    id: p.id,
    name: p.name,
    fails: e.fails || 0,
    cooling: !!e.until && now < e.until,
    coolingUntil: e.until && now < e.until ? e.until : null,
    tripped: !!e.trippedUntil && now < e.trippedUntil,
    trippedUntil: e.trippedUntil && now < e.trippedUntil ? e.trippedUntil : null,
  };
});

// ---------- sanitize (root fix for the adaptive-thinking 400) ----------
function sanitizeThinking(body) {
  const t = body?.thinking;
  if (t && t.type === 'adaptive') {
    body.thinking = { type: 'enabled', budget_tokens: Math.max(1024, t.budget_tokens || 1024) };
  }
  return body;
}

// ---------- shared helpers ----------
const toArray = (c) =>
  Array.isArray(c) ? c : typeof c === 'string' ? [{ type: 'text', text: c }] : c ? [c] : [];
const contentToText = (c) =>
  Array.isArray(c) ? c.map((b) => b.text || '').join('') : c || '';

function mergeConsecutive(messages) {
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = [...toArray(last.content), ...toArray(m.content)];
    else out.push({ role: m.role, content: [...toArray(m.content)] });
  }
  return out;
}

// ---------- Anthropic request -> OpenAI request ----------
function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    messages.push({ role: 'system', content: contentToText(body.system) });
  }
  for (const m of body.messages || []) {
    const blocks = toArray(m.content);
    if (m.role === 'assistant') {
      const content = [];
      const tool_calls = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use')
          tool_calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } });
      }
      const msg = { role: 'assistant', content: content.length ? content : null };
      if (tool_calls.length) msg.tool_calls = tool_calls;
      messages.push(msg);
    } else {
      // user: text / image / tool_result blocks
      const content = [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: contentToText(b.content) });
        } else if (b.type === 'text') {
          content.push({ type: 'text', text: b.text });
        } else if (b.type === 'image' && b.source?.type === 'base64') {
          content.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
        }
      }
      if (content.length) messages.push({ role: 'user', content });
    }
  }
  const out = { model: body.model, max_tokens: body.max_tokens || 4096, messages };
  if (body.tools?.length)
    out.tools = body.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object' } },
    }));
  if (body.tool_choice) {
    const choice = body.tool_choice;
    out.tool_choice = choice.type === 'tool'
      ? { type: 'function', function: { name: choice.name } }
      : choice.type === 'any' ? 'required' : choice.type;
    if (choice.disable_parallel_tool_use != null) out.parallel_tool_calls = !choice.disable_parallel_tool_use;
  }
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  if (body.stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  if (['enabled', 'adaptive'].includes(body.thinking?.type)) out.reasoning_effort = 'medium';
  return out;
}

// ---------- OpenAI request -> Anthropic request ----------
function openAIToAnthropicReq(body) {
  const messages = [];
  let system = '';
  for (const m of body.messages || []) {
    if (m.role === 'system') {
      system += (system ? '\n' : '') + contentToText(m.content);
    } else if (m.role === 'tool') {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: contentToText(m.content) }] });
    } else if (m.role === 'assistant') {
      const content = [];
      const text = contentToText(m.content);
      if (text) content.push({ type: 'text', text });
      for (const tc of m.tool_calls || []) {
        let input;
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
      }
      if (content.length) messages.push({ role: 'assistant', content });
    } else {
      const content = [];
      for (const b of toArray(m.content)) {
        if (b.type === 'image_url') {
          const url = b.image_url?.url || '';
          const m2 = url.match(/^data:([^;]+);base64,(.*)$/s);
          if (m2) content.push({ type: 'image', source: { type: 'base64', media_type: m2[1], data: m2[2] } });
        } else if (b.text) {
          content.push({ type: 'text', text: b.text });
        }
      }
      if (content.length) messages.push({ role: 'user', content });
    }
  }
  const out = { model: body.model, max_tokens: body.max_tokens || 4096, messages: mergeConsecutive(messages) };
  if (system) out.system = system;
  if (body.tools?.length)
    out.tools = body.tools.map((t) => ({
      name: t.function?.name,
      description: t.function?.description || '',
      input_schema: t.function?.parameters || { type: 'object' },
    }));
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop) && body.stop.length) out.stop_sequences = body.stop;
  else if (typeof body.stop === 'string') out.stop_sequences = [body.stop];
  if (body.stream) out.stream = true;
  return out;
}

// ---------- OpenAI response -> Anthropic response ----------
const anthropicStopReason = (finish, hasTools) =>
  finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal'
    : finish === 'tool_calls' || hasTools ? 'tool_use' : 'end_turn';

function openAIToAnthropicResp(resp) {
  if (resp.error) throw new Error(resp.error.message || 'Upstream returned an error');
  const msg = resp.choices?.[0]?.message;
  if (!msg) throw new Error('Upstream returned no assistant message');
  const content = [];
  const text = contentToText(msg.content);
  if (text) content.push({ type: 'text', text });
  for (const tc of msg.tool_calls || []) {
    let input;
    try { input = JSON.parse(tc.function?.arguments || '{}'); }
    catch { throw new Error('Invalid JSON in upstream tool arguments'); }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
  }
  return {
    id: 'msg_' + (resp.id || crypto.randomUUID()),
    type: 'message',
    role: 'assistant',
    model: resp.model,
    content: content.length ? content : [{ type: 'text', text: '' }],
    stop_reason: anthropicStopReason(resp.choices[0].finish_reason, msg.tool_calls?.length),
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens || 0,
      output_tokens: resp.usage?.completion_tokens || 0,
    },
  };
}

// ---------- Anthropic response -> OpenAI response ----------
function anthropicToOpenAIResp(resp) {
  const blocks = resp.content || [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const tool_calls = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }));
  const message = { role: 'assistant', content: text || null };
  if (tool_calls.length) message.tool_calls = tool_calls;
  return {
    id: resp.id || 'chatcmpl_router',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: [{ index: 0, message, finish_reason: resp.stop_reason === 'tool_use' ? 'tool_calls' : 'stop' }],
    usage: {
      prompt_tokens: resp.usage?.input_tokens || 0,
      completion_tokens: resp.usage?.output_tokens || 0,
      total_tokens: (resp.usage?.input_tokens || 0) + (resp.usage?.output_tokens || 0),
    },
  };
}

// ---------- stream converters ----------
// OpenAI SSE events -> Anthropic SSE events
function openaiStreamToAnthropic() {
  let started = false;
  let finished = false;
  let blockIndex = -1;
  let textOpen = false;
  let finishReason = null;
  const tools = new Map();
  const usage = { input_tokens: 0, output_tokens: 0 };
  return {
    onData(obj) {
      const events = [];
      if (finished) return events;
      if (obj.error) {
        finished = true;
        throw new Error(obj.error.message || 'Upstream stream failed');
      }
      if (obj.usage) {
        usage.input_tokens = obj.usage.prompt_tokens ?? usage.input_tokens;
        usage.output_tokens = obj.usage.completion_tokens ?? usage.output_tokens;
      }
      if (!started) {
        started = true;
        events.push({
          type: 'message_start',
          message: {
            id: 'msg_' + (obj.id || crypto.randomUUID()),
            type: 'message',
            role: 'assistant',
            model: obj.model || '',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { ...usage },
          },
        });
      }
      // Usage can arrive after finish_reason; emit message_stop only at EOF/DONE.
      if (finishReason) return events;
      const delta = obj.choices?.[0]?.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        if (!textOpen) {
          blockIndex++;
          textOpen = true;
          events.push({ type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
        }
        events.push({ type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: delta.content } });
      }
      // OpenAI interleaves parallel tool arguments. Buffer by tool index so the
      // Anthropic client receives complete, sequential tool blocks, never mixed JSON.
      for (const tc of delta.tool_calls || []) {
        const index = tc.index ?? 0;
        if (!tools.has(index)) tools.set(index, { id: '', name: '', arguments: '' });
        const tool = tools.get(index);
        if (tc.id) tool.id = tc.id;
        if (tc.function?.name) tool.name += tc.function.name;
        if (tc.function?.arguments) tool.arguments += tc.function.arguments;
      }
      finishReason = obj.choices?.[0]?.finish_reason || null;
      return events;
    },
    // EOF is not evidence of success: require the upstream's finish_reason.
    forceStop(events) {
      if (finished) return;
      if (!started || !finishReason) throw new Error('Upstream stream ended before finish_reason');
      const completedTools = [...tools.values()].map((tool) => {
        if (!tool.id || !tool.name) throw new Error('Upstream returned an incomplete tool call');
        let input;
        try { input = JSON.parse(tool.arguments || '{}'); }
        catch { throw new Error('Invalid JSON in upstream tool arguments'); }
        return { type: 'tool_use', id: tool.id, name: tool.name, input };
      });
      finished = true;
      if (textOpen) events.push({ type: 'content_block_stop', index: blockIndex });
      for (const tool of completedTools) {
        blockIndex++;
        events.push({ type: 'content_block_start', index: blockIndex, content_block: { ...tool, input: {} } });
        events.push({ type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } });
        events.push({ type: 'content_block_stop', index: blockIndex });
      }
      events.push({
        type: 'message_delta',
        delta: { stop_reason: anthropicStopReason(finishReason, tools.size), stop_sequence: null },
        usage: { ...usage },
      });
      events.push({ type: 'message_stop' });
    },
  };
}

// Anthropic SSE events -> OpenAI chunks
function anthropicStreamToOpenAI() {
  let id = 'chatcmpl_router';
  let model = '';
  const toolIndexByBlock = {};
  let nextTool = 0;
  const chunk = (delta, finish = null) => ({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return {
    onEvent(ev) {
      const out = [];
      if (ev.type === 'message_start') {
        id = 'chatcmpl_' + (ev.message?.id || crypto.randomUUID());
        model = ev.message?.model || '';
        out.push(chunk({ role: 'assistant', content: '' }));
      }
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        const ti = nextTool++;
        toolIndexByBlock[ev.index] = ti;
        out.push(chunk({ tool_calls: [{ index: ti, id: ev.content_block.id, type: 'function', function: { name: ev.content_block.name, arguments: '' } }] }));
      }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta')
        out.push(chunk({ content: ev.delta.text }));
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta')
        out.push(chunk({ tool_calls: [{ index: toolIndexByBlock[ev.index] ?? 0, function: { arguments: ev.delta.partial_json } }] }));
      if (ev.type === 'message_delta')
        out.push(chunk({}, ev.delta?.stop_reason === 'tool_use' ? 'tool_calls' : 'stop'));
      return out;
    },
  };
}

const writeSSE = (res, ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);

// Native fetch yields Uint8Array chunks, not Buffers. Decode incrementally so
// split UTF-8 characters and SSE frames survive arbitrary network boundaries.
async function readSSE(body, onData) {
  const decoder = new TextDecoder();
  let buf = '';
  let data = [];
  const dispatch = () => {
    const payload = data.join('\n').trim();
    data = [];
    if (payload === '[DONE]') return false;
    if (payload) {
      let obj;
      try { obj = JSON.parse(payload); }
      catch { throw new Error('Invalid JSON in upstream event stream'); }
      onData(obj);
    }
    return true;
  };
  const onLine = (line) => {
    line = line.replace(/\r$/, '');
    if (!line) return dispatch();
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    return true;
  };
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!onLine(line)) return;
    }
  }
  buf += decoder.decode();
  if (buf && !onLine(buf)) return;
  dispatch();
}

// ---------- proxy core ----------
function endpointUrl(provider) {
  const base = provider.baseUrl.replace(/\/+$/, '');
  if (provider.endpointPath) return base + '/' + provider.endpointPath.replace(/^\/+/, '');
  const ep = provider.type === 'anthropic' ? 'messages' : 'chat/completions';
  return /\/(?:v\d+(?:beta)?|openai)$/.test(base) ? `${base}/${ep}` : `${base}/v1/${ep}`;
}

const errorFor = (format, message) =>
  format === 'anthropic'
    ? { type: 'error', error: { type: 'api_error', message } }
    : { error: { message } };

// ---------- upstream call (single provider) ----------
function buildUpstream(provider, body, clientFormat) {
  const same = (clientFormat === 'anthropic') === (provider.type === 'anthropic');
  let upstreamBody = same
    ? { ...body, model: provider.defaultModel }
    : clientFormat === 'anthropic'
      ? anthropicToOpenAI({ ...body, model: provider.defaultModel })
      : openAIToAnthropicReq({ ...body, model: provider.defaultModel });

  // Provider quirks. Some upstreams reject reasoning_effort together with function
  // tools, e.g. agentrouter + gpt-6-astra:
  //   400 "Function tools with reasoning_effort are not supported ... set reasoning_effort to 'none'"
  // Note the anthropic->openai conversion injects reasoning_effort itself, so this
  // must run AFTER the body is built, not before.
  const compat = (provider.compat && typeof provider.compat === 'object') ? provider.compat : {};
  if (compat.noReasoningEffortWithTools && upstreamBody.tools?.length && upstreamBody.reasoning_effort) {
    upstreamBody = { ...upstreamBody, reasoning_effort: 'none' };
  }

  const headers = { 'content-type': 'application/json' };
  if (provider.type === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
  } else if (provider.apiKey) headers.authorization = 'Bearer ' + provider.apiKey;

  // Some gateways fingerprint the client and reject anything that isn't their
  // expected CLI (agentrouter returns 401 "unauthorized client detected" for a
  // browser/node UA while accepting claude-cli).
  if (typeof provider.userAgent === 'string' && provider.userAgent.trim()) {
    headers['user-agent'] = provider.userAgent.trim();
  }
  if (provider.headers && typeof provider.headers === 'object') {
    for (const [k, v] of Object.entries(provider.headers)) {
      if (typeof v === 'string' && k.trim()) headers[k.trim().toLowerCase()] = v;
    }
  }

  return { same, upstreamBody, headers };
}

// Statuses that mean "this PROVIDER can't serve" rather than "this REQUEST is bad".
// 401/403/404 are per-provider credential/entitlement/model problems, so auto mode
// must skip to the next provider instead of failing the whole request. 402 is a
// provider-side quota/budget exhaustion — equally worth failing over.
const RETRYABLE = new Set([401, 402, 403, 404, 408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);
// 400 (malformed request) is deliberately NOT retryable — every provider would reject it.

async function callUpstream(provider, body, clientFormat, signal) {
  const { same, upstreamBody, headers } = buildUpstream(provider, body, clientFormat);
  let up;
  try {
    up = await fetch(endpointUrl(provider), { method: 'POST', headers, body: JSON.stringify(upstreamBody), signal, redirect: 'error' });
  } catch (e) {
    return { ok: false, status: 502, retryable: true, error: `upstream unreachable: ${e.message}` };
  }
  if (!up.ok) {
    const text = await up.text().catch(() => '');
    let msg = text;
    try { msg = JSON.parse(text).error?.message || text; } catch {}
    return { ok: false, status: up.status, retryable: RETRYABLE.has(up.status), error: msg || up.statusText };
  }
  return { ok: true, same, upstream: up };
}

// ---------- proxy core (auto failover + scheduled override) ----------
// Hard cap on any single upstream call. Cloudflare's proxy read timeout is 120s, so an
// upstream that stalls past this burns the whole window for nothing. 110s leaves the
// client a little room to see a clean timeout error instead of a 524.

// Streaming heartbeat. Cloudflare's proxy read timeout only resets on bytes reaching
// the client. An upstream that streams slowly (long reasoning, deep tool use) otherwise
// looks like a hang and gets a 524. Emitting a comment every 10s keeps the connection
// alive without changing the response body — SSE comments are invisible to consumers.
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT = ': heartbeat\n\n';

async function streamUpstream(res, result, clientFormat) {
  const up = result.upstream;
  const same = result.same;
  const timer = setInterval(() => {
    try { res.write(HEARTBEAT); } catch {}
  }, HEARTBEAT_INTERVAL_MS);
  try {
    if (same) {
      for await (const chunk of up.body) res.write(chunk);
    } else if (clientFormat === 'anthropic') {
      const conv = openaiStreamToAnthropic();
      await readSSE(up.body, (obj) => conv.onData(obj).forEach((ev) => writeSSE(res, ev)));
      const tail = [];
      conv.forceStop(tail);
      tail.forEach((ev) => writeSSE(res, ev));
    } else {
      const conv = anthropicStreamToOpenAI();
      await readSSE(up.body, (ev) => conv.onEvent(ev).forEach((c) => res.write(`data: ${JSON.stringify(c)}\n\n`)));
      res.write('data: [DONE]\n\n');
    }
  } finally {
    clearInterval(timer);
  }
  res.end();
}

async function proxyRequest(req, res, clientFormat) {
  const cfg = loadConfig();
  const routing = routingOf(cfg);
  let { providers: candidates, reason, scheduled } = resolveCandidates(cfg);
  // An explicit provider/model alias lets one client call any configured model
  // without changing the dashboard's active provider or automation settings.
  const alias = typeof req.body?.model === 'string' ? req.body.model.split('/') : [];
  const explicitName = req.headers['x-giga-provider'] || (alias.length > 1 ? alias[0] : '');
  const explicit = explicitName && cfg.providers.find((provider) => provider.enabled !== false &&
    (provider.id === explicitName || provider.name.toLowerCase() === String(explicitName).toLowerCase() || providerSlug(provider) === explicitName));
  if (req.headers['x-giga-provider'] && !explicit) return res.status(404).json(errorFor(clientFormat, 'Requested provider is missing or disabled'));
  if (explicit) {
    const model = alias.length > 1 && alias[0] === explicitName ? alias.slice(1).join('/') : explicit.defaultModel;
    candidates = [{ ...explicit, defaultModel: model }];
    reason = `provider:${explicit.name}`;
    scheduled = null;
  }

  if (!candidates.length)
    return res.status(503).json(errorFor(clientFormat, 'no provider available'));

  const body = req.body || {};
  sanitizeThinking(body);

  // In auto mode, skip providers in cooldown — unless that leaves nothing.
  const ready = candidates.filter(healthy);
  const usable = routing.mode === 'auto' && !scheduled && !explicit
    ? (ready.length ? ready : candidates)
    : candidates;

  // A strict window (no fallbackOnFailure) must not fail over: the pinned provider
  // is the whole point. A window with fallbackOnFailure behaves like auto.
  const allowFailover = !explicit && routing.mode === 'auto' && (!scheduled || !!scheduled.fallbackOnFailure);

  const attempts = [];
  let last = null;

  for (let i = 0; i < usable.length; i++) {
    const provider = usable[i];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 110_000);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    let result;
    try { result = await callUpstream(provider, body, clientFormat, controller.signal); }
    catch (error) { clearTimeout(timeout); res.off('close', disconnected); throw error; }
    attempts.push({ provider: provider.name, status: result.status ?? 200, ok: result.ok });

    if (!result.ok) {
      clearTimeout(timeout);
      res.off('close', disconnected);
      if (res.destroyed) return;
      recordActivity({ kind: 'llm', name: provider.name, model: provider.defaultModel, status: 'error', code: result.status, keyName: req.gatewayKey?.name });
      last = result;
      if (markFailure(provider.id)) {
        console.warn(
          `[router] ${provider.name} tripped after ${TRIP_AFTER} consecutive failures ` +
          `(last ${result.status}) — out of the chain for ${Math.round(TRIP_COOLDOWN_MS / 60000)}m`
        );
      }
      if (!allowFailover) break;
      if (!result.retryable) break;
      continue;
    }

    res.setHeader('x-llmrouter-provider', provider.name);
    res.setHeader('x-llmrouter-reason', reason);
    if (attempts.length > 1) res.setHeader('x-llmrouter-fallbacks', String(attempts.length - 1));

    try {
      if (body.stream) {
        res.setHeader('content-type', 'text/event-stream');
        res.setHeader('cache-control', 'no-cache');
        res.flushHeaders?.();
        await streamUpstream(res, result, clientFormat);
        markSuccess(provider.id);
        recordActivity({ kind: 'llm', name: provider.name, model: provider.defaultModel, status: 'ok', keyName: req.gatewayKey?.name });
        return;
      }

      const data = await result.upstream.json();
      if (data.error) throw new Error(data.error.message || 'Upstream returned an error');
      const response = result.same ? data
        : clientFormat === 'anthropic' ? openAIToAnthropicResp(data) : anthropicToOpenAIResp(data);
      markSuccess(provider.id);
      recordActivity({ kind: 'llm', name: provider.name, model: provider.defaultModel, status: 'ok', keyName: req.gatewayKey?.name });
      return res.json(response);
    } catch (error) {
      markFailure(provider.id);
      recordActivity({ kind: 'llm', name: provider.name, model: provider.defaultModel, status: 'error', keyName: req.gatewayKey?.name });
      throw error;
    } finally {
      clearTimeout(timeout);
      res.off('close', disconnected);
    }
  }

  // every candidate failed
  const detail = attempts.map((a) => `${a.provider}:${a.status}`).join(', ');
  return res.status(last?.status || 502).json(
    errorFor(clientFormat, `all providers failed (${detail}) — ${last?.error || 'unknown error'}`)
  );
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'DENY');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '20mb' }));
app.get('/api/ping', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

mountAuth(app, closeKeySessions);
mountSkills(app, sessionAuth, notifyMcpClients);
mountMcp(app, sessionAuth);
mountIntegrations(app, sessionAuth, mcpServices);
app.get('/api/config', sessionAuth, (req, res) => {
  const cfg = loadConfig();
  res.json({ providers: cfg.providers.map(publicProvider), activeId: cfg.activeId, routing: routingOf(cfg), hasRouterKey: !!ROUTER_KEY });
});
app.get('/api/overview', sessionAuth, (req, res) => {
  const cfg = loadConfig();
  res.json({ providers: cfg.providers.length, mcpServers: cfg.mcpServers.length, skills: cfg.skills.length, sources: cfg.sources.length, ...activitySnapshot() });
});

function providerSlug(provider) { return provider.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || provider.id; }
function publicProvider(provider) { return { ...provider, apiKey: provider.apiKey ? '***' : '', headers: maskedMap(provider.headers), slug: providerSlug(provider) }; }
function validatedProvider(body, previous = {}) {
  const provider = { ...previous, id: previous.id || crypto.randomUUID() };
  for (const field of ['name', 'type', 'baseUrl', 'defaultModel']) {
    const value = body[field] === undefined ? previous[field] : body[field];
    if (typeof value !== 'string' || !value.trim()) throw inputError('name, type, baseUrl, and defaultModel are required');
    provider[field] = value.trim();
  }
  if (!['openai', 'anthropic'].includes(provider.type)) throw inputError('Provider type must be openai or anthropic');
  if (httpUrl(provider.baseUrl).search) throw inputError('Provider base URLs must not include a query; use custom headers for credentials');
  if (body.apiKey !== undefined && typeof body.apiKey !== 'string') throw inputError('API key must be a string');
  provider.apiKey = body.apiKey === '***' || body.apiKey === undefined ? previous.apiKey || '' : body.apiKey.trim();
  if (/[\r\n]/.test(provider.apiKey)) throw inputError('API key must be a single-line string');
  provider.headers = headerMap(body.headers, previous.headers);
  if (body.userAgent !== undefined) {
    if (typeof body.userAgent !== 'string' || /[\r\n]/.test(body.userAgent)) throw inputError('User-Agent must be a single-line string');
    provider.userAgent = body.userAgent.trim();
  }
  if (body.compat !== undefined) provider.compat = { noReasoningEffortWithTools: !!body.compat?.noReasoningEffortWithTools };
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw inputError('Enabled must be a boolean');
    provider.enabled = body.enabled;
  }
  if (body.endpointPath !== undefined) {
    if (typeof body.endpointPath !== 'string' || /[?#\r\n]/.test(body.endpointPath)) throw inputError('Endpoint path must be a path without a query or fragment');
    provider.endpointPath = body.endpointPath.trim();
  }
  return provider;
}

app.post('/api/providers', sessionAuth, (req, res) => {
  const cfg = loadConfig();
  const provider = validatedProvider(req.body);
  if (cfg.providers.some((entry) => providerSlug(entry) === providerSlug(provider))) throw inputError('Provider name is already in use', 409);
  cfg.providers.push(provider);
  if (!cfg.activeId) cfg.activeId = provider.id;
  saveConfig(cfg);
  res.json(publicProvider(provider));
});
app.put('/api/providers/:id', sessionAuth, (req, res) => {
  const cfg = loadConfig();
  const i = cfg.providers.findIndex((p) => p.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  const provider = validatedProvider(req.body, cfg.providers[i]);
  if (cfg.providers.some((entry) => entry.id !== provider.id && providerSlug(entry) === providerSlug(provider))) throw inputError('Provider name is already in use', 409);
  cfg.providers[i] = provider;
  saveConfig(cfg);
  res.json(publicProvider(cfg.providers[i]));
});
app.delete('/api/providers/:id', sessionAuth, (req, res) => {
  const cfg = loadConfig();
  cfg.providers = cfg.providers.filter((p) => p.id !== req.params.id);
  const routing = routingOf(cfg);
  routing.autoOrder = routing.autoOrder.filter((id) => cfg.providers.some((provider) => provider.id === id || provider.name === id));
  routing.schedules = routing.schedules.filter((schedule) => schedule.providerId !== req.params.id);
  cfg.routing = routing;
  health.delete(req.params.id);
  if (cfg.activeId === req.params.id) cfg.activeId = cfg.providers[0]?.id || null;
  saveConfig(cfg);
  res.json({ ok: true });
});
app.post('/api/active', sessionAuth, (req, res) => {
  const cfg = loadConfig();
  const { id } = req.body || {};
  if (!cfg.providers.some((p) => p.id === id)) return res.status(404).json({ error: 'not found' });
  cfg.activeId = id;
  saveConfig(cfg);
  res.json({ ok: true, activeId: id });
});

// ---------- routing API ----------

// current effective routing (what would serve a request right now)
app.get('/api/routing', sessionAuth, (req, res) => {
  const cfg = loadConfig();
  const routing = routingOf(cfg);
  const resolved = resolveCandidates(cfg);
  const now = nowInZone('Asia/Kolkata');
  res.json({
    ...routing,
    activeId: cfg.activeId,
    limits: {
      failCooldownMs: FAIL_COOLDOWN_MS,
      tripAfter: TRIP_AFTER,
      tripCooldownMs: TRIP_COOLDOWN_MS,
    },
    effective: {
      provider: resolved.providers[0]?.name || null,
      providerId: resolved.providers[0]?.id || null,
      reason: resolved.reason,
      scheduled: resolved.scheduled || null,
      tripped: resolved.trippedProvider ? resolved.trippedProvider.name : null,
      chain: resolved.providers.map((p) => p.name),
    },
    health: healthSnapshot(cfg.providers),
    serverTime: { ...now, tz: 'Asia/Kolkata' },
  });
});

// set mode and/or auto priority order
app.post('/api/routing', sessionAuth, (req, res) => {
  const cfg = loadConfig();
  const routing = routingOf(cfg);
  const { mode, autoOrder } = req.body || {};
  if (mode !== undefined) {
    if (!['auto', 'manual'].includes(mode)) return res.status(400).json({ error: 'mode must be auto|manual' });
    routing.mode = mode;
  }
  if (autoOrder !== undefined) {
    if (!Array.isArray(autoOrder)) return res.status(400).json({ error: 'autoOrder must be an array' });
    routing.autoOrder = autoOrder.map(String);
  }
  cfg.routing = routing;
  saveConfig(cfg);
  res.json({ ok: true, routing });
});

// schedule windows
const validSchedule = (s) =>
  s && typeof s === 'object' &&
  toMinutes(s.start) != null && toMinutes(s.end) != null &&
  typeof s.providerId === 'string' && s.providerId.trim() &&
  (s.days === undefined || (Array.isArray(s.days) && s.days.every((d) => typeof d === 'string')));
const SCHEDULE_ERR = 'providerId, start (HH:MM), end (HH:MM) required; days optional array';
app.get('/api/schedules', sessionAuth, (req, res) => {
  const cfg = loadConfig();
  const routing = routingOf(cfg);
  const byId = new Map(cfg.providers.map((p) => [p.id, p]));
  const now = nowInZone('Asia/Kolkata');
  res.json(routing.schedules.map((s) => ({
    ...s,
    providerName: byId.get(s.providerId)?.name || '(missing)',
    activeNow: !!matchSchedule([s], now),
  })));
});

app.post('/api/schedules', sessionAuth, (req, res) => {
  if (!validSchedule(req.body)) return res.status(400).json({ error: SCHEDULE_ERR });
  const cfg = loadConfig();
  if (!cfg.providers.some((p) => p.id === req.body.providerId))
    return res.status(404).json({ error: 'provider not found' });
  const routing = routingOf(cfg);
  const sched = {
    id: crypto.randomUUID(),
    providerId: req.body.providerId,
    start: req.body.start,
    end: req.body.end,
    days: Array.isArray(req.body.days) && req.body.days.length ? req.body.days : undefined,
    timezone: req.body.timezone || 'Asia/Kolkata',
    label: typeof req.body.label === 'string' ? req.body.label : '',
    fallbackOnFailure: !!req.body.fallbackOnFailure,
  };
  routing.schedules.push(sched);
  cfg.routing = routing;
  saveConfig(cfg);
  res.json(sched);
});

app.put('/api/schedules/:id', sessionAuth, (req, res) => {
  if (!validSchedule(req.body)) return res.status(400).json({ error: SCHEDULE_ERR });
  const cfg = loadConfig();
  const routing = routingOf(cfg);
  const i = routing.schedules.findIndex((s) => s.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  if (!cfg.providers.some((provider) => provider.id === req.body.providerId)) return res.status(404).json({ error: 'provider not found' });
  routing.schedules[i] = {
    id: req.params.id,
    providerId: req.body.providerId,
    start: req.body.start,
    end: req.body.end,
    days: Array.isArray(req.body.days) && req.body.days.length ? req.body.days : undefined,
    timezone: req.body.timezone || 'Asia/Kolkata',
    label: typeof req.body.label === 'string' ? req.body.label : '',
    fallbackOnFailure: !!req.body.fallbackOnFailure,
  };
  cfg.routing = routing;
  saveConfig(cfg);
  res.json(routing.schedules[i]);
});

app.delete('/api/schedules/:id', sessionAuth, (req, res) => {
  const cfg = loadConfig();
  const routing = routingOf(cfg);
  routing.schedules = routing.schedules.filter((s) => s.id !== req.params.id);
  cfg.routing = routing;
  saveConfig(cfg);
  res.json({ ok: true });
});

// which provider would serve a request right now (dry run, no upstream call)
app.get('/api/route-now', sessionAuth, (req, res) => {
  const cfg = loadConfig();
  const resolved = resolveCandidates(cfg);
  res.json({
    provider: resolved.providers[0]?.name || null,
    providerId: resolved.providers[0]?.id || null,
    reason: resolved.reason,
    scheduled: resolved.scheduled || null,
    tripped: resolved.trippedProvider ? resolved.trippedProvider.name : null,
    chain: resolved.providers.map((p) => p.name),
  });
});

// clear cooldowns
app.post('/api/health/reset', sessionAuth, (req, res) => {
  health.clear();
  res.json({ ok: true });
});

// client API: environment router key and scoped, revocable gateway keys.
const apiKeyAuth = gatewayAuth('llm');
app.get('/v1/models', apiKeyAuth, (req, res) => res.json({ object: 'list', data: loadConfig().providers.filter((provider) => provider.enabled !== false).map((provider) => ({
  id: `${providerSlug(provider)}/${provider.defaultModel}`, object: 'model', created: 0, owned_by: provider.name,
})) }));
app.post('/v1/messages', apiKeyAuth, (req, res, next) => proxyRequest(req, res, 'anthropic').catch(next));
app.post('/v1/chat/completions', apiKeyAuth, (req, res, next) => proxyRequest(req, res, 'openai').catch(next));
app.post('/v1/messages/count_tokens', apiKeyAuth, (req, res) => {
  const chars = JSON.stringify({ system: req.body.system, messages: req.body.messages, tools: req.body.tools }).length;
  res.json({ input_tokens: Math.max(1, Math.ceil(chars / 4)), estimated: true });
});

app.use((error, req, res, next) => {
  if (res.destroyed || res.writableEnded) return;
  if (req.path.startsWith('/api/')) return res.status(error.status || 500).json({ error: error.message || 'Request failed' });
  if (req.path === '/mcp') return res.status(error.status || 500).json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32603, message: 'MCP request failed. Check this server in the dashboard.' } });
  const format = req.path.startsWith('/v1/messages') ? 'anthropic' : 'openai';
  const message = error instanceof SyntaxError ? 'Invalid JSON in request or upstream response' : error.message;
  const payload = errorFor(format, message || 'Upstream response failed');
  if (res.headersSent) {
    if (format === 'anthropic') writeSSE(res, payload);
    else res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return res.end();
  }
  res.status(error.status || 502).json(payload);
});

app.get('/vendor/feather.js', (req, res) => res.sendFile(require.resolve('feather-icons/dist/feather.min.js')));
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny' }));

if (require.main === module) {
  const seeded = seedDefaultMarketplaces();
  if (seeded.added || seeded.adopted || seeded.repaired) console.log(`Marketplace defaults: ${seeded.added} added, ${seeded.adopted} existing, ${seeded.repaired} indexes restored`);
  const listener = app.listen(PORT, () => console.log(`Giga Router listening on ${PORT}`));
  const stop = async () => {
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await closeAllMcp();
    listener.close(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

module.exports = {
  app,
  closeAllMcp,
  readSSE,
  sanitizeThinking,
  anthropicToOpenAI,
  openAIToAnthropicReq,
  openAIToAnthropicResp,
  anthropicToOpenAIResp,
  openaiStreamToAnthropic,
  anthropicStreamToOpenAI,
  mergeConsecutive,
  endpointUrl,
  buildUpstream,
  routingOf,
  toMinutes,
  nowInZone,
  matchSchedule,
  resolveCandidates,
  // health / trip (exposed for tests)
  markFailure,
  markSuccess,
  isCooling,
  isTripped,
  healthy,
  healthSnapshot,
  health,
  FAIL_COOLDOWN_MS,
  TRIP_AFTER,
  TRIP_COOLDOWN_MS,
  // streaming
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT,
};
