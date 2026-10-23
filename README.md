<div align="center">

<img src="public/favicon.svg" alt="Giga Router" width="80" height="80" />

# Giga Router

**One connection for your models, tools, and skills.**

A self-hosted dashboard that connects your AI clients to your providers,
routes around failures, and brings your MCP tools and reusable instructions together.

[![CI](https://img.shields.io/github/actions/workflow/status/DeadIndian/giga-router/ci.yml?style=flat-square)](https://github.com/DeadIndian/giga-router/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22.12%2B-339933?style=flat-square)](https://nodejs.org/)

[Quick start](#quick-start) · [Connect a client](#connect-a-client) · [Routing](#choose-how-requests-route) · [Project website](docs/website.md) · [Documentation](#documentation)

</div>

## What you can do

- **Bring your providers:** OpenAI-compatible endpoints, Anthropic, and local model servers. Add API-key accounts using bundled provider presets or enter a custom endpoint.
- **Choose reliable routes:** priority-based fallbacks, manual selection, timezone-aware schedules, and named profiles such as `profile/coding`.
- **Understand failures:** see skipped providers, cooldowns, request IDs, attempt timing, and token usage. Test a provider directly from its row.
- **Connect tools once:** expose multiple HTTP, SSE, or local MCP servers through one authenticated `/mcp` endpoint.
- **Keep useful instructions:** browse GitHub skill catalogs, preview changes, install complete bundles, edit locally, and roll back an update.

Giga Router is a **single-user** service. You supply your provider API keys;
catalog presets do not grant credits or verify your account's quota.

## Quick start

### Try the dashboard

Requires **Node.js 22.12 or newer** and npm.

```bash
git clone git@github.com:DeadIndian/giga-router.git
cd giga-router
npm ci
npm run preview
```

Open the address printed in your terminal. Sign in with `preview` /
`preview-password`. The preview uses a random local port and temporary data;
press **Ctrl+C** to stop it and remove that workspace.

### Install with Docker

For a new installation, install Docker with the Compose plugin, then:

```bash
cp .env.example .env
```

Edit `.env` and replace these values:

```dotenv
user=admin
password=your-dashboard-password
ROUTER_KEY=your-long-random-gateway-key
```

Generate a random gateway key with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
Then start the service:

```bash
docker compose up -d --build --wait
```

Open **http://localhost:3002** and sign in. Configuration lives in the persistent
`llmrouter_llmrouter-data` volume. To update an existing production installation,
follow [the operations guide](docs/operations.md).

For a persistent installation without Docker, create `.env` as above and run
`npm start`. Data is saved in `data/`, or the directory set by `DATA_DIR`.
Set `HOST=127.0.0.1` for a loopback-only native installation.

## Your first working request

1. Open **Providers & routing** → **Add provider**, or choose **Free APIs** → **Add account**.
2. Enter the upstream base URL, API key, and model ID. Use the provider's documented API-key endpoint.
3. Click the provider's **Test provider** lightning icon. This makes one small inference request using your account.
4. Open **Access & endpoints**. Copy the router key, or create a scoped access key for your client.
5. Configure the client using the examples below. Its key is the **Giga Router key**; the upstream provider key stays on the router.

## Connect a client

| Client API | Base URL | Endpoint |
| --- | --- | --- |
| OpenAI-compatible | `http://localhost:3002/v1` | `/v1/chat/completions` |
| Anthropic / Claude Code | `http://localhost:3002` | `/v1/messages` |
| OpenAI Responses | `http://localhost:3002/v1` | `/v1/responses` |
| MCP | `http://localhost:3002/mcp` | Streamable HTTP |

### OpenAI-compatible clients

Set the base URL above and your Giga Router access key. Use model `default` to
follow the dashboard's routing rules, or copy a provider's model alias to pin it.

```bash
curl http://localhost:3002/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"Hello!"}]}'
```

### Claude Code

```bash
export ANTHROPIC_BASE_URL="http://localhost:3002"
export ANTHROPIC_API_KEY="YOUR_GATEWAY_KEY"
unset ANTHROPIC_AUTH_TOKEN
claude
```

The Anthropic base URL has **no `/v1` suffix**. Native Anthropic requests retain
their thinking settings. Cross-format routing supports text, images, and function
tools; see the [compatibility matrix](docs/compatibility.md) for limitations.

### MCP clients

Open **MCP servers** → **Browse integrations** to connect an app. Then choose
**Show me how** for client-specific configuration, including instructions for
merging into an existing config file.

Use the `/mcp` URL with `Authorization: Bearer YOUR_GATEWAY_KEY`. Tools are named
`server__tool`; installed skills appear through `giga__skill`, prompts, and
resources. Scoped keys can limit which backend servers a client may use.

### Responses API

Edit an OpenAI provider → **Model capabilities** → enable **Native Responses API**.
Use that provider's alias or a profile containing Responses-capable providers.
Native events, output items, and provider extensions are forwarded. For requests
using `previous_response_id`, pin the same provider with its alias or
`X-Giga-Provider` because conversation state belongs to that upstream.

## Choose how requests route

- **Auto:** tries enabled, eligible providers in priority order. Transient failures,
  overloads, and invalid upstream responses can fall back before output begins.
- **Manual:** uses only the active provider.
- **Schedules:** override auto routing. Weekdays name the day a window **starts**:
  Monday 23:00–02:00 includes Tuesday 01:00. The first matching window wins.
  The editor previews upcoming starts in your chosen timezone.
- **Profiles:** save an ordered chain and capability requirements under
  **Routing & schedules**. Select it with `model: "profile/coding"`.
- **Direct selection:** use `provider-slug/model-id`, or `X-Giga-Provider` with a
  saved provider ID/name. A disabled provider returns an explicit error.

Ordinary model names follow the selected provider's **default model**. Unknown
slash prefixes, such as upstream `organization/model` IDs, also follow ordinary
routing. `GET /v1/models` lists saved direct aliases and profiles.

**Live routing** and actual requests use the same planner. Known-incompatible
models are skipped; unknown capabilities remain eligible. Transient failures
normally cool down for 60 seconds, five consecutive failures open a 30-minute
circuit, and provider retry hints can extend the wait. Caller errors and client
cancellation do not damage provider health. Once output begins, errors remain
errors rather than switching providers halfway through a response.

## Skills and marketplace

Browse the bundled offline catalogs or add your own GitHub repository. Preview
instructions before installing. Installed bundles include supporting files and
licensing information; downloaded scripts are stored as files.

Use **Copy for chat**, download the ZIP, or let an MCP client load the skill.
Updates show changed files and any local edits. Each successful update saves a
complete generation; **Roll back update** restores the previous one. The installed
skill API's `portablePath` identifies its current directory inside `DATA_DIR`.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Client gets 401 | Use the router access key. Check its scope in **Access & endpoints**. |
| No provider available | Look at **Live routing** skip reasons, enable a provider, or retest a repaired account. |
| Unsupported translation | Choose a native-format provider or adjust the requested feature. |
| Responses request rejected | Explicitly enable the provider's Responses capability. |
| Wrong model/provider | Copy a direct alias; ordinary model names use the dashboard's default model. |
| Local upstream unreachable from Docker | Use `host.docker.internal` for a service on the Docker host. |
| Catalog unavailable | Other dashboard sections remain usable. Use **Refresh** to retry. |
| MCP tool missing | Test the connection and check the key's allowed servers. |

## Development

```bash
npm ci
npm run check
npm test
npm run preview
```

Checks require Bash (Git Bash on Windows); the exporter tests also use Python 3.
Tests use temporary data, loopback fixtures, and fake deployment commands.
Browser workflow checks run in CI. See [CONTEXT.md](CONTEXT.md) for module boundaries.

Preview the public project website with `npm run preview:site`, or generate its
GitHub Pages artifact with `npm run build:site`. See the
[website guide](docs/website.md) for publishing and editing instructions.

```text
server.js          HTTP composition and startup
lib/llm/           routing, protocols, streams, retries, and provider APIs
lib/               authentication, MCP, skill storage, catalogs
public/            dashboard and favicon.svg
site/              static project website for GitHub Pages
test/              regression and integration tests
fixtures/          local test backends
scripts/           checks, previews, catalog maintenance, deployment
docs/              guides, compatibility, operations, research
marketplaces/      bundled offline catalog snapshots
```

## Documentation

- [Compatibility and configuration](docs/compatibility.md)
- [MCP setup guide](docs/mcp-integrations.md)
- [Free API providers and imports](docs/free-providers.md)
- [Updates, backup, and recovery](docs/operations.md)
- [Project website and GitHub Pages](docs/website.md)
- [Implementation map](CONTEXT.md)
- [Reliability changes and remaining research](docs/reliability-release.md)
- [Research report](docs/improvement-research.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
