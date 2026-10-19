const crypto = require('node:crypto');
const { auth: sdkAuth, discoverOAuthServerInfo, refreshAuthorization } = require('@modelcontextprotocol/sdk/client/auth.js');
const { loadConfig, updateConfig } = require('./storage');
const { readCredentials, writeCredentials } = require('./mcp-vault');
const { integrationById } = require('./mcp-catalog');
const { httpUrl, inputError } = require('./validation');
const { isDashboardSession } = require('./auth');

const flows = new Map();
const refreshes = new Map();
const FLOW_MS = 10 * 60_000;
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function callbackOrigin(requestOrigin) {
  const configured = process.env.GIGA_ROUTER_PUBLIC_URL || requestOrigin;
  const url = httpUrl(configured);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw inputError('Browser sign-in needs an HTTPS router address. Ask the person hosting this router to set GIGA_ROUTER_PUBLIC_URL, or use a personal access token.');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search) throw inputError('Router public URL must be its website address without an extra path or query.');
  return url.origin;
}

function serverRecord(id) {
  const server = loadConfig().mcpServers.find((entry) => entry.id === id);
  if (!server) throw inputError('This connection was removed. Add it again to sign in.', 404);
  return server;
}

function oauthDefinition(server) {
  const definition = integrationById(server.integrationId);
  if (!definition?.oauth || server.authKind !== 'oauth') throw inputError('This connection does not use browser sign-in.');
  if (!definition.oauth.origins.includes(new URL(server.url).origin)) throw inputError('This integration’s endpoint no longer matches its sign-in provider.');
  return definition;
}

function oauthFetch(server, definition = oauthDefinition(server), fetcher = fetch) {
  const allowed = new Set(definition.oauth.origins);
  return async (input, options = {}) => {
    const url = httpUrl(typeof input === 'string' ? input : input.url || input.toString());
    if (!allowed.has(url.origin)) throw inputError('The service requested an unexpected sign-in address. Reconnect using its official catalog entry.');
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
    return fetcher(input, { ...options, signal, redirect: 'error' });
  };
}

function validateDiscovery(discovery, definition) {
  if (!discovery.authorizationServerMetadata) throw inputError('Could not read the service’s sign-in settings. Try again or use its access-token option.');
  const allowed = new Set(definition.oauth.origins);
  if (!allowed.has(httpUrl(discovery.authorizationServerUrl).origin)) throw inputError('Unexpected authorization server.');
  const metadata = discovery.authorizationServerMetadata;
  for (const field of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint']) {
    if (metadata[field] && !allowed.has(httpUrl(metadata[field]).origin)) throw inputError('Unexpected sign-in endpoint.');
  }
  if (metadata.issuer && new URL(metadata.issuer).href.replace(/\/$/, '') !== new URL(discovery.authorizationServerUrl).href.replace(/\/$/, '')) throw inputError('The service returned mismatched sign-in settings.');
  if (!metadata.code_challenge_methods_supported?.includes('S256')) throw inputError('The service does not advertise the secure sign-in flow this router needs. Use an access token instead.');
  if (discovery.resourceMetadata && !allowed.has(httpUrl(discovery.resourceMetadata.resource).origin)) throw inputError('Unexpected token resource.');
  return discovery;
}

function summary(id) {
  const credentials = readCredentials(id);
  const live = [...flows.values()].find((flow) => flow.serverId === id && flow.expiresAt > Date.now());
  return { connected: !!credentials?.tokens?.access_token, pending: !!live, expiresAt: credentials?.expiresAt || null,
    account: credentials?.account || null, hasClient: !!credentials?.client?.client_id, state: credentials?.tokens?.access_token ? 'authorized' : live ? 'awaiting_sign_in' : 'not_connected' };
}

async function startSignIn(server, { origin, session, browserProof, clientId, clientSecret } = {}, dependencies = {}) {
  const definition = oauthDefinition(server);
  const site = callbackOrigin(origin);
  const redirectUrl = `${site}/api/mcp/oauth/callback`;
  const fetcher = oauthFetch(server, definition, dependencies.fetch || fetch);
  const discovered = validateDiscovery(await (dependencies.discover || discoverOAuthServerInfo)(server.url, { fetchFn: fetcher }), definition);
  let saved = readCredentials(server.id) || {};
  const issuer = discovered.authorizationServerUrl;
  if (saved.discovery?.authorizationServerUrl !== issuer || saved.redirectUrl && saved.redirectUrl !== redirectUrl) saved = {};
  if (clientId !== undefined) {
    if (typeof clientId !== 'string' || !clientId.trim() || clientId.length > 500) throw inputError('Paste the Client ID from your provider’s application settings.');
    if (clientSecret !== undefined && (typeof clientSecret !== 'string' || clientSecret.length > 2000)) throw inputError('Invalid Client secret.');
    if (definition.oauth.requiresClient && !clientSecret?.trim()) throw inputError('Paste the Client secret from the same GitHub app as your Client ID.');
    saved.client = { client_id: clientId.trim(), ...(clientSecret?.trim() ? { client_secret: clientSecret.trim(), token_endpoint_auth_method: 'client_secret_post' } : {}), issuer };
  }
  if (definition.oauth.requiresClient && !saved.client?.client_id) throw inputError('GitHub needs a one-time app setup. Follow the application steps below, or choose “Use an access token”.');
  for (const [state, flow] of flows) if (flow.expiresAt < Date.now() || flow.serverId === server.id) flows.delete(state);
  if (flows.size >= 100) throw inputError('Too many sign-in attempts are open. Finish one or try again shortly.', 429);
  const state = crypto.randomBytes(32).toString('base64url');
  const flow = { state, serverId: server.id, integrationId: server.integrationId, endpoint: server.url,
    credentialVersion: server.credentialVersion,
    session, browserProofHash: digest(browserProof), site, redirectUrl, expiresAt: Date.now() + FLOW_MS, client: saved.client,
    discovery: discovered, verifier: null, authorizationUrl: null };
  flows.set(state, flow);
  try {
    const provider = {
      redirectUrl,
      clientMetadata: { client_name: 'Giga Router', client_uri: site, redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: saved.client?.client_secret ? 'client_secret_post' : 'none' },
      clientMetadataUrl: site.startsWith('https:') ? `${site}/api/mcp/oauth/client-metadata/${server.id}` : undefined,
      state: () => state,
      clientInformation: () => flow.client,
      saveClientInformation: (information) => { flow.client = information; },
      tokens: () => undefined,
      saveTokens: () => { throw new Error('Sign-in requires browser approval first.'); },
      discoveryState: () => flow.discovery,
      saveDiscoveryState: (value) => { flow.discovery = validateDiscovery(value, definition); },
      saveCodeVerifier: (verifier) => { flow.verifier = verifier; },
      codeVerifier: () => flow.verifier,
      redirectToAuthorization: (url) => { if (!definition.oauth.origins.includes(url.origin)) throw inputError('Unexpected sign-in destination.'); flow.authorizationUrl = url.toString(); },
    };
    await (dependencies.auth || sdkAuth)(provider, { serverUrl: server.url, scope: server.oauthScope || undefined, fetchFn: fetcher });
    if (!flow.authorizationUrl || !flow.verifier || !flow.client) throw inputError('Could not start sign-in. Try again.');
    // Persist only client registration. The short-lived code verifier/state stay
    // in memory and are bound to the dashboard session that started the flow.
    const current = serverRecord(server.id);
    if (current.credentialVersion !== flow.credentialVersion || current.authKind !== 'oauth') throw inputError('This connection changed while starting sign-in. Try again.');
    writeCredentials(server.id, { ...saved, client: flow.client, discovery: flow.discovery, redirectUrl });
    return { authorizationUrl: flow.authorizationUrl, expiresAt: new Date(flow.expiresAt).toISOString(), callbackUrl: redirectUrl };
  } catch (error) {
    flows.delete(state);
    if (error.status) throw error;
    throw inputError('The service could not start sign-in. Check your app settings if you entered them, then try again or use an access token.', 502);
  }
}

async function finishSignIn({ state, code, error, issuer, browserProof } = {}, dependencies = {}) {
  const flow = typeof state === 'string' && flows.get(state);
  if (!flow || flow.expiresAt < Date.now()) throw inputError('This sign-in link expired. Return to Giga Router and click Sign in again.');
  if (!browserProof || flow.browserProofHash !== digest(browserProof) || !(dependencies.sessionValid || isDashboardSession)(flow.session)) throw inputError('Use the same signed-in browser session that started this sign-in.', 403);
  flows.delete(state); // Consume before any network request: a callback cannot replay.
  if (error) throw inputError('Sign-in was cancelled or declined. You can try again from your connection’s setup guide.');
  if (typeof code !== 'string' || !code || code.length > 4000) throw inputError('The service did not return a sign-in code. Try again.');
  if (issuer && new URL(issuer).href.replace(/\/$/, '') !== new URL(flow.discovery.authorizationServerUrl).href.replace(/\/$/, '')) throw inputError('The sign-in response came from another provider.');
  const server = serverRecord(flow.serverId);
  if (server.url !== flow.endpoint || server.authKind !== 'oauth' || server.credentialVersion !== flow.credentialVersion) throw inputError('This connection changed while signing in. Start again.');
  const definition = oauthDefinition(server);
  const provider = {
    redirectUrl: flow.redirectUrl,
    clientMetadata: { client_name: 'Giga Router', redirect_uris: [flow.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: flow.client?.client_secret ? 'client_secret_post' : 'none' },
    clientInformation: () => flow.client,
    tokens: () => undefined,
    discoveryState: () => flow.discovery,
    codeVerifier: () => flow.verifier,
    saveTokens: (tokens) => {
      const current = serverRecord(server.id);
      if (current.url !== flow.endpoint || current.authKind !== 'oauth' || current.credentialVersion !== flow.credentialVersion) throw inputError('Connection changed while signing in.');
      const previous = readCredentials(server.id) || {};
      writeCredentials(server.id, { ...previous, tokens, expiresAt: tokens.expires_in ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString() : null,
        client: flow.client, discovery: flow.discovery, redirectUrl: flow.redirectUrl });
    },
  };
  await (dependencies.auth || sdkAuth)(provider, { serverUrl: server.url, authorizationCode: code, fetchFn: oauthFetch(server, definition, dependencies.fetch || fetch) });
  return { serverId: server.id, site: flow.site, status: summary(server.id) };
}

async function accessToken(server, { forceRefresh = false, rejectedToken } = {}, dependencies = {}) {
  const definition = oauthDefinition(server);
  const saved = readCredentials(server.id);
  if (!saved?.tokens?.access_token) throw inputError('Open this connection’s setup guide and sign in to continue.', 401);
  if (!forceRefresh && (!saved.expiresAt || Date.parse(saved.expiresAt) - Date.now() > 60_000)) return saved.tokens.access_token;
  if (forceRefresh && rejectedToken && saved.tokens.access_token !== rejectedToken) return saved.tokens.access_token;
  if (refreshes.has(server.id)) return refreshes.get(server.id);
  const refresh = (async () => {
    const current = readCredentials(server.id);
    if (!current?.tokens?.refresh_token || !current.client || !current.discovery) {
      writeCredentials(server.id, { ...current, tokens: undefined, expiresAt: null });
      throw inputError('Your sign-in expired. Open the setup guide and sign in again.', 401);
    }
    validateDiscovery(current.discovery, definition);
    try {
      const tokens = await (dependencies.refresh || refreshAuthorization)(current.discovery.authorizationServerUrl, {
        metadata: current.discovery.authorizationServerMetadata, clientInformation: current.client,
        refreshToken: current.tokens.refresh_token, resource: current.discovery.resourceMetadata?.resource,
        fetchFn: oauthFetch(server, definition, dependencies.fetch || fetch),
      });
      const latest = readCredentials(server.id);
      const liveServer = serverRecord(server.id);
      if (!latest || latest.tokens?.refresh_token !== current.tokens.refresh_token || liveServer.authKind !== 'oauth' || liveServer.credentialVersion !== server.credentialVersion) throw inputError('This sign-in was disconnected. Sign in again.', 401);
      writeCredentials(server.id, { ...latest, tokens: { ...tokens, issuer: current.tokens.issuer }, expiresAt: tokens.expires_in ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString() : null });
      return tokens.access_token;
    } catch (error) {
      if (['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(error.errorCode)) {
        const latest = readCredentials(server.id);
        if (latest?.tokens?.refresh_token === current.tokens.refresh_token) writeCredentials(server.id, { ...latest, tokens: undefined, expiresAt: null });
        throw inputError('Your sign-in is no longer valid. Open the setup guide and sign in again.', 401);
      }
      if (error.status) throw error;
      throw inputError('The service could not renew your sign-in. Try the connection test again shortly.', 502);
    }
  })();
  refreshes.set(server.id, refresh);
  try { return await refresh; } finally { refreshes.delete(server.id); }
}

async function disconnectSignIn(server, dependencies = {}) {
  for (const [state, flow] of flows) if (flow.serverId === server.id) flows.delete(state);
  const saved = readCredentials(server.id);
  updateConfig((config) => { const current = config.mcpServers.find((entry) => entry.id === server.id); if (current) { current.enabled = false; current.connection = { state: 'disconnected' }; current.credentialVersion = (current.credentialVersion || 0) + 1; } });
  // Keep app registration for a future reconnect; remove all access/refresh
  // tokens before contacting the provider so a local disconnect always wins.
  if (saved) writeCredentials(server.id, { client: saved.client, discovery: saved.discovery, redirectUrl: saved.redirectUrl });
  let revoked = false;
  const endpoint = saved?.discovery?.authorizationServerMetadata?.revocation_endpoint;
  if (saved?.tokens?.access_token && endpoint) {
    try {
      const params = new URLSearchParams({ token: saved.tokens.refresh_token || saved.tokens.access_token, token_type_hint: saved.tokens.refresh_token ? 'refresh_token' : 'access_token', client_id: saved.client?.client_id || '' });
      if (saved.client?.client_secret) params.set('client_secret', saved.client.client_secret);
      const response = await oauthFetch(server, undefined, dependencies.fetch || fetch)(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
      revoked = response.ok;
      await response.body?.cancel();
    } catch { /* Access remains removed locally; provider settings can revoke the grant. */ }
  }
  return { ok: true, revoked, note: revoked ? 'Sign-in disconnected.' : 'Disconnected from this router. You can also remove its authorization in your provider’s account settings.' };
}

function clearPendingSignIn(id) { for (const [state, flow] of flows) if (flow.serverId === id) flows.delete(state); }
function clientMetadata(id) {
  const credentials = readCredentials(id);
  const clientId = credentials?.client?.client_id;
  if (typeof clientId !== 'string' || !clientId.startsWith('https:') || !credentials.redirectUrl) return null;
  return { client_id: clientId, client_name: 'Giga Router', client_uri: new URL(credentials.redirectUrl).origin,
    redirect_uris: [credentials.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
}
module.exports = { callbackOrigin, summary, clientMetadata, startSignIn, finishSignIn, accessToken, oauthFetch, validateDiscovery, disconnectSignIn, clearPendingSignIn };
