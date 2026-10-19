// Refresh bundled public model presets. Does not touch DATA_DIR or production.
const fs = require('node:fs');
const path = require('node:path');
const { verifyFreeLLMCatalog, snapshot } = require('../lib/provider-models');

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error(`${url}: HTTP ${response.status}`);
  return response;
}
function plainText(html) {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}
async function update() {
  const [freellmResponse, openrouter, nvidia, electronhub, simplellm, geminiPricing, cloudflarePricing, kilo] = await Promise.all([
    get('https://api.freellmapi.co/v1/latest'),
    get('https://openrouter.ai/api/v1/models').then(r => r.json()),
    get('https://integrate.api.nvidia.com/v1/models').then(r => r.json()),
    get('https://api.electronhub.ai/v1/models').then(r => r.json()),
    get('https://simplellm.eu/api/models').then(r => r.json()),
    get('https://ai.google.dev/gemini-api/docs/pricing').then(r => r.text()).then(plainText),
    get('https://developers.cloudflare.com/workers-ai/platform/pricing/').then(r => r.text()).then(plainText),
    get('https://api.kilo.ai/api/gateway/models').then(r => r.json()),
  ]);
  const freellm = verifyFreeLLMCatalog(Buffer.from(await freellmResponse.arrayBuffer()), freellmResponse.headers.get('x-catalog-signature'));
  const result = snapshot({ freellm, openrouter, nvidia, electronhub, simplellm, geminiPricing, cloudflarePricing, kilo }, new Date().toISOString().slice(0, 10));
  for (const id of ['gemini', 'cloudflare', 'nvidia', 'electronhub', 'simplellm', 'kilo']) {
    if (!result.providers[id]?.length) throw Error(`${id}: model refresh returned no eligible models; keeping the previous bundled snapshot`);
  }
  if (result.providers.openrouter.length < 2) throw Error('OpenRouter returned no eligible explicit free models; keeping the previous bundled snapshot');
  const file = path.join(__dirname, '..', 'lib', 'provider-models.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(result, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
  console.log(`Updated public model presets from FreeLLMAPI ${result.freellmVersion} and official catalogs. Review the diff and run tests before deploying.`);
}

if (require.main === module) update().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { plainText };
