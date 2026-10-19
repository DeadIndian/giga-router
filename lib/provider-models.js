const crypto = require('node:crypto');

const CATALOG_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAq9yv4+3EeyMHKsfVYBhkcz1lYgIXSUeHNnN6tNgYX3k=
-----END PUBLIC KEY-----`;
const CHAT_ONLY = /(?:embed|rerank|prompt-guard|llama-guard|sea-guard|content-safety|safeguard|safety-guard|nemoguard|voxtral|whisper|tts|realtime|live|code-fim|ising-|diffusion|detector|reward|nemotron-parse|deplot|nvclip|riva-)/i;

function modelId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}
function verifyFreeLLMCatalog(bytes, signature) {
  if (!signature || !crypto.verify(null, bytes, CATALOG_KEY, Buffer.from(signature, 'base64'))) throw Error('FreeLLMAPI catalog signature verification failed');
  const document = JSON.parse(bytes);
  if (document.tier !== 'monthly' || typeof document.version !== 'string' || !Array.isArray(document.models)) throw Error('Expected the public monthly FreeLLMAPI catalog');
  return document;
}
function chatModel(row) {
  return row.enabled === true && (!row.modality || row.modality === 'text') && modelId(row.modelId) && !CHAT_ONLY.test(row.modelId);
}
function zero(value) { return value !== null && value !== undefined && value !== '' && Number(value) === 0; }
function snapshot(sources, checkedAt) {
  const providers = {};
  function add(provider, id, metadata) {
    if (!modelId(id) || CHAT_ONLY.test(id)) return;
    providers[provider] ||= [];
    const row = { id, ...metadata };
    const previous = providers[provider].findIndex(model => model.id === id);
    if (previous >= 0) providers[provider][previous] = row;
    else providers[provider].push(row);
  }
  for (const row of sources.freellm.models.filter(chatModel)) {
    add(row.platform === 'google' ? 'gemini' : row.platform, row.modelId, {
      name: row.displayName || row.modelId, source: 'FreeLLMAPI public catalog',
      status: 'Source-listed free access; check provider terms',
      ...(Number.isSafeInteger(row.contextWindow) && row.contextWindow > 0 ? { contextWindow: row.contextWindow } : {}),
      ...(typeof row.supportsTools === 'boolean' ? { supportsTools: row.supportsTools } : {}),
      ...(typeof row.supportsVision === 'boolean' ? { supportsVision: row.supportsVision } : {}),
    });
  }
  // A current official catalog wins over the trailing community snapshot.
  providers.openrouter = [];
  for (const row of sources.openrouter.data) {
    if (modelId(row.id) && row.id.endsWith(':free') && zero(row.pricing?.prompt) && zero(row.pricing?.completion) &&
        (!row.architecture?.output_modalities || row.architecture.output_modalities.includes('text'))) {
      add('openrouter', row.id, { name: row.name || row.id, source: 'OpenRouter public API', status: 'Zero prompt and completion prices', contextWindow: row.context_length || null, supportsTools: row.supported_parameters?.includes('tools') || false });
    }
  }
  add('openrouter', 'openrouter/free', { name: 'Free router', source: 'OpenRouter', status: 'Chooses an available free model' });
  const currentNvidia = new Set(sources.nvidia.data.map(row => row.id));
  providers.nvidia = (providers.nvidia || []).filter(row => currentNvidia.has(row.id));
  for (const row of sources.nvidia.data) {
    if (!CHAT_ONLY.test(row.id) && !/(?:fuyu|kosmos|vila|neva|riva|cosmos|starcoder|codegemma|deepseek-coder|recurrentgemma)/i.test(row.id)) add('nvidia', row.id, { name: row.id, source: 'NVIDIA public API', status: 'Development allowance; check account/model access' });
  }
  providers.electronhub = [];
  for (const row of sources.electronhub.data) {
    if (row.premium_model === true || !row.endpoints?.includes('/v1/chat/completions')) continue;
    if (row.id.endsWith(':free')) {
      add('electronhub', row.id, { name: row.name || row.id, source: 'ElectronHub public API', status: 'Daily free Neutrinos; per-request quota cost varies' });
    } else if (sources.freellm.models.some(model => model.platform === 'electronhub' && model.modelId === row.id && chatModel(model))) {
      add('electronhub', row.id, { name: row.name || row.id, source: 'ElectronHub API + FreeLLMAPI', status: 'Consumes shared weekly credits; token prices may be nonzero' });
    }
  }
  providers.simplellm = [];
  for (const row of sources.simplellm.models || sources.simplellm.data || sources.simplellm) {
    if (row.enabled === true && row.status === 'available' && zero(row.price_sc_input) && zero(row.price_sc_output)) add('simplellm', row.id, { name: row.display_name || row.id, source: 'SimpleLLM public pricing API', status: 'Zero input/output prices; hourly and daily quotas apply' });
  }
  if (sources.kilo) {
    providers.kilo = [];
    for (const row of sources.kilo.data || sources.kilo.models || []) {
      if (row.isFree === true && zero(row.pricing?.prompt) && zero(row.pricing?.completion)) add('kilo', row.id, { name: row.name || row.id, source: 'Kilo public model API', status: 'Listed free with zero input/output prices; provider terms apply' });
    }
  }
  // Official Gemini pricing explicitly distinguishes free from paid-only models.
  const geminiText = sources.geminiPricing;
  providers.gemini = (providers.gemini || []).filter(row => {
    const index = geminiText.indexOf(row.id);
    if (index < 0) return false;
    const section = geminiText.slice(index, index + 1600);
    return /Free Tier[\s\S]*?Input price\s+Free of charge/.test(section) && /Output price[\s\S]*?Free of charge/.test(section);
  }).map(row => ({ ...row, source: 'Google pricing + FreeLLMAPI', status: 'Documented free-tier input/output; project limits apply' }));
  const paidCloudflare = sources.cloudflarePricing.match(/Some models require a paid billing method[\s\S]*?Pay with AI Gateway credits/)?.[0];
  if (!paidCloudflare) throw Error('Could not identify Cloudflare paid-only exclusions');
  providers.cloudflare = (providers.cloudflare || []).filter(row => sources.cloudflarePricing.includes(row.id) && !paidCloudflare.includes(row.id)).map(row => ({ ...row, source: 'Cloudflare pricing + FreeLLMAPI', status: 'Uses daily free Neurons on Workers Free; overage on paid plans is billable' }));
  return { version: 1, checkedAt, freellmVersion: sources.freellm.version, providers };
}

module.exports = { verifyFreeLLMCatalog, chatModel, snapshot, CHAT_ONLY };
