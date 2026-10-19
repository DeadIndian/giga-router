const assert = require('node:assert/strict');
const { test } = require('node:test');
const { snapshot, chatModel, verifyFreeLLMCatalog } = require('./lib/provider-models');

test('community model filter excludes disabled entries and unsupported modalities', () => {
  const base = { modelId: 'chat-model', enabled: true };
  assert.equal(chatModel(base), true);
  for (const row of [{ ...base, enabled: false }, { ...base, modality: 'image' }, { ...base, modality: 'audio' }, { ...base, modelId: 'text-embed-model' }, { ...base, modelId: 'model\n' }, { ...base, modelId: 'gemini-3.8-live' }, { ...base, modelId: 'codestral-code-fim-latest' }]) assert.equal(chatModel(row), false);
  assert.throws(() => verifyFreeLLMCatalog(Buffer.from('{}'), ''), /signature/);
  assert.throws(() => verifyFreeLLMCatalog(Buffer.from('{}'), Buffer.alloc(64).toString('base64')), /signature/);
});

test('official catalogs replace stale free IDs and retain only eligible model types', () => {
  const model = (platform, modelId) => ({ platform, modelId, enabled: true, displayName: modelId });
  const result = snapshot({
    freellm: { version: 'test', models: [model('openrouter', 'retired:free'), model('nvidia', 'retired'), model('cloudflare', '@cf/free-chat'), model('cloudflare', '@cf/paid-chat'), model('google', 'gemini-free'), model('google', 'gemini-paid'), model('waterfall', 'community-free'), { ...model('waterfall', 'image-free'), modality: 'image' }, model('electronhub', 'credit-backed')] },
    openrouter: { data: [ { id: 'current:free', name: 'Current', pricing: { prompt: '0', completion: '0' } }, { id: 'paid:free', pricing: { prompt: '1', completion: '0' } }, { id: 'missing-price:free', pricing: { prompt: null, completion: null } }, { id: 'audio:free', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['audio'] } } ] },
    nvidia: { data: [{ id: 'current-chat' }, { id: 'embed-model' }] },
    electronhub: { data: [{ id: 'chat:free', endpoints: ['/v1/chat/completions'] }, { id: 'premium:free', premium_model: true, endpoints: ['/v1/chat/completions'] }, { id: 'image:free', endpoints: ['/v1/images/generations'] }, { id: 'credit-backed', endpoints: ['/v1/chat/completions'] }] },
    simplellm: [{ id: 'free-alias', enabled: true, status: 'available', price_sc_input: 0, price_sc_output: 0 }, { id: 'paid', enabled: true, status: 'available', price_sc_input: 1, price_sc_output: 0 }, { id: 'disabled', enabled: false, status: 'available', price_sc_input: 0, price_sc_output: 0 }],
    geminiPricing: 'gemini-free Free Tier Input price Free of charge Output price Free of charge ' + ' '.repeat(1600) + 'gemini-paid Free Tier Input price Not available Output price Not available',
    cloudflarePricing: 'Some models require a paid billing method @cf/paid-chat Pay with AI Gateway credits. @cf/free-chat price table.',
    kilo: { data: [{ id: 'kilo-free:free', isFree: true, pricing: { prompt: '0', completion: '0' } }, { id: 'kilo-paid', isFree: false, pricing: { prompt: '0', completion: '0' } }] },
  }, '2026-10-19');
  const ids = provider => result.providers[provider].map(model => model.id);
  assert.deepEqual(ids('openrouter'), ['current:free', 'openrouter/free']);
  assert.deepEqual(ids('nvidia'), ['current-chat']);
  assert.deepEqual(ids('cloudflare'), ['@cf/free-chat']);
  assert.deepEqual(ids('gemini'), ['gemini-free']);
  assert.deepEqual(ids('waterfall'), ['community-free']);
  assert.deepEqual(ids('electronhub'), ['chat:free', 'credit-backed']);
  assert.deepEqual(ids('simplellm'), ['free-alias']);
  assert.deepEqual(ids('kilo'), ['kilo-free:free']);
});
