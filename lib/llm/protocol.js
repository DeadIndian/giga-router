const crypto = require('node:crypto');
const { inputError } = require('../validation');
const { MAX_EVENT_BYTES } = require('./sse');
const toArray = value => Array.isArray(value) ? value : typeof value === 'string' ? [{ type: 'text', text: value }] : value ? [value] : [];
const contentToText = value => Array.isArray(value) ? value.map(b => b.text || '').join('') : value || '';
const unsupported = feature => Object.assign(inputError(`Cannot translate ${feature}; choose a native provider for this request`, 400), { category: 'capability_mismatch' });
function rejectFields(body, fields) { for (const field of fields) if (body[field] != null) throw unsupported(field); }
function supportedFields(body, fields) {
  const allowed = new Set(fields.split(' '));
  for (const field of Object.keys(body)) if (body[field] != null && !allowed.has(field)) throw unsupported(field);
}
const unsupportedOutput = feature => Object.assign(new Error(`Cannot translate upstream ${feature}; choose a native provider`), { status: 502, category: 'capability_mismatch' });
function mergeConsecutive(messages) {
  const out = [];
  for (const m of messages) {
    const last = out.at(-1);
    if (last?.role === m.role) last.content.push(...toArray(m.content));
    else out.push({ role: m.role, content: [...toArray(m.content)] });
  }
  return out;
}
// Legacy adjustment is opt-in and applied to a fresh per-attempt body.
function sanitizeThinking(body, compat = {}) {
  if (compat.adaptiveToEnabled && body.thinking?.type === 'adaptive') {
    body.thinking = { type: 'enabled', budget_tokens: Math.max(1024, body.thinking.budget_tokens || 1024) };
  }
  return body;
}
function anthropicToOpenAI(body) {
  supportedFields(body, 'model max_tokens messages system tools tool_choice temperature top_p stop_sequences stream thinking metadata');
  rejectFields(body, ['output_config', 'context_management', 'container', 'mcp_servers']);
  const messages = [];
  if (body.system) {
    if (toArray(body.system).some(block => block.type !== 'text')) throw unsupported('non-text instructions');
    messages.push({ role: 'system', content: contentToText(body.system) });
  }
  for (const m of body.messages || []) {
    const content = [], tool_calls = [];
    for (const block of toArray(m.content)) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text });
      else if (block.type === 'tool_use' && m.role === 'assistant') tool_calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
      else if (block.type === 'tool_result') {
        if (block.is_error) throw unsupported('error-marked tool results');
        if (toArray(block.content).some(b => b.type !== 'text')) throw unsupported('non-text tool results');
        messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: contentToText(block.content) });
      } else if (block.type === 'image' && block.source?.type === 'base64') content.push({ type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } });
      else if (block.type === 'image' && block.source?.type === 'url') content.push({ type: 'image_url', image_url: { url: block.source.url } });
      else throw unsupported(`content block ${block.type}`);
    }
    if (content.length || tool_calls.length || m.role === 'assistant') messages.push({ role: m.role, content: content.length ? content : null, ...(tool_calls.length ? { tool_calls } : {}) });
  }
  const out = { model: body.model, max_tokens: body.max_tokens ?? 4096, messages };
  if (body.metadata?.user_id) out.user = body.metadata.user_id;
  if (body.tools?.length) out.tools = body.tools.map(t => {
    if (t.strict || t.defer_loading || t.allowed_callers || t.input_examples) throw unsupported('extended tool settings');
    if (t.type && t.type !== 'custom') throw unsupported(`tool type ${t.type}`);
    return { type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object' } } };
  });
  if (body.tool_choice) {
    const choice = body.tool_choice;
    out.tool_choice = choice.type === 'tool' ? { type: 'function', function: { name: choice.name } } : choice.type === 'any' ? 'required' : choice.type;
    if (choice.disable_parallel_tool_use != null) out.parallel_tool_calls = !choice.disable_parallel_tool_use;
  }
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  if (body.stream) { out.stream = true; out.stream_options = { include_usage: true }; }
  if (['enabled', 'adaptive'].includes(body.thinking?.type)) out.reasoning_effort = 'medium';
  return out;
}
function openAIToAnthropicReq(body) {
  supportedFields(body, 'model max_tokens max_completion_tokens messages tools tool_choice parallel_tool_calls temperature top_p stop stream stream_options n modalities user');
  rejectFields(body, ['response_format', 'audio', 'prediction', 'logprobs', 'top_logprobs', 'logit_bias', 'frequency_penalty', 'presence_penalty', 'seed']);
  if (body.n != null && body.n !== 1) throw unsupported('multiple choices');
  if (body.modalities?.some(m => m !== 'text')) throw unsupported('output modalities');
  const messages = []; let system = '';
  for (const m of body.messages || []) {
    if (m.name) throw unsupported('named messages');
    if (['system', 'developer'].includes(m.role)) {
      if (toArray(m.content).some(b => b.type !== 'text')) throw unsupported('non-text instructions');
      system += (system ? '\n' : '') + contentToText(m.content);
    } else if (m.role === 'tool') {
      if (toArray(m.content).some(b => b.type !== 'text')) throw unsupported('non-text tool results');
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: contentToText(m.content) }] });
    } else {
      const content = [];
      for (const block of toArray(m.content)) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text });
        else if (block.type === 'image_url') {
          if (block.image_url?.detail && block.image_url.detail !== 'auto') throw unsupported('image detail control');
          const url = block.image_url?.url || '', match = /^data:([^;]+);base64,(.*)$/s.exec(url);
          if (match) content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
          else if (/^https?:\/\//.test(url)) content.push({ type: 'image', source: { type: 'url', url } });
          else throw unsupported('image URL');
        } else throw unsupported(`content block ${block.type}`);
      }
      if (m.refusal) throw unsupported('assistant refusal history');
      if (m.function_call || m.audio || m.reasoning_content) throw unsupported('assistant audio, reasoning, or legacy function history');
      for (const call of m.tool_calls || []) {
        if (call.type && call.type !== 'function') throw unsupported(`tool call type ${call.type}`);
        let input; try { input = JSON.parse(call.function?.arguments || '{}'); } catch { throw inputError('Invalid JSON in tool call arguments'); }
        content.push({ type: 'tool_use', id: call.id, name: call.function?.name, input });
      }
      if (content.length) messages.push({ role: m.role, content });
    }
  }
  const out = { model: body.model, max_tokens: body.max_completion_tokens ?? body.max_tokens ?? 4096, messages: mergeConsecutive(messages) };
  if (system) out.system = system;
  if (body.user) out.metadata = { user_id: body.user };
  if (body.tools?.length) out.tools = body.tools.map(t => {
    if (t.type !== 'function') throw unsupported(`tool type ${t.type}`);
    if (t.function?.strict) throw unsupported('strict tool schema');
    return { name: t.function?.name, description: t.function?.description || '', input_schema: t.function?.parameters || { type: 'object' } };
  });
  if (body.tool_choice != null || body.parallel_tool_calls != null) {
    const choice = body.tool_choice || 'auto';
    if (typeof choice === 'object' && choice.type !== 'function') throw unsupported('non-function tool choice');
    out.tool_choice = typeof choice === 'object' ? { type: 'tool', name: choice.function?.name } : { type: choice === 'required' ? 'any' : choice };
    if (body.parallel_tool_calls != null) out.tool_choice.disable_parallel_tool_use = !body.parallel_tool_calls;
  }
  if (body.reasoning_effort != null) throw unsupported('reasoning_effort');
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop) && body.stop.length) out.stop_sequences = body.stop;
  else if (typeof body.stop === 'string') out.stop_sequences = [body.stop];
  if (body.stream) out.stream = true;
  return out;
}
const anthropicStopReason = (finish, tools) => finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : finish === 'tool_calls' || tools ? 'tool_use' : 'end_turn';
function openAIStopReason(reason) {
  if (reason && !['end_turn', 'stop_sequence', 'max_tokens', 'model_context_window_exceeded', 'tool_use', 'refusal'].includes(reason)) throw unsupportedOutput(`stop reason ${reason}`);
  return ['max_tokens', 'model_context_window_exceeded'].includes(reason) ? 'length' : reason === 'tool_use' ? 'tool_calls' : reason === 'refusal' ? 'content_filter' : 'stop';
}
function openAIToAnthropicResp(resp) {
  if (resp.error) throw new Error(resp.error.message || 'Upstream returned an error');
  const msg = resp.choices?.[0]?.message;
  if (!msg) throw new Error('Upstream returned no assistant message');
  if (resp.choices.length > 1 || msg.reasoning_content || msg.audio || msg.annotations?.length || msg.function_call || (Array.isArray(msg.content) && msg.content.some(b => b.type !== 'text'))) throw unsupportedOutput('multiple choices, reasoning, audio, annotations, or content blocks');
  const content = [], text = contentToText(msg.content);
  if (text) content.push({ type: 'text', text });
  for (const tc of msg.tool_calls || []) {
    let input; try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { throw new Error('Invalid JSON in upstream tool arguments'); }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
  }
  return { id: 'msg_' + (resp.id || crypto.randomUUID()), type: 'message', role: 'assistant', model: resp.model,
    content: content.length ? content : [{ type: 'text', text: msg.refusal || '' }], stop_reason: msg.refusal ? 'refusal' : anthropicStopReason(resp.choices[0].finish_reason, msg.tool_calls?.length), stop_sequence: null,
    usage: { input_tokens: resp.usage?.prompt_tokens || 0, output_tokens: resp.usage?.completion_tokens || 0 } };
}
function anthropicToOpenAIResp(resp) {
  if (resp.error) throw new Error(resp.error.message || 'Upstream returned an error');
  if (!Array.isArray(resp.content)) throw new Error('Upstream returned no assistant content');
  if (resp.content.some(b => !['text', 'tool_use'].includes(b.type) || b.citations?.length)) throw unsupportedOutput('content blocks or citations');
  const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const tool_calls = resp.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }));
  return { id: resp.id || 'chatcmpl_router', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: resp.model,
    choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(tool_calls.length ? { tool_calls } : {}) }, finish_reason: openAIStopReason(resp.stop_reason) }],
    usage: openAIUsage(resp.usage) };
}
function openAIUsage(usage = {}) {
  const prompt_tokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  return { prompt_tokens, completion_tokens: usage.output_tokens || 0, total_tokens: prompt_tokens + (usage.output_tokens || 0) };
}
function openaiStreamToAnthropic() {
  let started = false, finished = false, blockIndex = -1, textOpen = false, finishReason = null, argumentBytes = 0, refusal = false;
  const tools = new Map(), usage = { input_tokens: 0, output_tokens: 0 };
  return {
    onData(obj) {
      const events = [];
      if (finished) return events;
      if (obj.error) throw new Error(obj.error.message || 'Upstream stream failed');
      if (obj.usage) { usage.input_tokens = obj.usage.prompt_tokens ?? usage.input_tokens; usage.output_tokens = obj.usage.completion_tokens ?? usage.output_tokens; }
      if (!started) {
        started = true;
        events.push({ type: 'message_start', message: { id: 'msg_' + (obj.id || crypto.randomUUID()), type: 'message', role: 'assistant', model: obj.model || '', content: [], stop_reason: null, stop_sequence: null, usage: { ...usage } } });
      }
      if (finishReason) return events;
      const delta = obj.choices?.[0]?.delta || {};
      if (obj.choices?.length > 1 || delta.reasoning_content || delta.audio || delta.annotations?.length || delta.function_call) throw unsupportedOutput('multiple choices, reasoning, audio, annotations, or legacy function calls');
      if (delta.refusal) refusal = true;
      const text = delta.content || delta.refusal;
      if (typeof text === 'string' && text) {
        if (!textOpen) { blockIndex++; textOpen = true; events.push({ type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } }); }
        events.push({ type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text } });
      }
      for (const tc of delta.tool_calls || []) {
        const index = tc.index ?? 0;
        if (!tools.has(index)) { if (tools.size >= 128) throw new Error('Too many upstream tool calls'); tools.set(index, { id: '', name: '', arguments: '' }); }
        const tool = tools.get(index);
        if (tc.id) tool.id = tc.id;
        if (tc.function?.name) tool.name += tc.function.name;
        if (tc.function?.arguments) { argumentBytes += Buffer.byteLength(tc.function.arguments); if (argumentBytes > MAX_EVENT_BYTES) throw new Error('Upstream tool arguments exceed 1 MiB'); tool.arguments += tc.function.arguments; }
      }
      finishReason = obj.choices?.[0]?.finish_reason || null;
      return events;
    },
    forceStop(events) {
      if (finished) return;
      if (!started || !finishReason) throw new Error('Upstream stream ended before finish_reason');
      const completed = [...tools.values()].map(tool => {
        if (!tool.id || !tool.name) throw new Error('Upstream returned an incomplete tool call');
        let input; try { input = JSON.parse(tool.arguments || '{}'); } catch { throw new Error('Invalid JSON in upstream tool arguments'); }
        return { type: 'tool_use', id: tool.id, name: tool.name, input };
      });
      finished = true;
      if (textOpen) events.push({ type: 'content_block_stop', index: blockIndex });
      for (const tool of completed) {
        blockIndex++;
        events.push({ type: 'content_block_start', index: blockIndex, content_block: { ...tool, input: {} } },
          { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } }, { type: 'content_block_stop', index: blockIndex });
      }
      events.push({ type: 'message_delta', delta: { stop_reason: refusal ? 'refusal' : anthropicStopReason(finishReason, tools.size), stop_sequence: null }, usage: { ...usage } }, { type: 'message_stop' });
    },
  };
}
function anthropicStreamToOpenAI({ includeUsage = false } = {}) {
  let id = 'chatcmpl_router', model = '', started = false, stopped = false, reason = null, nextTool = 0, argumentBytes = 0;
  const tools = new Map(); let usage = {};
  const chunk = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] });
  return {
    onEvent(ev) {
      if (ev.type === 'error') throw new Error(ev.error?.message || 'Upstream stream failed');
      const out = [];
      if (stopped) return out;
      if ((ev.type === 'content_block_start' && !['text', 'tool_use'].includes(ev.content_block?.type)) || (ev.type === 'content_block_delta' && !['text_delta', 'input_json_delta'].includes(ev.delta?.type))) throw unsupportedOutput('content block or delta');
      if (ev.type === 'message_start') { started = true; id = 'chatcmpl_' + (ev.message?.id || crypto.randomUUID()); model = ev.message?.model || ''; usage = { ...ev.message?.usage }; out.push(chunk({ role: 'assistant', content: '' })); }
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'text' && ev.content_block.text) out.push(chunk({ content: ev.content_block.text }));
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        if (tools.size >= 128) throw new Error('Too many upstream tool calls');
        const tool = { index: nextTool++, id: ev.content_block.id, name: ev.content_block.name, arguments: '', input: ev.content_block.input || {} }; tools.set(ev.index, tool);
        out.push(chunk({ tool_calls: [{ index: tool.index, id: tool.id, type: 'function', function: { name: tool.name, arguments: '' } }] }));
      }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') out.push(chunk({ content: ev.delta.text }));
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta') {
        const tool = tools.get(ev.index); if (!tool) throw new Error('Upstream tool delta has no matching tool');
        argumentBytes += Buffer.byteLength(ev.delta.partial_json); if (argumentBytes > MAX_EVENT_BYTES) throw new Error('Upstream tool arguments exceed 1 MiB');
        tool.arguments += ev.delta.partial_json;
        out.push(chunk({ tool_calls: [{ index: tool.index, function: { arguments: ev.delta.partial_json } }] }));
      }
      if (ev.type === 'message_delta') { reason = ev.delta?.stop_reason || reason; usage = { ...usage, ...ev.usage }; }
      if (ev.type === 'message_stop') stopped = true;
      return out;
    },
    forceStop(out) {
      if (!started || !stopped || !reason) throw new Error('Upstream stream ended before message_stop');
      for (const tool of tools.values()) {
        if (!tool.id || !tool.name) throw new Error('Upstream returned an incomplete tool call');
        try { JSON.parse(tool.arguments || JSON.stringify(tool.input)); } catch { throw new Error('Invalid JSON in upstream tool arguments'); }
        if (!tool.arguments) out.push(chunk({ tool_calls: [{ index: tool.index, function: { arguments: JSON.stringify(tool.input) } }] }));
      }
      out.push(chunk({}, openAIStopReason(reason)));
      if (includeUsage) out.push({ ...chunk({}), choices: [], usage: openAIUsage(usage) });
    },
  };
}
function endpointUrl(provider, format) {
  const base = provider.baseUrl.replace(/\/+$/, '');
  if (provider.endpointPath && !['responses', 'count_tokens'].includes(format)) return base + '/' + provider.endpointPath.replace(/^\/+/, '');
  const ep = format === 'responses' ? 'responses' : format === 'count_tokens' ? 'messages/count_tokens' : provider.type === 'anthropic' ? 'messages' : 'chat/completions';
  return /\/(?:v\d+(?:beta)?|openai)$/.test(base) ? `${base}/${ep}` : `${base}/v1/${ep}`;
}
function buildUpstream(provider, body, clientFormat) {
  const native = clientFormat === 'responses' || clientFormat === 'count_tokens';
  const same = native || (clientFormat === 'anthropic') === (provider.type === 'anthropic');
  const prepared = sanitizeThinking({ ...body, model: provider.defaultModel }, provider.compat);
  let upstreamBody = same ? prepared : clientFormat === 'anthropic' ? anthropicToOpenAI(prepared) : openAIToAnthropicReq(prepared);
  const compat = provider.compat || {};
  if (compat.singleToolCall && upstreamBody.tools?.length) upstreamBody = provider.type === 'anthropic' ? { ...upstreamBody, tool_choice: { ...upstreamBody.tool_choice, type: upstreamBody.tool_choice?.type || 'auto', disable_parallel_tool_use: true } } : { ...upstreamBody, parallel_tool_calls: false };
  if (compat.noReasoningEffortWithTools && upstreamBody.tools?.length && upstreamBody.reasoning_effort) upstreamBody = { ...upstreamBody, reasoning_effort: 'none' };
  const headers = { 'content-type': 'application/json' };
  if (provider.type === 'anthropic') { headers['anthropic-version'] = '2023-06-01'; if (provider.apiKey) headers['x-api-key'] = provider.apiKey; }
  else if (provider.apiKey) headers.authorization = 'Bearer ' + provider.apiKey;
  if (provider.userAgent?.trim()) headers['user-agent'] = provider.userAgent.trim();
  for (const [key, value] of Object.entries(provider.headers || {})) if (typeof value === 'string' && key.trim()) headers[key.trim().toLowerCase()] = value;
  return { same, upstreamBody, headers };
}
const errorFor = (format, message) => format === 'anthropic' || format === 'count_tokens' ? { type: 'error', error: { type: 'api_error', message } } : { error: { message } };
module.exports = { sanitizeThinking, anthropicToOpenAI, openAIToAnthropicReq, openAIToAnthropicResp, anthropicToOpenAIResp,
  openaiStreamToAnthropic, anthropicStreamToOpenAI, mergeConsecutive, endpointUrl, buildUpstream, errorFor };
