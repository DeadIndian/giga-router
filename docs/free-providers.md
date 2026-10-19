# Free API providers and accounts

The expanded catalog includes **36 API-key providers and 387 chat-model presets**
as of 2026-10-19. Search **DeepSeek**, **Qwen**, **Gemma**, **GPT-OSS**, or any
provider in **Free APIs**, expand its model list, and click **Add this model**.
Account setup now has a model dropdown plus an option for a custom model ID.
The complete bundled IDs and per-model provenance are in
[lib/provider-models.json](../lib/provider-models.json); provider setup is in
[lib/provider-catalog.js](../lib/provider-catalog.js).

Open **Providers & routing → Free APIs**. Click **Get API key**, create a key at
the provider, then **Add account**. Give it a label such as Personal or Work,
paste its key, and choose a model. Repeat to add another key/account for the
same provider. Every account has its own ID, saved credential, model alias,
enable/disable control, and position in the fallback chain. Adding an account
keeps the active provider and existing schedules; the first account becomes
active only if none is selected.

The catalog below was checked against **official documentation on 2026-10-19**.
This verifies documented free access, not your key or a successful live inference
request. Plans, model availability, regions, and quotas can change. Other model
IDs are editable; check their price first. No cookies, browser sessions, or
subscription-login workarounds are used.

## Verified free tiers

| Provider / get a key | Preset models | Free access / official evidence |
| --- | --- | --- |
| [Groq](https://console.groq.com/keys) | `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` | [Free Plan limits](https://console.groq.com/docs/rate-limits), per model and organization. |
| [Google AI Studio](https://aistudio.google.com/apikey) | `gemini-2.5-flash`, `gemini-3.8-flash` | [Free-tier pricing](https://ai.google.dev/gemini-api/docs/pricing). Use a free-tier project; regional/project limits and free-tier data usage terms apply. |
| [Mistral Studio](https://console.mistral.ai/api-keys/) | `mistral-small-latest` | [Free mode enabled by default, no card](https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key), with usage/rate limits. |
| [OpenRouter](https://openrouter.ai/keys) | `openrouter/free`; also supports explicit `:free` model IDs | [Free model limits](https://openrouter.ai/docs/api/reference/limits). The free router picks an available free model. Multiple accounts/keys do not increase rate limits. |
| [Cloudflare Workers AI](https://dash.cloudflare.com/) | `@cf/meta/llama-3.1-8b-instruct` | [10,000 free neurons/day](https://developers.cloudflare.com/workers-ai/platform/pricing/). Requires account ID and a Workers AI API token. Some frontier models are paid. |
| [ElectronHub](https://app.electronhub.ai) | GPT-OSS, Gemma, Nemotron and more | [Daily Neutrinos and weekly credits](https://docs.electronhub.ai/billing/credits). 10 Neutrinos/day for `:free` routes; some requests cost several. $0.25 shared weekly credits fund eligible routes with nonzero token prices. |
| [SimpleLLM](https://app.simplellm.eu) | `free-Llama-3.1-8B-Instruct`, `free-gemma-4-E4B` | [Free model quotas](https://simplellm.eu/docs/limits.html) and zero input/output prices in the [public catalog](https://simplellm.eu/api/models). Hourly/daily request and token limits apply. |
| [Inferbase](https://inferbase.ai) | GPT-OSS, Gemma, Llama, Qwen | [Free plan](https://inferbase.ai/pricing): 5,000 requests/month, 100 managed requests and $0.50 model usage/day, shared across models. Free managed inference has a 1,024-token output limit. |

Google, Cloudflare, and Cohere use their documented OpenAI-compatible API:
[Google](https://ai.google.dev/gemini-api/docs/openai),
[Cloudflare](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/),
[Cohere](https://docs.cohere.com/docs/compatibility-api).

OpenRouter also includes explicit presets for `minimax/minimax-m3.1-flash:free`,
`nvidia/nemotron-3.5-lightning:free`, `google/gemma-4-26b-a4b-it:free`,
`cohere/north-mini-code:free`, and `nvidia/nemotron-3-super-120b-a12b:free`.
Their prompt/completion prices were both zero in the
[public model catalog](https://openrouter.ai/api/v1/models) on the verification
date. Model rotation is common; `openrouter/free` remains the default so the
provider can choose an available free model.

## Free development/evaluation access

| Provider / get a key | Preset | Scope |
| --- | --- | --- |
| [NVIDIA NIM](https://build.nvidia.com/settings/api-keys) | 49 chat presets including Nemotron, GPT-OSS, Gemma, DeepSeek, Kimi | [Free serverless APIs for development](https://build.nvidia.com/explore/discover); model IDs checked against its [public API](https://integrate.api.nvidia.com/v1/models). Check your account and the model page for allowances and access. |
| [Cohere](https://dashboard.cohere.com/api-keys) | `command-a-plus-05-2026` | [Free evaluation keys](https://docs.cohere.com/docs/rate-limits): 1,000 calls/month and per-model rate limits. Production keys are paid. |
| [Typhoon](https://playground.opentyphoon.ai) | `typhoon-v2.5-30b-a3b-instruct`, `typhoon-v2.1-12b-instruct` | [Free research showcase](https://docs.opentyphoon.ai/en/faq/) with [documented models](https://docs.opentyphoon.ai/en/models/). Rate limits apply and usage data is collected for service improvement. |

## Community presets and excluded free claims

Agnes is available as an explicitly **unverified** API-key preset. OmniRoute
lists the endpoint `https://apihub.agnes-ai.com/v1` and models
`agnes-2.0-flash`, `agnes-2.5-flash`, and `agnes-3.0-flash`.
[Create/check an account](https://platform.agnes-ai.com); independent public
free-quota evidence was not available, so it is not in the verified free list.

These sources helped identify candidates:
[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) and
[the locally installed OmniRoute](https://www.npmjs.com/package/omniroute).
Their free flags are not sufficient verification. In particular:

- [Cerebras](https://inference-docs.cerebras.ai/support/rate-limits) currently
  documents a $5, 30-day trial after payment-method verification. It is not a
  recurring free tier.
- [Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers/pricing)
  currently lists no included credits for free accounts.
- SambaNova, Reka, OpenCode Zen, SEA-LION, and LongCat are not advertised here
  as verified free APIs without current public terms supporting that claim.

The expanded **Source-listed free access** section includes Ollama Cloud,
Zhipu's China API, ModelScope, SEA-LION, LLM7, BazaarLink, Aion Labs, Requesty,
NaraRouter, xKiro, UnoRouter, AMD Radeon Cloud, Routeway, Router9, Septor,
CLōD, Api.Airforce, DreamPrompting, Waterfall, Logfare, Kilo Gateway, OVHcloud,
Poolside, and LongCat alongside Agnes. Each has an API-key link, endpoint,
model dropdown, provenance, and notes about known account requirements.
These are useful configurations from the source lists; they are not presented
as independently verified free inference.

LongCat's source lists disagree about recurring access versus a one-time KYC
grant. Ollama's current pricing describes starter credits rather than a
recurring free allowance. Both are labeled accordingly. ModelScope requires
Chinese real-name/account binding. The Zhipu domestic endpoint is distinct from
the global Z.ai API and Coding Plan; use a key for the matching host.

## Model catalog maintenance

The bundled snapshot combines FreeLLMAPI's **public monthly catalog**, its
documented API roots, the locally installed OmniRoute presets, and current
public APIs from OpenRouter, NVIDIA, ElectronHub, SimpleLLM, and Kilo. The
FreeLLMAPI payload is verified with the source's pinned Ed25519 public key.
No Premium feed, subscription credential, or session workaround is used.

OpenRouter presets require both prompt and completion prices to be zero.
NVIDIA IDs must appear in its current public model catalog. ElectronHub's
daily-free `:free` routes and shared-credit routes are labeled separately.
SimpleLLM presets require available/enabled entries with zero input/output
prices. Gemini is cross-checked with official free-tier pricing; Cloudflare
excludes the documented models that require paid billing. Image, speech,
embedding, guard-only, live-session, and completion-only entries are filtered
out of the chat presets. Source-listed model availability is still subject to
your account and current provider terms; no live key inference was run for this
catalog refresh.

To refresh the bundled models before a release:

```bash
npm run update:providers
git diff -- lib/provider-models.json
npm run check
npm test
```

Review provider pricing and setup notes as well as the model diff, update this
document's counts when needed, then commit/push and use the deployment steps in
[operations.md](operations.md). The refresh script changes only source files;
it does not change production accounts, their selected models, or routing.
Normal startup reads the bundled list and does not fetch or silently replace
model choices. Updating the catalog never automatically adds provider accounts.

Provider limits may apply per organization, project, account, or service.
Independent accounts are supported for normal account management and routing;
the app does not promise quota multiplication or bypass provider rules.

## Import existing API keys

FreeLLMAPI: export your keys as JSON using its authenticated key export. The
supported shape is `version: 1`, `source: "freellmapi"`, and a `keys` array with
`platform`, `key`, `label`, and optional `baseUrl`. This format normally has no
model choice, so the catalog default is used; change it after import as needed.

OmniRoute: run the included read-only exporter on the machine with its database:

```bash
python3 scripts/export-omniroute-keys.py --list
python3 scripts/export-omniroute-keys.py --output /tmp/omniroute-api-keys.json
```

It reads `~/.omniroute/storage.sqlite` in read-only mode and selects only rows
whose `auth_type` is `apikey`. It never exports OAuth/session tokens. The output
has mode 0600 and must be outside this repository. A different database path can
be passed with `--database`.

In **Free APIs → Import API keys**, choose the file, preview the account names,
then import. Unsupported providers and exact endpoint/key/model duplicates are
skipped. Supported keys use the catalog's API root, rather than trusting an
arbitrary endpoint in an export. Cloudflare needs its account ID; exports can
include `accountId` or a `baseUrl` containing `/accounts/<id>/`.
FreeLLMAPI's compound `account_id:token` credential is also converted into a
Cloudflare account endpoint plus a bearer token.
Validation failures save nothing. The preview does not write configuration or
make upstream calls. Keys are masked in responses and are not stored in browser
local storage. Delete the plaintext export after importing.

Imports deliberately require review in the dashboard; deployment never copies
accounts from another live service automatically. For providers without a
preset, use **Add provider** with their documented API-key endpoint and model.

See [production update instructions](operations.md) to make new code available
on port 3002 while retaining all saved accounts.
