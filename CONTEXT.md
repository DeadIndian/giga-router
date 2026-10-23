# Code map

Giga Router is a single-user Node/Express service. Read `AGENTS.md` for the
production boundary and `docs/compatibility.md` for protocol policy.

## LLM request path

1. `server.js` composes HTTP middleware, gateways, static assets, and startup.
2. `lib/llm/api.js` validates configuration, mounts public/admin routes, and
   returns masked provider settings.
3. `lib/llm/routing.js` produces one plan for both execution and previews:
   selection, schedules, profiles, capabilities, health, and skip reasons.
4. `lib/llm/proxy.js` owns the request deadline and attempt lifecycle. Validation
   happens before response commitment; post-output failures never retry.
5. `lib/llm/protocol.js` prepares fresh per-attempt bodies and translates the
   supported subset. `stream-state.js` validates native lifecycle without
   interpreting native content. `sse.js` handles bounded event framing.
6. `lib/llm/failures.js` decides category, retry eligibility, health effect, and
   provider retry delay. `lib/activity.js` stores bounded request metadata.

## Other boundaries

- `lib/storage.js`: cloned config snapshots and atomic JSON replacement.
- `lib/skill-bundles.js`: immutable generation directories and one config commit
  pointer; legacy reads, rollback, and unused-generation cleanup.
- `lib/skills.js`: skill parsing, GitHub/catalog operations, bundle installation,
  changed-file previews, and authenticated skill APIs.
- `lib/mcp.js`: per-session backend ownership, discovery, forwarding, and scopes.
  `lib/mcp-namespace.js` rewrites protocol-defined resource URI fields.
- `lib/mcp-integrations.js`, `mcp-oauth.js`, `mcp-vault.js`: guided setup, OAuth,
  and encrypted credentials. Keep transport/auth behavior in the official SDK.
- `public/app.js`: page rendering, lazy optional catalogs, forms, and incremental
  routing/activity refresh. Use `public/favicon.svg` as the sole logo.
- `site/`: public project website. `scripts/build-site.cjs` assembles `_site/`
  for GitHub Pages, using repository-aware links and the existing favicon.
- `scripts/config-fingerprint.cjs`: self-contained source executed inside old
  and new containers, independent of the deployed app's module versions.

## Verification

`npm run check` discovers JavaScript under source/test/script directories and
checks Bash syntax. `npm test` discovers `test/*.test.js`. Tests own their temp
directories and ephemeral loopback listeners. `scripts/capture-branding.cjs`
checks real dashboard workflows and responsive layouts with Playwright.
`npm run test:site` checks the static website in Chromium under a project subpath;
see `docs/website.md` for preview, publishing, and screenshot instructions.

Add meaningful behavioral contracts at these boundaries rather than testing
private helper implementation details. Never import application modules that
read persistent state in a test before setting its temporary `DATA_DIR`.
