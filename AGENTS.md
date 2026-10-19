# Giga Router: live production service

The running service on **port 3002 is production** and is used daily. Treat its
provider accounts, API keys, password, routing schedules, MCP connections, and
data volume as user data. Brief deployment downtime is acceptable; keep it short.

## Development

- Work in `/home/dead/giga-router` and keep `origin` pointed at
  `git@github.com:DeadIndian/giga-router.git`.
- Never start a development server or run browser mutations against port 3002.
  Use an ephemeral loopback port and a temporary `DATA_DIR` for tests/previews.
- Do not change production configuration to make tests pass. Do not reset,
  delete, seed over, or print production credentials.
- Keep the single-user architecture and use `public/favicon.svg` as the one logo.
- Run `npm run check` and `npm test`. HTTP tests need loopback access; if the
  session blocks it, verify them with GitHub Actions and report the limitation.
- Commits must not include LLM attribution or co-author trailers.
- Free provider integrations use documented API keys. Do not add browser cookies,
  extracted session tokens, or subscription-login workarounds.
- Model presets are bundled in `lib/provider-models.json`. Use
  `npm run update:providers`, review its diff and provider terms, then follow
  `docs/free-providers.md`. Keep official verification separate from community
  free claims; never run catalog updates against production configuration.

## Update production

Read [docs/operations.md](docs/operations.md) before deploying. Prepare and test
code first, commit and push when authorized, then rebuild while the old container
continues serving. Recreate only the router container and wait for health checks.

The deployment identity is intentionally stable:

- Compose project and service: `llmrouter`.
- Container: `llmrouter-llmrouter-1`.
- Persistent volume: `llmrouter_llmrouter-data`, mounted at `/app/data`.
- HTTP port: `3002`; restart policy: `unless-stopped`.

Use `sudo ./scripts/deploy-local.sh` from this repository for an authorized
deployment. It enables Docker at boot, backs up account/config files, builds,
recreates the router, and verifies health and saved configuration. Never use
`docker compose down -v`, prune this volume, restart the whole Docker daemon,
or stop unrelated services for a router update.

If Docker/sudo is blocked by the tool sandbox, finish code and documentation,
push authorized changes, and provide the exact host-terminal command. Do not
claim production was updated until health, port, and saved settings are verified.
