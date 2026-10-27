# Reliability delivery record

This implements the defects identified in the
[2026-10-23 research report](improvement-research.md). Its original file/line
references describe the old baseline; current module boundaries are in
[CONTEXT.md](../CONTEXT.md).

## Fixed findings

| Research ID | Delivered behavior | Regression coverage |
| --- | --- | --- |
| R1 | Failed/truncated streams remain failures; stop reasons and requested usage survive conversion | `test/reliability.test.js`, `test/protocol-boundaries.test.js`, `test/streaming.test.js` |
| R2 | Native adaptive thinking is preserved; legacy rewrite is explicit and per-attempt | `test/reliability.test.js`, `test/provider.test.js` |
| R3 | Developer instructions, tool constraints, token limits, and URL images translate; unsupported features fail explicitly | `test/reliability.test.js`, `test/protocol-boundaries.test.js` |
| R4 | Failure categories, cancellation, overload failover, bounded retry hints, shared-account quota health, single recovery probes | `test/reliability.test.js`, `test/health.test.js` |
| R5 | Execution and previews share capability/health-aware route planning and skip reasons | `test/reliability.test.js` |
| R6 | Disabled direct aliases fail instead of falling through | `test/reliability.test.js` |
| R7 | Response validation is inside attempts; pre-output failures can fall back | `test/reliability.test.js`, `test/integration.test.js` |
| R8 | Per-window timezone, start-day overnight semantics, IANA/day validation, future-start preview | `test/protocol-boundaries.test.js`, `test/reliability.test.js` |
| R9 | Immutable bundle generations, single commit pointer, rollback, local-edit/file previews, concurrent-change detection | `test/bundles.test.js`, `test/reliability.test.js`, `test/gateway.test.js` |
| R10 | Tool links and embedded prompt resources round-trip through scoped namespaces | `test/mcp-forwarding.test.js`, `test/reliability.test.js` |
| R11 | Deployment excludes volatile activity, verifies vault continuity/static credentials, and backs up the vault | `test/fingerprint.test.js`, `test/deployment.test.js` |
| R12 | Maintained SSE framing handles CR-only, CRLF, split UTF-8, and bounded events | `test/reliability.test.js`, `test/integration.test.js`, `test/transport.test.js` |

## Additional improvements

- Separate total/header/first-output/idle deadlines and backpressure-aware writes.
- Request-level persisted diagnostics with ordered attempts, durations, token
  counts, upstream IDs, and skip reasons; no prompts or completions are recorded.
- Native Responses POST/streams with explicit capability selection and stateful
  follow-up pinning. Native Anthropic counting with a labeled estimate fallback.
- Dashboard profile editor, capability overrides, inference test/reset controls,
  lazy optional catalogs, and incremental polling that retains active controls.
- Bounded MCP discovery/cache, last-known unavailable metadata, list-change
  forwarding, and cancellation/progress on calls, prompts, and resource reads.
- Browser assertions now run on pull requests/pushes, alongside Linux and Windows
  Node checks. The deployment fixture works with Git Bash and fake host commands.
- Portable exporter output, an isolated preview command, extracted-backup restore
  verification, and all test files grouped under `test/`.
- Pinned official OpenAI and Anthropic clients verify translated stop reasons,
  token usage, startup text, partial-output errors, and Responses error handling.
- README reorganized around installation, first request, client setup, routing,
  troubleshooting, and development.

## Reuse decisions

Adopted pinned **eventsource-parser 4.1.2** through a cached dynamic import;
minimum runtime is **Node 22.12**. Reused Node stream/filesystem primitives and
the existing official MCP SDK for transport/authentication. Existing catalog
capability metadata remains the reviewed source of defaults.

The research also proposed broader evaluations. They remain follow-up work,
not completed integrations in this release:

- **MCP SDK v2/native skills:** requires migration of transport, OAuth, handler,
  and skills-layout contracts. Current tool/prompt/resource skill access remains
  the supported interface.
- **Vercel AI SDK/Cockatiel or a second gateway:** evaluate against the fixture
  suite before substituting protocol/resilience implementations. No additional
  gateway runtime or nested SDK retry policy is introduced here.
- **models.dev import and full capability provenance:** needs a reviewed snapshot
  update flow. Current tools/vision/context metadata and overrides are supported.
- **Background skill jobs, SHA/conditional download caching, and richer provider
  probes:** changed-file preview and transactional storage are delivered; job
  progress/cancellation and comprehensive feature certification are separate work.

See [compatibility.md](compatibility.md) for supported subsets and
[operations.md](operations.md) for the skill-generation rollback boundary.

## Verification

Verified on 2026-10-23:

- `npm run check`: passed.
- `npm test`: **117 passed, 0 failed, 0 skipped** (including legacy assertion runners).
- Node **22.12.0** reliability/transport suite: **26 passed, 0 failed**.
- Playwright dashboard workflow and responsive checks: passed.
- `git diff --check`: passed.

Local verification uses Windows/Node 24, temporary data directories, ephemeral
loopback ports, fake GitHub/Docker inputs, and in-memory MCP clients. The minimum
Node 22.12 runtime is also exercised against reliability and transport contracts.
Browser checks use pinned Playwright/Chromium at 390, 1024, and 1440 pixels and
cover catalog outages, retained search focus, profile/capability forms, schedule
preview, account/import flows, and password changes.
Polling also verifies the first event appears in an initially empty activity
table and expanded request details remain open.

The isolated restore test verifies copied settings and encrypted vault records.
Production deployment, live provider inference, and a restore of actual user
data are not part of this verification.
