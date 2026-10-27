# Giga Router implementation

## Existing foundation

The app uses Express and Node 22.12+. `server.js` composes focused modules in
`lib/llm/`; see [the current code map](../CONTEXT.md) and
[compatibility guide](compatibility.md). Its provider
configuration and routing windows live in `DATA_DIR/config.json`. The running
Docker service uses the `llmrouter_llmrouter-data` volume by default, explicitly
mapped so a folder rename preserves existing data. Compose also keeps the
`llmrouter` project and service identity to update the existing container.
Anthropic/OpenAI translation,
streaming, scheduled routing, and failover remain the routing engine.

## Acceptance criteria

- The dashboard manages custom providers and preserves their custom headers,
  User-Agent, routing order, and schedules when edited.
- A client can use one gateway key for both LLM endpoints and `/mcp`.
- MCP servers can be registered, enabled, disabled, discovered, and removed.
  HTTP, legacy SSE, and stdio backends use the official MCP SDK. Tools,
  prompts, and resources are namespaced behind the authenticated gateway.
- Nine curated MCP integrations provide beginner-friendly Choose/Connect/Ready
  guides, provider OAuth or token setup, automatic tests, and reconnect/removal.
  Files, Memory, and Thinking run from included MIT-licensed packages. Files has
  dashboard uploads; Memory serializes calls against one persistent graph.
- OAuth state/PKCE is session-bound and short-lived; app registrations and
  provider tokens are encrypted on disk. Dynamic registration and HTTPS client
  metadata documents are supported. Provider refreshes are serialized per grant.
- Users can save manual skills and add GitHub repositories as marketplace
  sources. Repositories are indexed for `SKILL.md`; preview, search, install,
  update, and uninstall work against persistent data.
- Self-hosted installs seed ten local marketplace catalogs. Defaults are
  individually removable, removal persists across restarts/upgrades, and an
  explicit restore action re-adds them. Existing sources are adopted without
  resetting user-refreshed indexes. An environment flag disables default seeding.
- Every skill has a one-click **Copy for chat** action. It copies the skill's
  instructions without YAML frontmatter. A separate action copies raw
  `SKILL.md`. Both work with a clipboard fallback and report failures honestly.
- Installed skills are persisted as bundles under `DATA_DIR/skills`, downloadable,
  and available to connected MCP clients as prompts/resources.
- API keys can be created and revoked, with scopes for LLM/MCP and optional
  restrictions to particular MCP servers.
- All existing routing/translation tests pass. New integration checks cover
  gateway authentication, marketplace persistence, and MCP aggregation. Browser
  checks cover clipboard contents and layouts at 390/1024/1440 pixels.

## Implementation boundaries

- Keep Express and a lightweight, self-hosted HTML/CSS/JavaScript dashboard.
- Use the existing single-user login and data directory, extending the config
  compatibly. Secret fields are masked in administrative responses.
- Use the MIT-licensed MCP SDK v1.32.1 for protocol handling rather than
  implementing JSON-RPC transports. Use `js-yaml` for skill frontmatter.
- Curated local MCP packages are pinned to MIT-licensed releases. New integration
  credentials use a volume-local AES-256-GCM key, backed up with the data volume.
- Adapt the GitHub parsing and path-safety portions of Vercel's MIT-licensed
  `skills` source parser, with upstream attribution and license text.
- Use MIT-licensed Feather icons, served locally. No remote UI dependencies.
- Custom source indexing is an explicit user action, cached on disk, and refreshable.
  Built-in catalogs are release-time snapshots loaded locally at startup without
  any GitHub request. Skills are not auto-installed from these catalogs.
  Installs download a selected skill directory from a pinned commit; they do
  not execute scripts or run repository installation commands.
- The UI exposes data from the actual configuration, source index, and gateway
  activity. No synthetic traffic, costs, or health metrics.

## Visual direction

Graphite surfaces, warm white text, lime primary actions, crisp dividers, and a
small routing-node brand mark. Side navigation keeps the workspace legible.
The logo comes from `public/favicon.svg` in every surface; see
[branding.md](branding.md) for the name, message, and visual conventions.
Task actions remain next to their relevant provider, source, server, or skill.
Marketplace cards prioritize description, source, installed state, and the copy
action. System fonts and local icons keep the first render fast and stable.

## Reuse research

- `modelcontextprotocol/typescript-sdk` v1.32.1 — MIT; client, stdio/SSE/HTTP
  transports, low-level server, and Streamable HTTP transport.
- `vercel-labs/skills` commit `13e4063a1cf913f5606d57d42ab83a86f5001e04` — MIT;
  adapt GitHub source parsing and repository path validation.
- `feathericons/feather` v4.29.2 — MIT; UI icon library.
- `nodeca/js-yaml` v5.5.0 — MIT; YAML frontmatter parsing.
- `101arrowz/fflate` v0.8.3 — MIT; downloadable ZIP bundles.
- Ten MIT-licensed source catalogs are bundled under `marketplaces/builtin/`;
  their manifest pins commits, repository scopes, counts, and source licenses.

Bundled sources are removable, not auto-installed. Repository and per-skill
licenses are displayed and preserved in the snapshots and installed bundles.
