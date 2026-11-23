const { httpUrl, inputError } = require('../validation');

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 2000;
const TIMEOUT_MS = 15_000;

// Same base-URL rule as chat endpoints: a trailing /v1 (or /openai) is kept, otherwise /v1 is added.
function modelsUrl(provider) {
  const base = httpUrl(provider.baseUrl).href.replace(/\/+$/, '');
  const url = /\/(?:v\d+(?:beta)?|openai)$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  return provider.type === 'anthropic' ? `${url}?limit=1000` : url;
}

function headersFor(provider) {
  const headers = { accept: 'application/json' };
  if (provider.type === 'anthropic') { headers['anthropic-version'] = '2023-06-01'; if (provider.apiKey) headers['x-api-key'] = provider.apiKey; }
  else if (provider.apiKey) headers.authorization = 'Bearer ' + provider.apiKey;
  if (provider.userAgent?.trim()) headers['user-agent'] = provider.userAgent.trim();
  for (const [key, value] of Object.entries(provider.headers || {})) if (typeof value === 'string' && key.trim()) headers[key.trim().toLowerCase()] = value;
  return headers;
}

// Providers disagree on the envelope: OpenAI/Anthropic use {data:[...]}, Ollama {models:[...]},
// Cloudflare {result:[...]}, and a few return a bare array. Entries may use id, name or model.
function parseModels(body) {
  const rows = Array.isArray(body) ? body : body?.data ?? body?.models ?? body?.result;
  if (!Array.isArray(rows)) throw inputError('This provider did not return a model list', 502);
  const seen = new Map();
  for (const row of rows) {
    const id = typeof row === 'string' ? row : row?.id ?? row?.name ?? row?.model;
    if (typeof id !== 'string' || !id || id.length > 256 || /[\x00-\x1f\x7f]/.test(id) || seen.has(id)) continue;
    const label = typeof row === 'object' ? row.display_name ?? row.displayName : undefined;
    seen.set(id, { id, ...(typeof label === 'string' && label && label !== id ? { name: label } : {}) });
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_MODELS);
}

async function readLimited(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw inputError('Model list is too large', 502);
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) { size += chunk.length; if (size > MAX_BYTES) throw inputError('Model list is too large', 502); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks).toString('utf8');
}

async function listModels(provider, fetchImpl = fetch) {
  let response;
  try { response = await fetchImpl(modelsUrl(provider), { headers: headersFor(provider), redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (error) { if (error.status) throw error; throw inputError(`Could not reach the provider: ${error.name === 'TimeoutError' ? 'timed out' : error.cause?.code || error.message}`, 502); }
  const text = await readLimited(response);
  if (!response.ok) {
    let detail = ''; try { const parsed = JSON.parse(text); detail = parsed.error?.message || parsed.message || ''; } catch {}
    throw inputError(`Provider returned ${response.status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`, 502);
  }
  let body; try { body = JSON.parse(text); } catch { throw inputError('Provider returned a non-JSON model list', 502); }
  return parseModels(body);
}

module.exports = { modelsUrl, headersFor, parseModels, listModels };
