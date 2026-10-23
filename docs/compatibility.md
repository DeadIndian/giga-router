# API compatibility and limits

## Supported paths

| Input → upstream | Supported behavior |
| --- | --- |
| OpenAI Chat → OpenAI Chat | Native body and extensions, with routed model and explicit compatibility overrides |
| Anthropic Messages → Anthropic Messages | Native content/thinking; forwards Anthropic version/beta headers |
| Chat ↔ Messages | Text, function tools/results, tool choice, parallel-tool restrictions, base64/URL images, token limits, stop reasons, streaming usage |
| Responses → OpenAI Responses | Native POST and streaming; requires `capabilities.responses: true` |
| Responses → Messages/Chat | Unsupported; choose a native Responses provider |
| Messages token counting | Native `/messages/count_tokens` for eligible Anthropic providers; otherwise a labeled character estimate |

Native routes inspect success/error and completion markers without converting
content into another protocol. Streams missing their completion marker are
failures. Startup failures may fall back; failures after output produce an
in-band error. OpenAI `[DONE]` is emitted only on successful Chat completion.

Cross-format conversion is intentionally a subset. Developer/system instructions
retain instruction priority. Strict schemas, audio, documents, server-hosted
tools, signed thinking histories, and unsupported request controls need a native
provider. Anthropic thinking requests retain the historical mapping to OpenAI
`reasoning_effort: medium`; that is not an equivalent token-budget guarantee.
Use a native route when exact reasoning semantics matter.
Named messages, explicit image-detail controls, error-marked tool results, and
paused/server-tool continuations also require a native route. Prompt-cache hints
do not carry over to the other provider's caching implementation.

Responses supports native creation/follow-up POST requests. Retrieval, deletion,
background polling, and translation of Responses items are not implemented.
Pin stateful follow-ups to the original provider; a multi-provider implicit
route with `previous_response_id` is rejected.

Token estimates include system/messages/tools but are not model tokenization or
an image-token calculation. They are labeled `estimated: true` and should not
be used as an exact quota or billing measure.

## Provider settings

Provider edits preserve omitted/masked secrets. `***` means keep the saved value;
an empty API key allows auth-less local providers. Custom headers remain supported.

`capabilities` supports `tools`, `vision`, `responses`, `countTokens`, and
`contextWindow`. Boolean `false` is explicitly unsupported; `null` clears an override.
Bundled catalog metadata supplies defaults, and account-level values override
it. Missing catalog values are unknown. Profiles can require tools, vision, or a minimum known context window.
Unknown capabilities remain eligible; metadata does not verify account access.

`compat` options:

- `singleToolCall`: disallow parallel tool use.
- `noReasoningEffortWithTools`: send `reasoning_effort: none` when tools and
  reasoning effort occur together on an OpenAI upstream.
- `adaptiveToEnabled`: opt-in legacy thinking conversion. Disabled by default.

Editing a provider clears its health entry. **Test provider** performs one tiny
inference using the normal transport and reports latency and validated stages;
it does not certify streaming/tool access for every model feature.

`POST /api/route-now` accepts a request body for a dashboard-authenticated dry
run, with `?format=openai|anthropic|responses|count_tokens`. It returns the
eligible chain and skipped candidates/reasons. `GET /api/route-now` supports
`model` and `provider` query parameters for simpler previews.

## Transport budgets

All durations are in milliseconds; accepted values are bounded to 50–1,800,000.

| Environment variable | Default | Applies to |
| --- | --- | --- |
| `LLM_REQUEST_TIMEOUT_MS` | 300000 | Complete request including all attempts |
| `LLM_HEADERS_TIMEOUT_MS` | 30000 | Attempt headers and buffered response body |
| `LLM_FIRST_TOKEN_TIMEOUT_MS` | 30000 | First meaningful streamed output |
| `LLM_STREAM_IDLE_TIMEOUT_MS` | 60000 | Time between decoded upstream events |

Limits: 16 MiB buffered response; 64 KiB error response; 1 MiB SSE event and
translated tool-argument buffer; 128 translated tool calls. Startup buffering
commits after meaningful output, 64 events, or 256 KiB. Writes await downstream
backpressure. Heartbeats are emitted every ten seconds after stream commitment.

Retry hints accept `Retry-After` seconds/date and `retry-after-ms`, bounded to
one second through 24 hours. Authentication/quota failures default to five-minute
cooldowns. Model capability failures and invalid caller requests do not count
against provider health. Entries sharing the same API key and endpoint origin
share quota/authentication failures; independent keys remain separate.

## Persistence and MCP

- `activity.json` retains 200 metadata-only events across restart (API returns
  the latest 100). Request IDs group attempts, latency, model, and usage. Prompt
  bodies, generated content, keys, and upstream error text are not recorded.
  The overview displays the six most recent events and their expandable details.
- Dashboard sessions, circuit health, counters, and MCP sessions are in memory.
- Each MCP session owns its backend clients, except the existing serialized
  shared Memory integration. Discovery caches metadata for 30 seconds and has
  a ten-second total budget; failures return last-known metadata and status in
  `_meta["giga-router/discovery"]`.
- Backend list-change notifications invalidate caches and notify clients.
  Tool/prompt/resource cancellation and progress are relayed. Embedded resource
  URIs and tool resource links are namespaced; opaque application content is not.
- Sampling, elicitation, resource subscriptions, and native MCP v2 `skills/list`
  are not advertised. Installed skills use the existing tool/prompt/resource APIs.
- New MCP credentials use the encrypted vault. Provider credentials remain in
  `config.json`. Back up the complete data directory and vault key together.
