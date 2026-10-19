// Public, documentation-checked presets. Never include keys or session credentials.
const { inputError } = require('./validation');
const MODEL_SNAPSHOT = require('./provider-models.json');
const VERIFIED_AT = MODEL_SNAPSHOT.checkedAt;
const FREE_LLM_SOURCE = 'https://api.freellmapi.co/v1/latest';
const OMNI_SOURCE = 'https://www.npmjs.com/package/omniroute';
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
    baseUrl: 'https://integrate.api.nvidia.com/v1', models: ['nvidia/nemotron-3-super-120b-a12b'], compat: { singleToolCall: true },
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
];

const EXTRA_PROVIDERS = [
  { id: 'electronhub', name: 'ElectronHub', group: 'free', tier: 'Daily requests + weekly credits', keyUrl: 'https://app.electronhub.ai', baseUrl: 'https://api.electronhub.ai/v1', docsUrl: 'https://docs.electronhub.ai/billing/credits', defaultModel: 'gpt-oss-20b:free', note: 'Free accounts receive 10 Neutrinos/day for :free routes and $0.25 shared weekly credits for eligible credit-backed routes. Requests can cost several Neutrinos. Check model access and spending controls.' },
  { id: 'simplellm', name: 'SimpleLLM', group: 'free', tier: 'Free models', keyUrl: 'https://app.simplellm.eu', baseUrl: 'https://api.simplellm.eu/v1', docsUrl: 'https://simplellm.eu/docs/limits.html', defaultModel: 'free-Llama-3.1-8B-Instruct', note: 'Public pricing lists zero input/output prices for these free aliases. Hourly/daily request and token limits apply. A listed alias can temporarily have an unavailable backend.' },
  { id: 'inferbase', name: 'Inferbase', group: 'free', tier: 'Monthly + daily free allowance', keyUrl: 'https://inferbase.ai', baseUrl: 'https://api.inferbase.ai/v1', docsUrl: 'https://inferbase.ai/pricing', models: ['openai-gpt-oss-20b', 'openai-gpt-oss-120b', 'google-gemma-4-31b-it', 'meta-llama-3-1-8b-instruct', 'qwen3-30b-a3b'], note: 'Free plan: 5,000 requests/month, with 100 managed requests and $0.50 model usage/day. The allowance is shared across models. Free managed inference has an output cap; keep max_tokens at or below 1,024.' },
  { id: 'typhoon', name: 'Typhoon', group: 'limited', tier: 'Free research API', keyUrl: 'https://playground.opentyphoon.ai', baseUrl: 'https://api.opentyphoon.ai/v1', docsUrl: 'https://docs.opentyphoon.ai/en/faq/', models: ['typhoon-v2.5-30b-a3b-instruct', 'typhoon-v2.1-12b-instruct'], note: 'Officially free research showcase, optimized for Thai and English. Rate limits apply; usage data is collected to improve the service.' },
  { id: 'ollama', name: 'Ollama Cloud', keyUrl: 'https://ollama.com/settings/keys', baseUrl: 'https://ollama.com/v1', docsUrl: 'https://ollama.com/pricing', note: 'FreeLLMAPI-listed starter models. Current pricing offers starter usage credits; this is not a verified recurring free allowance. Subscription or purchased credits may be required when the allowance is exhausted.' },
  { id: 'zhipu', name: 'Zhipu (China API)', keyUrl: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', docsUrl: 'https://open.bigmodel.cn/pricing', note: 'FreeLLMAPI lists GLM Flash models on the domestic API. Chinese account verification may apply. Keys for the separate global Z.ai console do not necessarily work on this endpoint.' },
  { id: 'modelscope', name: 'ModelScope', keyUrl: 'https://modelscope.cn/my/myaccesstoken', baseUrl: 'https://api-inference.modelscope.cn/v1', docsUrl: 'https://modelscope.cn/docs/model-service/API-Inference/intro', note: 'Source-listed shared daily free requests. Requires binding to an Alibaba Cloud China account with Chinese real-name verification. Check live quota and model access in your account.' },
  { id: 'sealion', name: 'SEA-LION', keyUrl: 'https://sea-lion.ai', baseUrl: 'https://api.sea-lion.ai/v1', docsUrl: 'https://sea-lion.ai', note: 'AI Singapore API models listed by FreeLLMAPI as rate-limited free access. Public quota terms have not been independently verified here.' },
  { id: 'llm7', name: 'LLM7', keyUrl: 'https://llm7.io', baseUrl: 'https://api.llm7.io/v1', docsUrl: 'https://llm7.io', defaultModel: 'default', note: 'Source-listed free aggregator with hourly limits. Add a normal API key; this integration does not use browser sessions.' },
  { id: 'bazaarlink', name: 'BazaarLink', keyUrl: 'https://bazaarlink.ai', baseUrl: 'https://bazaarlink.ai/api/v1', docsUrl: 'https://bazaarlink.ai', defaultModel: 'auto:free', note: 'Source-listed free aliases. Use auto:free or a :free model; direct non-free IDs may be paid.' },
  { id: 'aion', name: 'Aion Labs', keyUrl: 'https://www.aionlabs.ai', baseUrl: 'https://api.aionlabs.ai/v1', docsUrl: 'https://www.aionlabs.ai', note: 'FreeLLMAPI-listed models. Availability and free quota require confirmation in your account.' },
  { id: 'requesty', name: 'Requesty', keyUrl: 'https://www.requesty.ai', baseUrl: 'https://router.requesty.ai/v1', docsUrl: 'https://docs.requesty.ai', note: 'FreeLLMAPI-listed routes. Confirm pricing and spending controls; a model being listed does not guarantee zero charges for your account.' },
  { id: 'nara', name: 'NaraRouter', keyUrl: 'https://router.bynara.id', baseUrl: 'https://router.bynara.id/v1', docsUrl: 'https://router.bynara.id', note: 'Source-listed free routes. Account/Telegram verification may be required; other routes can be credit or plan gated.' },
  { id: 'xkiro', name: 'xKiro', keyUrl: 'https://xkiro.com', baseUrl: 'https://api.xkiro.com/v1', docsUrl: 'https://xkiro.com', note: 'FreeLLMAPI-listed free-plan models; other models require a paid account. Verify current daily token limits in your dashboard.' },
  { id: 'unorouter', name: 'UnoRouter', keyUrl: 'https://unorouter.com', baseUrl: 'https://api.unorouter.com/v1', docsUrl: 'https://unorouter.com', note: 'Source-listed :free models. Per-model and account limits apply; the marketing domain is separate from the API host.' },
  { id: 'radeon', name: 'AMD Radeon Cloud', keyUrl: 'https://developer.amd.com.cn/radeon/tokenfactory', baseUrl: 'https://developer.amd.com.cn/radeon/api/v1', docsUrl: 'https://developer.amd.com.cn/radeon', compat: { singleToolCall: true }, note: 'Experimental shared Model API listed as free by FreeLLMAPI. Model IDs may rotate; GPU-instance billing is separate from this API.' },
  { id: 'routeway', name: 'Routeway', keyUrl: 'https://routeway.ai', baseUrl: 'https://api.routeway.ai/v1', docsUrl: 'https://routeway.ai', note: 'Source-listed :free models with request limits. Check current eligibility. Uses a Giga Router User-Agent; no browser credential extraction.' },
  { id: 'router9', name: 'Router9', keyUrl: 'https://www.router9.com', baseUrl: 'https://api.router9.com/v1', docsUrl: 'https://www.router9.com', note: 'FreeLLMAPI lists shared monthly credits. Model calls consume that common wallet; check your account balance and pricing.' },
  { id: 'septor', name: 'Septor Labs', keyUrl: 'https://septorlabs.com/dashboard', baseUrl: 'https://api.septorlabs.com/v1', docsUrl: 'https://septorlabs.com', note: 'Source-listed zero-price models with a shared daily quota. Signup credits are a separate one-time grant.' },
  { id: 'clod', name: 'CLōD', keyUrl: 'https://newapp.clod.io', baseUrl: 'https://api.clod.io/v1', docsUrl: 'https://clod.io', note: 'FreeLLMAPI-listed daily free-request pool. Quota and account eligibility need confirmation.' },
  { id: 'airforce', name: 'Api.Airforce', keyUrl: 'https://api.airforce', baseUrl: 'https://api.airforce/v1', docsUrl: 'https://api.airforce', note: 'Source-listed daily free requests with a one-request-per-minute limit. Confirm model identity and terms before using private prompts.' },
  { id: 'dreamprompting', name: 'DreamPrompting', keyUrl: 'https://dreamprompting.com', baseUrl: 'https://dreamprompting.com/api/v1', docsUrl: 'https://dreamprompting.com', note: 'Source-listed rolling 24-hour free token/request pool. Several IDs select an upstream provider; allowances are shared.' },
  { id: 'waterfall', name: 'Waterfall', keyUrl: 'https://getwaterfall.org', baseUrl: 'https://api.getwaterfall.org/v1', docsUrl: 'https://getwaterfall.org', note: 'Community free-model aliases listed by FreeLLMAPI. Current quotas and availability are unverified.' },
  { id: 'logfare', name: 'Logfare', keyUrl: 'https://logfare.ai', baseUrl: 'https://logfare.ai/v1', docsUrl: 'https://logfare.ai', defaultModel: 'logfare/auto', note: 'Source-listed fair-use free routes. The auto alias selects an available model; no fixed numeric quota is asserted here.' },
  { id: 'kilo', name: 'Kilo Gateway', keyUrl: 'https://app.kilo.ai', baseUrl: 'https://api.kilo.ai/api/gateway/v1', docsUrl: 'https://kilo.ai/docs/gateway', defaultModel: 'kilo-auto/free', note: 'Public catalog includes zero-price :free models. Add a normal API key; no client-session workaround is used. Free prompts may be logged for training. Models can move to paid access.' },
  { id: 'ovh', name: 'OVHcloud AI Endpoints', keyUrl: 'https://endpoints.ai.cloud.ovh.net', baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', docsUrl: 'https://endpoints.ai.cloud.ovh.net', note: 'Source-listed free inference. This preset uses an API token; obtaining one can require a Public Cloud project and payment method. Current terms and token limits must be checked.' },
  { id: 'poolside', name: 'Poolside', keyUrl: 'https://platform.poolside.ai', baseUrl: 'https://inference.poolside.ai/v1', docsUrl: 'https://poolside.ai', models: ['poolside/laguna-xs-2.1', 'poolside/laguna-s-2.1'], sourceUrl: OMNI_SOURCE, note: 'OmniRoute lists these direct API models as free during Preview. No independently verified numeric quota; check current preview terms.' },
  { id: 'longcat', name: 'LongCat', keyUrl: 'https://longcat.chat/platform', baseUrl: 'https://api.longcat.chat/openai/v1', docsUrl: 'https://longcat.chat/platform/docs', models: ['LongCat-2.0'], sourceUrl: OMNI_SOURCE, note: 'OmniRoute lists a one-time 10M-token grant after signup/KYC, while other lists claim daily access. Terms conflict, so this is not advertised as a recurring free tier.' },
];

for (const entry of EXTRA_PROVIDERS) PROVIDERS.push({ group: 'unverified', tier: 'Source-listed free access', ...entry, models: entry.models || MODEL_SNAPSHOT.providers[entry.id]?.map(model => model.id) || [] });
for (const entry of PROVIDERS) {
  const listed = MODEL_SNAPSHOT.providers[entry.id] || [];
  entry.defaultModel ||= entry.models[0];
  entry.models = [...new Set([entry.defaultModel, ...entry.models, ...listed.map(model => model.id)])];
  entry.verifiedAt = entry.group === 'unverified' ? null : VERIFIED_AT;
  entry.catalogCheckedAt = MODEL_SNAPSHOT.checkedAt;
  entry.sourceUrl ||= FREE_LLM_SOURCE;
  entry.modelDetails = entry.models.map(id => listed.find(model => model.id === id) || { id, name: id, source: entry.sourceUrl === OMNI_SOURCE ? 'OmniRoute preset' : 'Curated preset', status: 'Check model access and price with the provider' });
}

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
  return { name: `${entry.name} · ${accountLabel}`, catalogId: id, accountLabel, type: 'openai', baseUrl, defaultModel, apiKey, userAgent: 'GigaRouter/1.1', ...(entry.compat ? { compat: { ...entry.compat } } : {}) };
}

// Import only explicit API-key exports, never OAuth tokens or browser sessions.
const aliases = { google: 'gemini', 'google-ai': 'gemini', 'google_ai': 'gemini', 'google-ai-studio': 'gemini', 'googleaistudio': 'gemini', 'workersai': 'cloudflare', 'kilo-gateway': 'kilo', 'sea-lion': 'sealion' };
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
