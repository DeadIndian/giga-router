// Public, documentation-checked presets. Never include keys or session credentials.
const { inputError } = require('./validation');
const VERIFIED_AT = '2026-10-19';
const PROVIDERS = [
  {
    id: 'groq', name: 'Groq', tier: 'Free tier', group: 'free',
    keyUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs/rate-limits',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
    note: 'Free plan with model-specific request and token limits. Limits apply to your organization.',
  },
  {
    id: 'gemini', name: 'Google AI Studio', tier: 'Free tier', group: 'free',
    keyUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash', 'gemini-3.8-flash'],
    note: 'Use a project on the free tier. Region and project limits apply; free-tier data may be used to improve Google products.',
  },
  {
    id: 'mistral', name: 'Mistral', tier: 'Free tier', group: 'free',
    keyUrl: 'https://console.mistral.ai/api-keys/',
    docsUrl: 'https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key',
    baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-small-latest'],
    note: 'Studio Free mode is enabled by default, with no credit card required. Usage and rate limits apply.',
  },
  {
    id: 'openrouter', name: 'OpenRouter', tier: 'Free models', group: 'free',
    keyUrl: 'https://openrouter.ai/keys',
    docsUrl: 'https://openrouter.ai/docs/api/reference/limits',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openrouter/free', 'minimax/minimax-m3.1-flash:free', 'nvidia/nemotron-3.5-lightning:free', 'google/gemma-4-26b-a4b-it:free', 'cohere/north-mini-code:free', 'nvidia/nemotron-3-super-120b-a12b:free'],
    note: 'The free router chooses an available free model. Other free model IDs end in :free. Multiple keys or accounts do not increase OpenRouter rate limits.',
  },
  {
    id: 'cloudflare', name: 'Cloudflare Workers AI', tier: 'Daily free quota', group: 'free',
    keyUrl: 'https://dash.cloudflare.com/',
    docsUrl: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1',
    models: ['@cf/meta/llama-3.1-8b-instruct'], accountIdRequired: true,
    note: '10,000 neurons per day on the free plan. Create a token with Workers AI permission and copy your account ID. Some frontier models require payment.',
  },
  {
    id: 'nvidia', name: 'NVIDIA NIM', tier: 'Free development API', group: 'limited',
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    docsUrl: 'https://build.nvidia.com/explore/discover',
    baseUrl: 'https://integrate.api.nvidia.com/v1', models: ['meta/llama-3.1-8b-instruct'],
    note: 'Free serverless endpoints for development. Model access and allowances depend on your account; check the selected model page.',
  },
  {
    id: 'cohere', name: 'Cohere', tier: 'Free evaluation key', group: 'limited',
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    docsUrl: 'https://docs.cohere.com/docs/rate-limits',
    baseUrl: 'https://api.cohere.ai/compatibility/v1', models: ['command-a-plus-05-2026'],
    note: 'Evaluation keys are free with a 1,000-call monthly limit and model-specific rate limits. Production keys are paid.',
  },
  {
    id: 'agnes', name: 'Agnes', tier: 'Free status unverified', group: 'unverified',
    keyUrl: 'https://platform.agnes-ai.com', docsUrl: 'https://platform.agnes-ai.com',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    models: ['agnes-2.0-flash', 'agnes-2.5-flash', 'agnes-3.0-flash'],
    note: 'API-key preset from OmniRoute. Public free quota terms could not be independently verified; check your account before sending requests.',
  },
].map(entry => ({ ...entry, defaultModel: entry.models[0], verifiedAt: entry.group === 'unverified' ? null : VERIFIED_AT }));

function catalog() { return structuredClone(PROVIDERS); }
function findProvider(id) { return PROVIDERS.find(entry => entry.id === id); }
function line(value, label, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\x00-\x1f]/.test(value)) throw inputError(`${label} must be a nonempty single-line string (up to ${max} characters)`);
  return value.trim();
}
function accountPreset(id, body) {
  const entry = findProvider(id);
  if (!entry) throw inputError('Unknown provider preset', 404);
  const apiKey = line(body.apiKey, 'API key', 8192);
  if (apiKey === '***') throw inputError('Enter an API key for this account');
  const accountLabel = line(body.accountLabel || 'Personal', 'Account label', 80);
  const defaultModel = line(body.defaultModel === undefined ? entry.defaultModel : body.defaultModel, 'Model ID');
  let baseUrl = entry.baseUrl;
  if (entry.accountIdRequired) {
    const accountId = line(body.accountId, 'Cloudflare account ID', 32);
    if (!/^[a-f0-9]{32}$/i.test(accountId)) throw inputError('Cloudflare account ID must be 32 hexadecimal characters');
    baseUrl = baseUrl.replace('{accountId}', accountId);
  }
  return { name: `${entry.name} · ${accountLabel}`, catalogId: id, accountLabel, type: 'openai', baseUrl, defaultModel, apiKey };
}

// Import only explicit API-key exports, never OAuth tokens or browser sessions.
const aliases = { google: 'gemini', 'google-ai': 'gemini', 'google_ai': 'gemini', 'google-ai-studio': 'gemini', 'googleaistudio': 'gemini', 'workersai': 'cloudflare' };
function importAccounts(document) {
  const freeLLM = document?.source === 'freellmapi' && document?.version === 1 && Array.isArray(document.keys);
  const giga = document?.source === 'giga-router-apikeys' && document?.version === 1 && Array.isArray(document.accounts);
  if (!freeLLM && !giga) throw inputError('Use a FreeLLMAPI JSON key export or a Giga Router API-key export');
  const records = freeLLM ? document.keys : document.accounts;
  if (!records.length || records.length > 200) throw inputError('Import between 1 and 200 accounts at a time');
  const accounts = [], skipped = [];
  records.forEach((record, index) => {
    // Error/skip messages never include fields from the secret-bearing source.
    if (!record || typeof record !== 'object') throw inputError(`Account ${index + 1} is invalid`);
    if ((record.authType && record.authType !== 'apikey') || (record.auth_type && record.auth_type !== 'apikey')) { skipped.push({ index: index + 1, reason: 'Only API-key accounts are supported' }); return; }
    const sourceId = freeLLM ? record.platform : record.catalogId;
    const id = typeof sourceId === 'string' ? (aliases[sourceId.toLowerCase()] || sourceId.toLowerCase()) : '';
    if (!findProvider(id)) { skipped.push({ index: index + 1, reason: 'Provider has no supported preset; add it as a custom API provider' }); return; }
    try {
      let accountId = record.accountId;
      let apiKey = freeLLM ? record.key : record.apiKey;
      // FreeLLMAPI stores Workers AI credentials as account_id:token.
      if (id === 'cloudflare' && typeof apiKey === 'string') {
        const compound = /^([a-f0-9]{32}):(.+)$/i.exec(apiKey);
        if (compound) {
          if (accountId && accountId !== compound[1]) throw inputError('Conflicting account IDs');
          accountId = compound[1]; apiKey = compound[2];
        }
      }
      if (id === 'cloudflare' && !accountId && typeof record.baseUrl === 'string') accountId = /\/accounts\/([a-f0-9]{32})\//i.exec(record.baseUrl)?.[1];
      accounts.push(accountPreset(id, { apiKey, accountLabel: (freeLLM ? record.label : record.accountLabel) || `Imported ${index + 1}`, defaultModel: record.defaultModel, accountId }));
    } catch { throw inputError(`Account ${index + 1}: check the API key, account label, model ID, and required account ID`); }
  });
  return { accounts, skipped };
}

module.exports = { catalog, findProvider, accountPreset, importAccounts, VERIFIED_AT };
