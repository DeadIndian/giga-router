# Giga Router improvement research

**Researched:** 2026-10-23

**Code baseline:** `7d2a14c` on `main`

**Recommendation:** prioritize protocol correctness, trustworthy routing, and transactional skill updates; then build capability-aware routing and better diagnostics on those foundations.

This is the historical research baseline. For implemented fixes, current
verification, and remaining evaluations, see [the delivery record](reliability-release.md).

## Executive findings

The highest-value next release is a reliability release. There are reproducible cases where a failed stream looks successful, a valid request is changed into an incompatible request, and the provider shown by the dashboard differs from the provider actually used.

This investigation produced **19 targeted behavioral observations across 12 issue groups**. The probes used temporary configuration, ephemeral `127.0.0.1` HTTP fixtures, an in-memory MCP client/server pair, and a fake GitHub client. The native adaptive-thinking rewrite was observed locally; its incompatibility with current Claude models is supported by official documentation rather than a live provider call. The deployment fingerprint was exercised with mocked filesystem input rather than Docker.

The strongest reuse opportunities are:

- **LiteLLM and Bifrost:** reference implementations for error classification, request/attempt budgets, capability checks, and routing explanations.
- **Official MCP SDK:** existing v1 transport/auth machinery, plus a staged evaluation of stable v2 and its skills extension.
- **eventsource-parser:** standards-compliant SSE framing.
- **Cockatiel:** retry, timeout, circuit-breaker, and concurrency primitives if they simplify the eventual routing module.
- **Vercel AI SDK:** maintained outbound provider implementations, evaluated against the router's wire-compatibility requirements.
- **models.dev:** supplementary capability metadata with provenance, alongside existing official/provider catalogs.
- **Existing Playwright workflow and OpenTelemetry conventions:** stronger regression coverage and useful request diagnostics.

## 1. Reproduced issues

Priority means **P1: next correctness release**, **P2: following reliability/usability work**, **P3: narrower compatibility case**. Effort is relative: **S** is a focused change; **M** spans behavior and several tests. These are implementation estimates, not delivery dates.

| ID | Priority / effort | Finding | Main evidence |
| --- | --- | --- | --- |
| R1 | P1 / M | Anthropic-to-OpenAI streams can hide failure and truncation | `server.js:465–498`, `631–649` |
| R2 | P1 / S | Adaptive thinking is rewritten even for native Anthropic requests | `server.js:186–191`, `678–679` |
| R3 | P1 / M | Cross-format conversion silently changes request meaning | `server.js:269–314`, `351–368` |
| R4 | P1 / M | Health and retry decisions misclassify failures and cancellation | `server.js:599–614`, `705–718`, `744–747` |
| R5 | P2 / S | “Next request” previews ignore ordinary auto-mode cooldown filtering | `server.js:681–685`, `890–914`, `1008–1018` |
| R6 | P1 / S | A disabled provider alias silently falls through to another provider | `server.js:663–670` |
| R7 | P1 / M | Invalid HTTP-200 upstream responses bypass available fallbacks | `server.js:737–747` |
| R8 | P2 / S | Schedule status uses the wrong timezone; overnight weekdays are ambiguous | `server.js:58–68`, `936–951` |
| R9 | P1 / M | Skill updates can leave a mixed generation on disk | `lib/skills.js:206–233` |
| R10 | P2 / M | Resource links returned by MCP tools cannot be read through the gateway | `lib/mcp.js:249–253`, `281–296` |
| R11 | P2 / S | Normal key usage changes the deployment configuration fingerprint | `scripts/deploy-local.sh:12`, `31–40`; `lib/auth.js:91–95` |
| R12 | P3 / S | Valid CR-only SSE framing fails parsing | `server.js:505–538` |

### R1. Anthropic stream failures are disguised as completion

**Reproduction:** configure an Anthropic fixture upstream; call `/v1/chat/completions` with `stream: true`. Return `message_start`, then an Anthropic `error` event and EOF.

**Observed:** downstream HTTP 200; the upstream error is absent; `[DONE]` is emitted; provider health remains successful. A separate fixture that ends after partial text, without `message_stop`, also receives `[DONE]` and no error. HTTP 200 alone is normal once a stream starts; the defect is suppressing the error and synthesizing normal termination.

The converter also maps `max_tokens` to OpenAI `stop`, obscuring truncation. The non-streaming converter has the same stop-reason problem. Inspection additionally shows that Anthropic streaming usage is never emitted as OpenAI usage.

**Why:** this direction has no terminal-state validation and ignores `error` events. The OpenAI-to-Anthropic direction already contains a stronger state machine and `forceStop` checks.

**Fix:** give both directions explicit lifecycle validation, error handling, stop-reason mapping, and usage accounting. Emit OpenAI usage when requested. Preserve distinct outcomes for success, upstream error, truncation, and client cancellation. Native passthrough also needs outcome inspection if its result drives health and activity counters.

**Acceptance:** both directions handle empty streams, partial text, partial tool JSON, errors before/after output, `max_tokens`/`length`, and usage after terminal content. Failed streams must remain recognizably failed to an official client SDK.

Sources: [Claude streaming][claude-streaming], [Claude errors][claude-errors], [OpenAI Chat Completions][openai-chat].

### R2. The adaptive-thinking workaround has become overbroad

**Observed:** a native Anthropic request containing `thinking: { type: 'adaptive' }` reaches `buildUpstream` as `{ type: 'enabled', budget_tokens: 1024 }`.

The sanitizer runs before provider-specific handling and replaces the entire thinking object. Current Claude documentation states that Claude 4.7 and later reject extended thinking (`type: enabled`). It also documents model-specific thinking modes and restrictions. Therefore a compatibility workaround for one upstream can break another, including same-format requests.

**Fix:** apply compatibility adjustments to a fresh per-attempt request using explicit provider/model capabilities. Preserve supported native thinking fields. Make the legacy conversion a targeted compatibility option.

**Acceptance:** a native adaptive-capable fixture receives the original thinking configuration; a legacy fixture gets its configured conversion; failover does not inherit mutations made for the previous provider.

Source: [Claude errors: thinking validation][claude-errors].

### R3. OpenAI-to-Anthropic conversion loses important semantics

The following were observed directly:

| Input | Actual converted result | Consequence |
| --- | --- | --- |
| `role: developer` | Converted to user content | Instruction priority changes |
| `tool_choice: required` | Omitted | Tool use is no longer required |
| `parallel_tool_calls: false` | No corresponding tool-choice restriction | Caller constraint is lost |
| `max_completion_tokens: 17` | `max_tokens: 4096` | Requested output limit is lost |
| An HTTPS `image_url` as the only message content | Zero output messages | Image and message disappear |
| Anthropic `stop_reason: max_tokens` | OpenAI `finish_reason: stop` | Partial output appears normally finished |

Other gaps visible in code include structured-output settings, richer content blocks, and reasoning metadata. These need a supported-feature matrix rather than an assumption that every field has an equivalent. For example, current Claude models differ in whether forced tool use is supported.

**Fix:** map supported semantics explicitly, select a compatible target where routing permits it, and return a specific unsupported-feature error when translation cannot preserve the request. Capability lookup should distinguish “unknown” from “unsupported.”

**Acceptance:** a table-driven contract suite exercises both conversion directions. Every meaningful unsupported input is either preserved on a native route or rejected explicitly on a translated route.

Sources: [OpenAI Chat Completions][openai-chat], [Claude errors][claude-errors], [AI SDK provider architecture][ai-providers].

### R4. Provider health and retries need a failure taxonomy

Four independent observations:

1. A fixture's malformed-request **400** increments provider failures and starts a 60-second cooldown.
2. Aborting the client after the first streamed chunk also increments failures and starts cooldown.
3. A **529 overloaded** response stops the chain; the healthy second provider is never called.
4. A **429 with `Retry-After: 300`** loses that header downstream and produces only the fixed 60-second cooldown.

The code also treats every 400 as nonretryable. Official Claude documentation explicitly includes spend-limit failures under 400, so status alone cannot establish that the request is malformed.

There are additional policy inconsistencies: fallback-enabled schedules do not apply the ordinary auto-mode health filter to their tails; when every auto candidate is unhealthy, all candidates are tried again. These behaviors should be explicit policy decisions exposed by the planner.

**Fix:** normalize failures into categories such as `caller_error`, `capability_mismatch`, `credential`, `quota`, `rate_limit`, `transient`, `timeout`, and `cancelled`. Each category determines failover eligibility, health effects, retry timing, and downstream representation. Preserve bounded provider retry hints. Add half-open recovery so concurrent requests do not all probe a recovering provider.

Use account/project quota identity where known: several model entries using the same account can share one rate limit. Independent accounts remain distinct. A model-level 404 should not disable unrelated models merely because an explicit alias shares a provider ID.

**Acceptance:** malformed inputs and cancellation do not damage provider health; overloads can fail over; quota and rate-limit failures behave differently; retry hints survive; concurrent recovery admits a bounded number of probes.

Sources: [Claude errors][claude-errors], [Bifrost retry classification][bifrost-retries], [LiteLLM reliability][litellm-reliability].

### R5. Routing previews and actual selection diverge

**Reproduction:** configure Alpha then Beta in auto mode and put Alpha in cooldown.

**Observed:** `/api/route-now` says Alpha; an actual request goes to Beta. `/api/routing` uses the same unfiltered candidate resolver, and `public/app.js:108` labels its answer “NEXT REQUEST ROUTES TO.”

**Fix:** create one route-planning module used by execution and both preview endpoints. Return the effective candidates plus skipped candidates and reasons. Accept request intent and an injectable instant for meaningful dry runs.

**Acceptance:** with identical configuration, health, intent, and time, preview and execution choose the same first eligible provider. Cover auto/manual, schedules, cooldown, trips, disabled providers, and aliases.

### R6. Disabled aliases lose their explicit selection

**Reproduction:** Alpha is configured but disabled; Beta is enabled. Send model `alpha/model-a` without the explicit-provider header.

**Observed:** HTTP 200 from Beta. The alias lookup filters out disabled providers, then treats the request as ordinary auto routing. The header form already returns 404 for missing/disabled providers.

**Fix:** resolve alias identity separately from eligibility. A recognized alias for a disabled provider must fail explicitly. Define how unknown prefixes differ from ordinary upstream model IDs such as `organization/model`, which legitimately contain slashes.

**Acceptance:** header selection and known alias selection have equivalent failure behavior. A disabled alias cannot redirect to another provider. Existing ordinary model-name behavior remains covered by a contract test.

### R7. Bad HTTP-200 responses defeat auto failover

**Reproduction:** first fixture returns HTTP 200 with HTML; the second can return a valid completion.

**Observed:** router returns 502 after only one upstream call. Parsing and conversion errors happen outside the loop's retry decision. A 200 response containing an error object takes the same throw path.

**Fix:** include response validation in the attempt result before committing the downstream response. For streams, allow bounded startup buffering so errors before meaningful output can take the configured fallback path. Once meaningful output has been emitted, finish with a stream error rather than combining generations from different providers.

**Acceptance:** malformed non-stream responses and startup-only stream failures can reach a healthy fallback; a failure after text/tool output is reported in-band; buffering has size and time limits.

Source: [Bifrost startup stream buffering][bifrost-retries].

### R8. Schedule interpretation needs one clock model

**Confirmed timezone defect:** a UTC window surrounding the current UTC time was active in actual routing, but `/api/schedules` returned `activeNow: false`. That endpoint passes the current Asia/Kolkata time into every schedule, bypassing each schedule's timezone.

**Observed weekday ambiguity:** `days: ['mon'], start: '23:00', end: '02:00'` matches Monday 01:00 and does not match Tuesday 01:00. That is current-calendar-day filtering. If “Monday overnight” means the window beginning Monday at 23:00, the behavior is reversed after midnight. This part needs an explicit product contract.

Validation also accepts arbitrary day strings and invalid timezone names; invalid zones silently fall back to UTC. Equal start/end creates an empty window without explaining it.

**Fix:** calculate each window using its own timezone and one injected instant. Define start-day semantics for overnight windows, validate IANA zones and day names, and show the next few occurrences in the editor. Define equal-time and overlapping-window behavior.

**Acceptance:** timezone-specific status matches routing; tests cover start/end boundaries, Sunday-to-Monday rollover, daylight-saving transitions, invalid zones, and overlap precedence.

### R9. Skill updates need transactional generations

**Reproduction:** install a skill whose supporting file is named `references`. Update the repository so it instead contains `references/info.txt`.

**Observed:** update throws `EEXIST`. `bundle.json` already advertises `references/info.txt`; the portable directory still contains the old `references` file; configuration still has the previous bundle hash. The three representations disagree. A normal removal-only update is covered by existing tests, but this shape change is not.

**Why:** `persistBundle` writes the manifest first, writes files into the live directory, prunes afterwards, then updates configuration.

**Fix:** stage a complete generation in a sibling directory, validate it, then commit a generation reference and recover cleanly after interruption. Keep the previous generation available until commit succeeds. Include a clear local-edit/update diff using the existing `locallyEdited` metadata.

**Acceptance:** file-to-directory and directory-to-file updates work; download/MCP/portable reads observe one generation; injected write failures preserve the previous usable install; restart can recover an interrupted commit.

### R10. MCP namespace rewriting is incomplete

**Reproduction:** a backend tool returns `{ type: 'resource_link', uri: 'notes://one', name: 'Note' }` through `notes__get_note`; the client then reads that URI through Giga Router.

**Observed:** the tool result retains `notes://one`; `resources/read` returns “Resource is not available for this key.” Resource discovery uses `giga://notes/...`, but tool results are returned unchanged. Prompt results can also contain embedded resources and need the same inspection.

**Fix:** centralize rewriting of protocol-defined resource URI fields in tool and prompt content as well as list/read responses. Preserve opaque text and application-defined structured data. Resource links may refer to resources absent from `resources/list`, so do not depend on a prebuilt discovery inventory.

**Acceptance:** links and embedded resources round-trip; namespaces remain distinct for identical backend URIs; the same scoped-key checks apply on the subsequent read.

Source: [MCP tool resource links and embedded resources][mcp-tools].

### R11. Deployment verification includes volatile activity

**Observed:** executing the deployment script's exact fingerprint expression with mocked configuration produces a different hash when only `accessKeys[0].lastUsedAt` changes.

`authenticateKey` updates that field on normal gateway traffic, at most once per minute per key. Traffic between pre/post deployment fingerprints can therefore make a successful deployment report changed saved configuration even without a dashboard edit. Persisted MCP discovery status is another operational field to review.

**Fix:** define the stable configuration fields being verified separately from mutable usage/health fields. Continue hashing actual credentials, grants, routing settings, and password state without printing them. Verify vault-file continuity as part of the relevant recovery contract.

**Acceptance:** ordinary key use does not fail verification; changed provider keys, scopes, schedules, selected providers, and saved passwords do. Existing fake-Docker tests can cover this without accessing a real container.

### R12. SSE framing accepts CRLF but not CR-only lines

**Reproduction:** pass `data: {"text":"ok"}\r\rdata: [DONE]\r\r` through `readSSE`.

**Observed:** `Invalid JSON in upstream event stream`. The parser searches only for LF; stripping a trailing CR handles CRLF but does not handle CR as the line delimiter.

**Fix:** adopt a maintained SSE parser or implement the full framing algorithm. Retain the existing split-UTF-8, multiline-data, callback-error, and `[DONE]` tests, with explicit event-size limits.

Sources: [HTML event-stream parsing][sse-spec], [eventsource-parser][eventsource-parser].

## 2. Further reliability gaps established by inspection

These have clear implementation evidence but were not load-tested or reproduced against live providers.

### Request deadlines and streaming backpressure

- `server.js:696–697` creates a new 110-second timer for each attempt. The timer lasts through body consumption, so it caps active streams as well as connection stalls. Heartbeats do not reset it.
- Sequential fallbacks each receive another 110 seconds. There is no overall request deadline, so several stalled candidates can exceed the surrounding proxy/client's waiting budget.
- Heartbeats begin only after upstream headers arrive (`streamUpstream`), so they do not help the initial wait for headers.
- Both passthrough and converted paths ignore the boolean return value of `res.write`. A slow reader can accumulate output in memory.
- Error-body `text()` and non-streaming `json()` reads have no response-size cap; tool-argument and SSE frame buffers also lack independent size limits.

**Recommended implementation:** one request deadline, per-attempt connection/header limits, a stream-idle timeout, bounded queues/buffers, and backpressure-aware writes using Node's stream primitives. Heartbeats are transport liveness, not proof of upstream progress. Test slow readers and stalls using local fixtures before selecting limits.

### MCP discovery, notifications, and cancellation

- Backend clients are created without handlers forwarding backend `notifications/*/list_changed` (`lib/mcp.js:106–120`). Dashboard-driven changes notify clients, but backend-driven changes do not.
- Tool calls pass the request cancellation signal; prompt/resource reads and discovery calls do not (`lib/mcp.js:175–180`, `251`, `272`, `295`). Progress notifications are not explicitly relayed.
- Discovery fans out to four backends at a time, and each paginated list can perform up to 50 requests. One unresponsive backend can delay discovery for useful backends.
- Discovery errors become empty lists. The dashboard gets a generic health error, but an agent cannot readily distinguish “this backend has no tools” from “discovery failed.”

**Recommended implementation:** scope-aware metadata caching with version/signature invalidation, forwarded change notifications, end-to-end cancellation/progress, bounded total discovery time, and last-known metadata plus a clear unavailable status where appropriate. Retain per-session backend ownership; use the existing shared Memory exception only for its demonstrated file-consistency need.

### Dashboard loading and refresh behavior

`loadWorkspace` fetches nine endpoints with `Promise.all` on login and most mutations (`public/app.js:56–79`). A failure in an optional catalog prevents the complete refresh. The existing 15-second poll already avoids reloading the marketplace, but rerenders the current page (`public/app.js:783–797`), which can replace focused search controls or reset expanded details.

A temporary seeded-catalog measurement on **Windows / Node 24.13.0** found:

| Measurement | Result |
| --- | --- |
| Marketplace entries | 1,318 |
| Serialized `items` JSON, before HTTP compression | 1,110,063 bytes |
| First `listMarketplace()` call after seeding | about 109 ms |
| Mean of 20 subsequent calls | about 1.79 ms |

These are local metadata measurements, not production latency or browser benchmarks. They point toward lazy per-page loading and incremental refresh first. Server-side search/pagination becomes more useful as sources grow; the current warm metadata cache is already effective at this catalog size.

### Activity cannot explain a request end to end

`lib/activity.js` retains 100 in-memory events and exposes 30. LLM events omit duration, first-token latency, token usage, request ID, and an attempt group. A failed first provider followed by success appears as separate events, and counts measure attempts rather than clearly labeled user requests. Restart discards the history.

Add a request ID, parent request outcome, ordered attempt records, selected model, upstream request ID, queue time, first-token latency, total duration, usage, and normalized failure class. Keep bounded retention and make the dashboard explain why each candidate was chosen or skipped. Initial telemetry can stay metadata-only and local.

### Small follow-ups

- Provider names and schedule labels are inserted into response headers (`server.js:722–723`) despite allowing arbitrary Unicode/control-containing strings. Use stable header-safe IDs and validate display labels; confirm the failure case with a targeted HTTP test.
- Updating a provider's credentials/model does not clear its existing health entry (`server.js:857–865`), so a repaired provider can remain skipped until expiry or a global reset. Add per-provider retest/reset behavior.
- `count_tokens` is explicitly a character-based estimate (`server.js:1034–1036`). Prefer a documented provider counting endpoint when available, and make estimates useful for the selected model/content type. Images and multilingual inputs need special treatment.
- Request/body validation is uneven. Add focused schemas for public configuration and supported protocol inputs; consider schema/version validation before future persistence migrations.
- A full restore exercise would add confidence beyond the documented backup procedure. The deployment helper already backs up configuration and the operations guide already explains full-volume backup; extend those existing workflows.

## 3. Best product improvements using existing foundations

### A. Capability-aware route profiles

Create named profiles such as `coding`, `fast`, and `local`, each with a deliberate provider/model chain and required capabilities. Ordinary model-name replacement is currently intentional behavior; make profile selection explicit.

Start with bundled `supportsTools`, `supportsVision`, and `contextWindow` data in `lib/provider-models.json`. Add output limits, supported protocol endpoints, structured-output support, and thinking modes with source/check timestamps. Distinguish unknown metadata from an explicit lack of support and allow account-specific overrides.

The useful experience is: “Beta was skipped because this request contains an image; Gamma was chosen because it supports vision and has available capacity.” Preview and execution must use the same planner.

**Success measure:** no known-incompatible candidate is contacted; each skipped candidate has a specific explanation; existing direct aliases and schedule precedence have regression coverage.

### B. Provider diagnostics as good as MCP diagnostics

MCP already has “Test connection.” Providers need a similarly useful check with a tiny explicit test request, clear stages (endpoint, authentication, model access, streaming, tool support), latency, and actionable errors. A passing model-list endpoint alone does not prove inference access.

Use the same protocol and transport implementation as real calls. Expose a model picker that distinguishes bundled catalog metadata from account-confirmed availability. Make stale-catalog dates data-driven rather than embedding a fixed verification date in `public/app.js:156`.

### C. First-class Responses API support

Only Chat Completions and Messages are mounted today (`server.js:1027–1037`). OpenAI recommends Responses for new projects. Add native `/v1/responses` forwarding for providers advertising that endpoint, then expand a documented supported subset of cross-protocol translation.

Responses has different state, event, item, reasoning, and tool semantics. Build an endpoint/capability matrix and preserve native provider extensions. Test explicit terminal events, errors, tool results, and follow-up requests before advertising compatibility.

### D. Transactional, inspectable skill updates

Build on the existing pinned commits, bundle hashes, source licenses, and `locallyEdited` marker. Add changed-file previews, a previous-generation rollback, and clear local-edit handling. Background indexing/install jobs can expose progress and cancellation instead of holding one dashboard request open for hundreds of downloads.

GitHub refresh can reuse unchanged blobs by SHA and conditional requests. The existing four-download concurrency limit is a useful foundation; add job-level budgets and cancellation rather than increasing parallelism blindly.

### E. Native MCP skill discovery

The current `giga__skill`, prompts, and resource mechanisms already make skills useful. The official SDK v2 now documents `skills/list`, file digests, resource-backed file reads, catalog reload, and catalog sharing across server instances.

Evaluate it using the router's installed/enabled skill inventory. Existing storage uses UUID directories and a `files` subdirectory, so direct attachment of the current data directory is not automatically compatible with the extension's naming/layout contract. Preserve scoped access and provide a stable mapping from installed IDs to published skill URIs. Test current clients and a v2-aware client.

Source: [MCP SDK skills][mcp-skills].

## 4. Reuse assessment

Versions below were checked on the research date. Adoption needs a pinned release and tests of the integration seam.

| Existing project | Useful reuse | Fit and tradeoff |
| --- | --- | --- |
| [LiteLLM][litellm-reliability] | Capability-aware fallbacks, error normalization, model groups, routing observability | Strong behavioral reference. Its main Python gateway introduces a second runtime if deployed behind Giga Router. Core is MIT; `enterprise/` has separate licensing. |
| [Bifrost][bifrost-retries] | Error taxonomy, startup stream buffering, retry hints, attempt trails | Apache-2.0 Go implementation. Excellent reference; using it as another gateway adds process/configuration ownership. Its README lists adaptive routing and other features under enterprise offerings, so check edition and release for each feature. |
| [Vercel AI SDK][ai-providers] | Maintained outbound provider implementations and normalized generation events | Apache-2.0. Trial one OpenAI/Anthropic integration against the protocol fixture suite. Its application-facing abstraction does not itself provide a transparent OpenAI/Anthropic HTTP server. Set SDK retries explicitly to avoid multiplying router retries. |
| [eventsource-parser][eventsource-parser] | SSE framing and streaming parser | MIT; current release `4.1.2` requires Node `>=22.12` and is ESM. Existing project is CommonJS and documents Node 22+, so choose a compatible import strategy and minimum runtime deliberately. It solves framing, not LLM completion semantics. |
| [Cockatiel][cockatiel] | Circuit breaker, backoff, timeout, bulkhead/concurrency policies | MIT; current `4.0.0` requires Node `>=22` and is ESM. Useful behind a small routing interface. Failure classification, schedule policy, account quotas, and total request budgets remain Giga Router behavior. |
| [Official MCP SDK][mcp-sdk] | Transports, OAuth, notifications, protocol negotiation, native skills | Installed `@modelcontextprotocol/sdk@1.32.1` is the current v1 npm release. Split v2 client/server packages are stable at `2.3.1`. Upstream promises v1 fixes for at least six months after the 2026-07-27 v2 release. Plan and test a migration within that support window; v2 uses Apache-2.0 for new code with existing MIT code retained. |
| [MCP v2 codemod][mcp-migration] | Mechanical package/import/handler changes | Upstream supplies a codemod and a manual migration guide. The guide confirms native CommonJS builds. OAuth errors, handler context, pagination behavior, legacy SSE fixtures, and protocol-version negotiation still require review. |
| [models.dev][models-dev] | Tools, reasoning, modalities, context/output limits, pricing metadata | MIT repository. Use a reviewed, versioned snapshot with provenance. Metadata and price listings do not establish the user's actual entitlement or recurring free quota. Preserve the existing official/community evidence distinction. |
| [OpenTelemetry GenAI conventions][otel-genai] | Shared field names for provider/model/usage/error tracing | Useful even for a small local telemetry store. GenAI conventions are marked Development, so pin the adopted schema. The GenAI documents have moved to a dedicated repository. |
| Existing `scripts/capture-branding.cjs` / Playwright | Real dashboard workflow assertions, responsive checks | Already exercises account creation, imports, password changes, and layout. Promote a short assertion-focused subset to pull-request CI and add route-preview/refresh regressions. Currently screenshots run only on manual workflow dispatch. |
| Node streams and filesystem primitives | Backpressure, cancellation, bounded output, staged file generations | Already available. Evaluate these before introducing another stream or storage dependency. Existing atomic JSON replacement and cloned config snapshots remain useful building blocks. |

**Recommended adoption order:** existing Node/SDK primitives and contract tests; an SSE parser; selective resilience helpers; then a measured AI SDK/v2 skills evaluation. A second full gateway becomes attractive if maintaining broad provider compatibility demonstrably dominates project effort. Compare it using the same fixtures and account/schedule requirements first.

## 5. Deep-module opportunities

Several defects arise because callers need to know policy spread across functions. The goal is a small interface hiding a substantial implementation.

### Route planning

Suggested interface: `plan(config, health, intent, instant) -> RoutePlan`.

Hide alias parsing, enabled status, schedules, cooldown/trip eligibility, profile capabilities, precedence, and skipped-candidate explanations. Both preview endpoints and execution consume this result. Inject time as one instant so every timezone sees the same moment.

### LLM request execution

Suggested interface: `execute(plan, request, { signal }) -> response/events + outcome`.

Hide provider-specific request preparation, attempt lifecycle, overall budget, body limits, stream startup validation, backpressure, normalized errors, and usage. Define when output becomes committed and what terminal outcomes mean. HTTP handlers should not separately update health based only on an upstream status.

### Skill bundle storage

Suggested interface: `install(entry)`, `read(id, file)`, `describe(id)`, `rollback(id)`.

Hide pinned downloads, limits, staging, generation commit/recovery, provenance, portable files, and download packaging. Readers should not independently assemble inconsistent manifest/config/directory snapshots.

### MCP namespace handling

Use one module for qualifying/resolving names and rewriting protocol-defined URI fields. Its interface should make round trips and authorization straightforward to test. Keep session ownership and backend connection lifecycle explicit in the gateway implementation.

## 6. Suggested delivery sequence

| Stage | Work | Exit criteria |
| --- | --- | --- |
| 1. Correctness | R1–R4, R6–R7; symmetric protocol fixtures | Stream errors remain errors; native requests preserve semantics; cancellation does not poison health; retryable pre-output failures reach fallbacks |
| 2. Routing and transport | Shared planner, R5/R8/R12, deadlines/backpressure, per-provider diagnostics | Preview matches selection; schedules use the correct clock; slow readers and stalled attempts stay bounded |
| 3. Durable data and MCP | R9–R11; namespace round trips, notification/cancellation coverage | Failed updates preserve a usable generation; resource links resolve; ordinary traffic does not create false deployment failures |
| 4. Better user experience | Request/attempt history, incremental page refresh, lazy catalogs, profile/capability selection | One request is explainable end to end; background refresh preserves interaction state; incompatible targets are skipped with reasons |
| 5. Broader compatibility | Native Responses; evaluated AI SDK outbound integration; MCP v2/skills migration | Published capability matrix and client-level regression tests pass on supported runtime/protocol versions |

R9 is independently urgent and can be implemented early alongside protocol work. Before any authorized production rollout, follow `docs/operations.md` with the stable container/volume identity and verification procedure.

## 7. Validation record and test improvements

Current research environment: Windows, Node **24.13.0**. Production Docker and CI target Node **22**.

- `npm run check`: **passed**, with Git Bash selected through `PATH`.
- `npm test`: **81 passed, 4 failed** with `PYTHONUTF8=1` and temporary directories under the approved OpenCode temp directory.
- Three failures are in `test-deployment.js`: the Bash/fake-command harness never creates `commands.jsonl`; its immediate read hides the underlying child-process diagnostic.
- One failure is the Unix file-mode assertion in `test-mcp-integrations.js:146`: Windows reports `0666` where the test expects `0600`.
- The earlier exporter encoding failure is resolved for the test run by `PYTHONUTF8=1`; it now passes. The exporter still deserves portable output/encoding behavior.
- The 19 behavioral observations above ran successfully as a separate research harness. Its local file is `C:/Users/Arshlaan/AppData/Local/Temp/opencode/giga-router-research-probes.cjs`; it uses synthetic data and removes each temporary data directory after execution. It records current defective behavior rather than passing the proposed acceptance criteria.

Recommended test changes:

1. Keep Linux/Node 22 mandatory for the production deployment and POSIX-permission tests. Add Windows coverage for portable functionality if Windows development remains supported.
2. Make deployment harness setup failures report `spawnSync` status/error/stderr before reading the command log.
3. Add equivalent stream/conversion coverage for both protocol directions; current `test-streaming.js` strongly favors OpenAI upstream to Anthropic client.
4. Run a small Playwright smoke suite on relevant pull requests using ephemeral ports and temporary data. Extend existing assertions rather than creating a parallel browser harness.
5. Convert legacy ad-hoc assertion runners to `node:test` as they are touched, so each case has independent reporting and filtering.
6. Test the installed dependency behavior before replacing it. For example, inspection confirmed the current MCP SDK already preserves a refresh token when a refresh response omits a replacement; that is not a missing Giga Router fix.

## Sources

All linked external sources were checked during this investigation; live documentation and npm tags can change.

[claude-streaming]: https://platform.claude.com/docs/en/build-with-claude/streaming
[claude-errors]: https://platform.claude.com/docs/en/api/errors
[openai-chat]: https://platform.openai.com/docs/api-reference/chat/create
[sse-spec]: https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream
[litellm-reliability]: https://docs.litellm.ai/docs/proxy/reliability
[bifrost-retries]: https://docs.getbifrost.ai/features/retries-and-fallbacks
[ai-providers]: https://ai-sdk.dev/docs/foundations/providers-and-models
[eventsource-parser]: https://github.com/rexxars/eventsource-parser
[cockatiel]: https://github.com/connor4312/cockatiel
[mcp-sdk]: https://github.com/modelcontextprotocol/typescript-sdk
[mcp-migration]: https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2
[mcp-skills]: https://ts.sdk.modelcontextprotocol.io/v2/servers/skills
[mcp-tools]: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
[models-dev]: https://models.dev/api.json
[otel-genai]: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md

Additional release/license checks: npm metadata for `@modelcontextprotocol/sdk`, `@modelcontextprotocol/client`, `@modelcontextprotocol/server`, `eventsource-parser`, and `cockatiel`; repository license files for LiteLLM, Bifrost, AI SDK, eventsource-parser, Cockatiel, and models.dev.
