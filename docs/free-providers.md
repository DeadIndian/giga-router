# Free API providers and accounts

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

Google, Cloudflare, and Cohere use their documented OpenAI-compatible API:
[Google](https://ai.google.dev/gemini-api/docs/openai),
[Cloudflare](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/),
[Cohere](https://docs.cohere.com/docs/compatibility-api).

## Free development/evaluation access

| Provider / get a key | Preset | Scope |
| --- | --- | --- |
| [NVIDIA NIM](https://build.nvidia.com/settings/api-keys) | `meta/llama-3.1-8b-instruct` | [Free serverless APIs for development](https://build.nvidia.com/explore/discover). Check your account and the model page for allowances and access. |
| [Cohere](https://dashboard.cohere.com/api-keys) | `command-a-plus-05-2026` | [Free evaluation keys](https://docs.cohere.com/docs/rate-limits): 1,000 calls/month and per-model rate limits. Production keys are paid. |

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
