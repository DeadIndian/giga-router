# Connect an app or tool to your assistant

An **MCP connection** lets your assistant use an app or tool. You do not need to
enter its server address, write JSON, or install a command when using the
integration catalog.

## Start here

1. Sign in to Giga Router.
2. Open **MCP servers → Browse integrations**.
3. Pick the app or tool you want to use, then click **Connect** or **Set up tool**.
4. The guide shows three steps: **Choose → Connect → Ready**.
5. Follow the account instructions or click **Set up & test** for a local tool.
6. Giga Router tests the connection and lists how many tools it found.
7. Copy the example prompt into your assistant.

If your assistant is not connected to the router yet, click **Show connection
steps** on the completion screen, or **Show me how** in My connections. Select
Claude Code, Cursor, VS Code, or OpenCode. The guide explains where to paste the
configuration, where to get your router key, and how to check the connection.

## Available integrations

| Integration | Connection choices | What you need |
| --- | --- | --- |
| GitHub | Personal access token or browser sign-in | GitHub account; browser sign-in also needs a one-time OAuth App setup |
| Notion | Browser sign-in or Notion MCP token | Notion workspace membership; MCP tokens require Business/Enterprise and a workspace owner |
| Linear | Browser sign-in or API key | Linear account |
| Supabase | Browser sign-in or personal access token | Supabase account and the Project ID from your project dashboard |
| Context7 | Start without a key or supply an API key | No account required to start; free key provides higher limits |
| Tavily | Browser sign-in or API key | Tavily account; its usage limits apply |
| Files | Included local tool | Nothing to install; an easy shared folder is created by default |
| Memory | Included local tool | Nothing to install; facts are stored in the router's data volume |
| Thinking | Included local tool | Nothing to install |

### Browser sign-in

Click **Sign in to …**, sign in on the provider's website, choose the account or
workspace, and approve the access you want to grant. You return to Giga Router
automatically. Giga Router then tests the connection.

The service password is entered only on the service's own website. The router
stores the connection's access/refresh tokens encrypted in its data volume and
renews them when the service supports it.

### Personal access tokens and API keys

A token is a key supplied by the service that allows this router to connect.
The guide has a numbered checklist and an **Open … token settings** button.
Create a token, copy it, and paste it into the single token box. There are no
headers or JSON objects to work out.

- GitHub: choose your repository owner, selected repositories, and Contents,
  Issues, and Pull requests permissions.
- Notion: use a **Notion MCP token**, not an ordinary integration token.
- Supabase: use an **account personal access token**, not a project's anon,
  publishable, or service-role key.

### GitHub's one-time app setup

For the simplest connection, use a personal access token. If you prefer browser
sign-in, expand **One-time GitHub app setup**:

1. Open the linked GitHub OAuth App page.
2. Set the name to **Giga Router**.
3. Copy the **Homepage URL** and **Callback URL** from the guide into GitHub's
   matching boxes.
4. Register the app, copy its Client ID, and generate a Client secret.
5. Paste them in the guide and click **Sign in to GitHub**.

The app registration is saved. Future reconnects can leave those boxes blank.

### Files: upload a document without finding server paths

1. Choose **Files** and leave the optional folder box empty.
2. Click **Set up & test**.
3. Click **Open shared files** and choose a document to upload (up to 8 MB).
4. Ask your assistant to use Files to read or summarize that document.

The file lives on the router. An optional existing-folder path refers to the
router machine/container, not automatically to the laptop running the browser.
Files outside the configured folder are not available to this tool.

## Manage an existing connection

On **My connections**:

- **Setup guide** revisits the account/folder steps and reconnects an app.
- **Test connection** checks access and refreshes the tool list.
- **Pause / Resume** controls whether agents can use this connection.
- **Disconnect** stops use of the account, removes tokens locally, and attempts
  provider-side revocation where supported. App registration is kept for easy
  reconnection. You can also revoke the grant from the provider's account page.
- **Remove** deletes the connection and its credentials. Your uploaded files and
  memory facts are retained in the data volume.

## Hosting and browser sign-in

When you run the router on your own computer, `http://localhost:3002` or
`http://127.0.0.1:3002` can be used as a callback. When the router is on another
machine, browser sign-in needs an HTTPS website address.

The person hosting the router can set:

```env
GIGA_ROUTER_PUBLIC_URL=https://router.example.com
```

Use that exact address in your browser when signing in. The guide automatically
shows its callback, for example
`https://router.example.com/api/mcp/oauth/callback`. Token-based connections can
be used without setting up a provider OAuth App.

Back up the entire data volume, including **mcp-credentials.key**. That file
decrypts `mcp-credentials/*.json`; losing it means reconnecting your accounts.
Neither raw tokens nor OAuth Client secrets are returned by catalog/server APIs.

## Troubleshooting

- **Sign-in needed:** open Setup guide and sign in again. Revoked/expired refresh
  grants are cleared; the router does not repeatedly retry an invalid grant.
- **Connection test failed:** check account access, replace the saved token if it
  expired, and verify the router can reach the service's website. Settings remain
  saved so you do not need to start over.
- **Sign-in link expired:** start again from Setup guide. Browser approval links
  last ten minutes and must finish in the browser session that started them.
- **GitHub asks for app settings:** use the one-time checklist or choose the
  access-token option.
- **No documents visible:** upload files to the easy shared folder. A path on a
  remote router cannot automatically access files on your laptop.

## Implementation references

Official endpoint/setup requirements are linked on each catalog entry. The
router uses the official MCP SDK for discovery, PKCE, client registration, token
exchange, refresh, and transports. Sign-in destinations are limited to each
curated integration's known service origins. Gateway keys remain separate from
provider tokens. Memory uses a shared process with serialized tool calls so
parallel agent sessions do not overwrite each other's graph updates.
