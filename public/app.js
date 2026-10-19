/* Giga Router dashboard. Local assets, server-backed state, no browser secrets persisted. */
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name) => `<i data-feather="${name}"></i>`;
const tag = (text, style = '') => `<span class="tag ${style}">${esc(text)}</span>`;
const button = (label, action, id = '', style = '', symbol = '') => `<button class="button ${style}" data-action="${action}" data-id="${esc(id)}">${symbol ? icon(symbol) : ''}${esc(label)}</button>`;
const iconButton = (label, action, id, symbol) => `<button class="icon-button" title="${esc(label)}" aria-label="${esc(label)}" data-action="${action}" data-id="${esc(id)}">${icon(symbol)}</button>`;
const origin = location.origin;
const STATE = { providers: [], activeId: null, routing: {}, servers: [], skills: [], marketplace: [], sources: [], keys: [], overview: {}, integrations: [], mcpSetup: {}, mcpTab: 'connections', integrationSearch: '', integrationCategory: '', page: 'overview', providerTab: 'providers', marketTab: 'browse', search: '', sourceFilter: '', marketFilter: '', limit: 60 };
const previews = new Map();
let authenticated = false;
let loading = false;
let setupWizard = null;
const oauthReturn = new URLSearchParams(location.search).get('mcp_oauth');

const PAGE = {
  overview: { label: 'Overview', eyebrow: 'YOUR ROUTER', title: 'Your models and tools,<br>connected.', description: 'See where requests go. Manage your connections from one place.' },
  providers: { label: 'Providers & routing', eyebrow: 'YOUR MODELS', title: 'Every model. One connection.', description: 'Add a provider, choose your model, and set a fallback if you need one.' },
  mcp: { label: 'MCP servers', eyebrow: 'YOUR ASSISTANT’S TOOLBOX', title: 'Connect the apps you use.', description: 'Choose an app or tool. We’ll walk you through setup, one step at a time.' },
  skills: { label: 'My skills', eyebrow: 'YOUR INSTRUCTIONS', title: 'Useful instructions, ready to use.', description: 'Save a skill. Copy it into a chat or share it with your assistant.' },
  marketplace: { label: 'Marketplace', eyebrow: 'FIND A SKILL', title: 'Find instructions for the job.', description: 'Browse skills, read the preview, and install the ones you need.' },
  access: { label: 'Access & endpoints', eyebrow: 'CONNECT YOUR CLIENTS', title: 'One key. All your tools.', description: 'Connect your editor or agent to Giga Router, with scoped keys you can revoke.' },
};

function hydrateIcons() { window.feather?.replace({ 'stroke-width': 1.6 }); }
function toast(message, error = false) {
  const node = document.createElement('div');
  node.className = `toast${error ? ' error' : ''}`;
  node.innerHTML = icon(error ? 'alert-circle' : 'check-circle') + `<span>${esc(message)}</span>`;
  while ($('toasts').children.length >= 2) $('toasts').firstElementChild.remove();
  $('toasts').append(node);
  hydrateIcons();
  setTimeout(() => node.remove(), error ? 7000 : 3500);
}

async function api(endpoint, options = {}) {
  const response = await fetch(endpoint, { credentials: 'same-origin', ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    ...(options.body && typeof options.body !== 'string' ? { body: JSON.stringify(options.body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && authenticated) showLogin();
    throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || `Request failed (${response.status})`);
  }
  return data;
}

function showLogin() {
  authenticated = false;
  $('app').hidden = true;
  $('login-screen').hidden = false;
}

async function loadWorkspace(render = true) {
  if (loading) return;
  loading = true;
  $('refresh').disabled = true;
  try {
    const [config, routing, servers, skills, marketplace, keys, overview, integrations] = await Promise.all([
      api('/api/config'), api('/api/routing'), api('/api/mcp/servers'), api('/api/skills'), api('/api/marketplace'), api('/api/access/keys'), api('/api/overview'), api('/api/mcp/catalog'),
    ]);
    Object.assign(STATE, { providers: config.providers, activeId: config.activeId, hasRouterKey: config.hasRouterKey, routing,
      servers: servers.items, mcpSessions: servers.sessions, skills: skills.items, marketplace: marketplace.items,
      sources: marketplace.sources, keys: keys.items, environmentKey: keys.environmentKey, overview,
      defaultsEnabled: marketplace.defaultsEnabled, removedDefaults: marketplace.removedDefaults || [], integrations: integrations.items, mcpSetup: integrations.setup });
    if (STATE.sourceFilter && !STATE.sources.some((source) => source.id === STATE.sourceFilter)) STATE.sourceFilter = '';
    authenticated = true;
    $('login-screen').hidden = true;
    $('app').hidden = false;
    $('nav-providers').textContent = STATE.providers.length;
    $('nav-mcp').textContent = STATE.servers.length;
    $('nav-skills').textContent = STATE.skills.length;
    if (render) renderPage();
  } finally {
    loading = false;
    $('refresh').disabled = false;
  }
}

function empty(title, description, symbol, action = '', compact = false) {
  return `<div class="empty-state${compact ? ' compact' : ''}">${icon(symbol)}<h2>${esc(title)}</h2><p>${esc(description)}</p>${action}</div>`;
}

function timeAgo(value) {
  if (!value) return 'Not yet';
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  return seconds < 60 ? 'Just now' : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`;
}

function orderedProviders() {
  const byId = new Map(STATE.providers.map((provider) => [provider.id, provider]));
  const byName = new Map(STATE.providers.map((provider) => [provider.name.toLowerCase(), provider]));
  const seen = new Set();
  return [...(STATE.routing.autoOrder || []), STATE.activeId, ...STATE.providers.map((provider) => provider.id)]
    .map((id) => byId.get(id) || byName.get(String(id).toLowerCase())).filter((provider) => {
      if (!provider || seen.has(provider.id)) return false;
      seen.add(provider.id); return true;
    });
}

function routePanel() {
  const effective = STATE.routing.effective || {};
  const provider = STATE.providers.find((item) => item.id === effective.providerId);
  const chain = effective.chain || [];
  return `<div class="panel"><div class="panel-header"><h2>Live routing</h2>${tag(STATE.routing.mode === 'manual' ? 'Manual mode' : 'Auto mode', 'green')}</div><div class="panel-body">
    <span class="route-label">NEXT REQUEST ROUTES TO</span><div class="current-route"><span class="entity-icon accent">${icon('git-branch')}</span><div><h3>${esc(effective.provider || 'No provider connected')}</h3><p>${esc(provider?.defaultModel || 'Add your first model endpoint to get started')}</p></div>${provider ? tag('Selected', 'green') : ''}</div>
    ${chain.length ? `<div class="route-chain">${chain.map((name, i) => `${i ? icon('arrow-right') : ''}<span class="chain-node"><span>${i + 1}</span>${esc(name)}</span>`).join('')}</div>` : ''}
    <div class="route-note"><span>${effective.scheduled ? `Schedule: ${esc(effective.scheduled.label || effective.scheduled.start + '–' + effective.scheduled.end)}` : STATE.routing.mode === 'manual' ? 'Pinned to your active provider' : 'Priority order with automatic failover'}</span>${provider ? '<a href="#providers" data-action="routing-tab">Configure ' + icon('arrow-up-right') + '</a>' : button('Add provider', 'add-provider', '', 'small quiet', 'plus')}</div>
    ${effective.tripped ? `<p class="form-error">${esc(effective.tripped)} is temporarily out of the chain after repeated failures.</p>` : ''}
  </div></div>`;
}

function renderOverview() {
  const stats = [
    ['LLM providers', STATE.providers.length, 'git-branch', `${STATE.providers.filter((p) => p.enabled !== false).length} enabled`, '#providers'],
    ['MCP servers', STATE.servers.length, 'server', `${STATE.mcpSessions || 0} active sessions`, '#mcp'],
    ['Installed skills', STATE.skills.length, 'layers', `${STATE.skills.filter((s) => s.enabled !== false).length} available to agents`, '#skills'],
    ['Marketplace sources', STATE.sources.length, 'github', `${STATE.marketplace.length} skills indexed`, '#marketplace'],
  ];
  const recent = STATE.overview.recent || [];
  return `<div class="stats-grid">${stats.map(([label, value, symbol, note, href]) => `<a class="stat" href="${href}"><div class="stat-label">${esc(label)}${icon(symbol)}</div><div class="stat-value">${value}</div><div class="stat-note">${esc(note)}</div></a>`).join('')}</div>
  <div class="overview-grid"><div>${routePanel()}<div class="panel"><div class="panel-header"><h2>Recent gateway activity</h2><span class="subtle" style="font-size:10px">Since ${esc(new Date(STATE.overview.startedAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span></div>
    ${recent.length ? `<div class="table-scroll"><table><thead><tr><th>REQUEST</th><th>TYPE</th><th>STATUS</th><th>TIME</th></tr></thead><tbody>${recent.slice(0, 6).map((event) => `<tr><td><strong>${esc(event.name)}</strong>${event.model ? `<div class="model-id">${esc(event.model)}</div>` : ''}</td><td>${tag(event.kind.toUpperCase())}</td><td>${tag(event.status === 'ok' ? 'Success' : 'Failed', event.status === 'ok' ? 'green' : 'red')}</td><td class="subtle">${timeAgo(event.at)}</td></tr>`).join('')}</tbody></table></div>` : empty('Ready when you are', 'LLM and MCP calls will appear here as your agents use the gateway.', 'activity', '', true)}
    </div><div class="panel"><div class="panel-header"><h2>Your skills, within reach</h2><a href="#skills">View library ${icon('arrow-up-right')}</a></div>${STATE.skills.length ? `<div class="quick-list">${STATE.skills.slice(0, 3).map((skill) => `<div class="quick-link"><span class="entity-icon">${icon('file-text')}</span><div style="flex:1;min-width:0"><h3>${esc(skill.name)}</h3><p>${esc(skill.sourceName || 'Personal')}</p></div>${button('Copy for chat', 'copy-skill', skill.id, 'small', 'copy')}</div>`).join('')}</div>` : empty('Start a small, useful library', 'Save your own instructions or install a skill from GitHub.', 'layers', '', true)}</div></div>
    <div class="overview-right"><div class="panel"><div class="panel-header"><h2>Get connected</h2>${icon('arrow-up-right')}</div><div class="quick-list">
      <a class="quick-link" href="#providers"><span class="entity-icon">${icon('git-branch')}</span><div><h3>Bring your own model</h3><p>Custom endpoints. Your API keys.</p></div>${icon('chevron-right')}</a>
      <a class="quick-link" href="#mcp"><span class="entity-icon">${icon('server')}</span><div><h3>Connect an MCP server</h3><p>One endpoint for all your tools.</p></div>${icon('chevron-right')}</a>
      <a class="quick-link" href="#marketplace"><span class="entity-icon">${icon('compass')}</span><div><h3>Find your next skill</h3><p>Browse repositories you choose.</p></div>${icon('chevron-right')}</a>
      <a class="quick-link" href="#access"><span class="entity-icon">${icon('terminal')}</span><div><h3>Connect your editor</h3><p>Copy a config and get going.</p></div>${icon('chevron-right')}</a>
    </div></div><div class="copy-callout">${icon('clipboard')}<h3>Your best instructions,<br>one click away.</h3><p>Find a skill. Hit <strong>Copy for chat</strong>. Paste into Claude, ChatGPT, or any other conversation. No setup required.</p><a class="button primary" href="#skills">Open my skills ${icon('arrow-right')}</a></div></div>
  </div>`;
}

function renderProviders() {
  const tabs = `<div class="tab-bar"><button class="${STATE.providerTab === 'providers' ? 'active' : ''}" data-action="provider-tab" data-id="providers">Providers ${tag(STATE.providers.length)}</button><button class="${STATE.providerTab === 'routing' ? 'active' : ''}" data-action="provider-tab" data-id="routing">Routing & schedules</button></div>`;
  if (STATE.providerTab === 'routing') return tabs + renderRouting();
  const health = new Map((STATE.routing.health || []).map((entry) => [entry.id, entry]));
  return tabs + `<div class="info-strip">${icon('git-branch')}<p>Both <code>/v1/messages</code> and <code>/v1/chat/completions</code> use your existing routing engine. To select a provider directly, use its <code>provider/model</code> alias.</p><a href="#access">Connection guide ↗</a></div>` + (STATE.providers.length ? `<div class="panel"><div class="table-scroll"><table><thead><tr><th>PROVIDER</th><th>API FORMAT</th><th>MODEL ALIAS</th><th>STATE</th><th></th></tr></thead><tbody>${STATE.providers.map((provider) => {
    const status = health.get(provider.id);
    return `<tr><td><div class="table-entity"><span class="entity-icon">${icon('box')}</span><div><strong>${esc(provider.name)} ${provider.id === STATE.activeId ? tag('Active', 'green') : ''}</strong><small>${esc(provider.baseUrl)}</small></div></div></td><td>${tag(provider.type === 'anthropic' ? 'Anthropic' : 'OpenAI')}</td><td><span class="model-id">${esc(provider.slug)}/${esc(provider.defaultModel)}</span>${iconButton('Copy model alias', 'copy-alias', provider.id, 'copy')}</td><td>${tag(provider.enabled === false ? 'Disabled' : status?.tripped ? 'Tripped' : status?.cooling ? 'Cooling' : 'Enabled', provider.enabled === false ? '' : status?.tripped || status?.cooling ? 'amber' : 'green')}</td><td><div class="table-actions">${provider.id !== STATE.activeId && provider.enabled !== false ? button('Use', 'use-provider', provider.id, 'small') : ''}${iconButton('Edit provider', 'edit-provider', provider.id, 'edit-2')}${iconButton(provider.enabled === false ? 'Enable provider' : 'Disable provider', 'toggle-provider', provider.id, provider.enabled === false ? 'play' : 'pause')}${iconButton('Delete provider', 'delete-provider', provider.id, 'trash-2')}</div></td></tr>`;
  }).join('')}</tbody></table></div></div>` : empty('Bring your first provider', 'Add any OpenAI-compatible or Anthropic-compatible endpoint, including a local model server.', 'git-branch', button('Add provider', 'add-provider', '', 'primary', 'plus')));
}

function renderRouting() {
  const health = new Map((STATE.routing.health || []).map((entry) => [entry.id, entry]));
  const providers = orderedProviders();
  const schedules = STATE.routing.schedules || [];
  return `<div class="settings-grid"><div>${routePanel()}<div class="panel"><div class="setting-row"><div><h3>Routing mode</h3><p>Auto tries your chain. Manual stays on the active provider.</p></div><div class="segmented"><button class="${STATE.routing.mode === 'auto' ? 'active' : ''}" data-action="set-mode" data-id="auto">Auto</button><button class="${STATE.routing.mode === 'manual' ? 'active' : ''}" data-action="set-mode" data-id="manual">Manual</button></div></div><div class="panel-header"><h2>Fallback priority</h2>${button('Reset cooldowns', 'reset-health', '', 'small quiet', 'refresh-cw')}</div>
    ${providers.length ? providers.map((provider, i) => `<div class="order-row"><span class="order-number">${String(i + 1).padStart(2, '0')}</span><div class="order-name">${esc(provider.name)} ${provider.enabled === false ? tag('Disabled') : health.get(provider.id)?.tripped ? tag('Tripped', 'amber') : ''}<small>${esc(provider.defaultModel)}</small></div><div class="table-actions"><button class="icon-button" aria-label="Move ${esc(provider.name)} up" data-action="move-provider" data-id="${provider.id}" data-direction="-1" ${i === 0 ? 'disabled' : ''}>${icon('arrow-up')}</button><button class="icon-button" aria-label="Move ${esc(provider.name)} down" data-action="move-provider" data-id="${provider.id}" data-direction="1" ${i === providers.length - 1 ? 'disabled' : ''}>${icon('arrow-down')}</button></div></div>`).join('') : empty('No providers', 'Add a provider before configuring routing.', 'git-branch', '', true)}
  </div></div><div><div class="panel"><div class="panel-header"><h2>Schedule overrides</h2>${button('Add window', 'add-schedule', '', 'small', 'plus')}</div>${schedules.length ? schedules.map((schedule) => {
    const provider = STATE.providers.find((entry) => entry.id === schedule.providerId);
    return `<div class="schedule-item"><div class="inline-row"><h3>${esc(schedule.label || provider?.name || 'Routing window')}</h3>${tag(schedule.fallbackOnFailure ? 'Fallback on' : 'Strict')}</div><p><strong>${esc(schedule.start)}–${esc(schedule.end)}</strong> · ${esc(schedule.timezone || 'Asia/Kolkata')}</p><p style="margin-top:4px">${esc(provider?.name || 'Missing provider')} · ${esc(schedule.days?.length ? schedule.days.join(', ') : 'Every day')}</p><div class="table-actions">${button('Edit', 'edit-schedule', schedule.id, 'small quiet', 'edit-2')}${iconButton('Delete schedule', 'delete-schedule', schedule.id, 'trash-2')}</div></div>`;
  }).join('') : empty('Your schedule is open', 'Add a time window to pin traffic to a provider at a specific time.', 'clock', '', true)}</div><div class="info-strip section-space">${icon('info')}<p>Failed providers cool down for 60 seconds. Five consecutive failures trip them for 30 minutes. A strict schedule stays pinned; enable fallback on a window to use the rest of your chain.</p></div></div></div>`;
}

function renderMcp() {
  const tabs = `<div class="tab-bar"><button class="${STATE.mcpTab === 'connections' ? 'active' : ''}" data-action="mcp-tab" data-id="connections">My connections ${tag(STATE.servers.length)}</button><button class="${STATE.mcpTab === 'browse' ? 'active' : ''}" data-action="mcp-tab" data-id="browse">Browse integrations ${tag(STATE.integrations.length)}</button></div>`;
  if (STATE.mcpTab === 'browse') return tabs + `<div class="info-strip">${icon('help-circle')}<p><strong>What is an MCP?</strong> It’s a connection that lets your assistant use an app or tool. Pick one below; the setup guide handles the technical settings for you.</p></div><div class="toolbar"><div class="search-box">${icon('search')}<input id="integration-search" type="search" aria-label="Search integrations" placeholder="Search apps and tools…" value="${esc(STATE.integrationSearch)}"></div><select id="integration-category" aria-label="Integration category"><option value="">All integrations</option>${['Work & code', 'Research', 'Local tools'].map((category) => `<option ${STATE.integrationCategory === category ? 'selected' : ''}>${esc(category)}</option>`).join('')}</select><span class="result-count" id="integration-count"></span></div><div id="integration-results"></div>`;
  return tabs + `<div class="info-strip">${icon('link')}<p>Connect your assistant to Giga Router once. Any app you add here becomes part of its toolbox.</p>${button('Show me how', 'assistant-guide', '', 'small quiet', 'arrow-right')}</div>` + (STATE.servers.length ? `<div class="connection-grid">${STATE.servers.map((server) => {
    const definition = STATE.integrations.find((entry) => entry.id === server.integrationId);
    const state = server.authKind === 'oauth' && !server.auth?.connected ? 'Sign-in needed' : server.health.state === 'disconnected' ? 'Disconnected' : server.health.state === 'error' ? 'Needs attention' : server.enabled === false ? 'Paused' : server.health.state === 'connected' ? 'Connected' : 'Not tested';
    return `<article class="connection-card"><div class="connection-heading"><span class="entity-icon ${state === 'Connected' ? 'accent' : ''}">${icon(definition?.icon || 'server')}</span><div><h3>${esc(server.name)}</h3><p>${definition?.kind === 'local' ? 'Runs on your router' : 'Hosted service'}</p></div>${tag(state, state === 'Connected' ? 'green' : state === 'Needs attention' ? 'red' : '')}</div><p class="connection-description">${esc(definition?.description || server.url || 'Custom connection')}</p>${server.health.tools !== undefined ? `<p class="subtle connection-detail">${server.health.tools} tools available · Last tested ${timeAgo(server.health.checkedAt)}</p>` : ''}${server.auth?.account ? `<p class="connection-detail">${esc(server.auth.account)}</p>` : ''}<div class="connection-actions">${definition ? button('Setup guide', 'setup-integration', definition.id, 'small', 'help-circle') : button('Edit settings', 'edit-mcp', server.id, 'small', 'edit-2')}${button('Test connection', 'check-mcp', server.id, 'small quiet', 'zap')}${server.sharedFolder ? button('Shared files', 'shared-files', server.id, 'small quiet', 'folder') : ''}${button(server.enabled === false ? 'Resume' : 'Pause', 'toggle-mcp', server.id, 'small quiet', server.enabled === false ? 'play' : 'pause')}${definition ? button('Disconnect', 'disconnect-mcp', server.id, 'small quiet', 'link-2') : ''}${iconButton('Remove ' + server.name, 'delete-mcp', server.id, 'trash-2')}</div></article>`;
  }).join('')}</div>` : empty('Give your assistant its first tool', 'Choose a familiar app, follow the setup guide, and we’ll test the connection for you. No URLs or commands to figure out.', 'link', button('Browse integrations', 'mcp-tab', 'browse', 'primary', 'compass')));
}

function renderIntegrationResults() {
  if (!$('integration-results')) return;
  const query = STATE.integrationSearch.toLowerCase().trim();
  const entries = STATE.integrations.filter((entry) => (!query || `${entry.name} ${entry.description}`.toLowerCase().includes(query)) && (!STATE.integrationCategory || entry.category === STATE.integrationCategory));
  $('integration-count').textContent = `${entries.length} integrations`;
  $('integration-results').innerHTML = `<div class="skill-grid">${entries.map((entry) => `<article class="integration-card"><div class="skill-card-top"><span class="entity-icon">${icon(entry.icon)}</span>${tag(entry.connectedServer ? 'Added' : entry.kind === 'local' ? 'Included locally' : entry.methods.includes('oauth') ? 'Browser sign-in' : 'Easy setup', entry.connectedServer ? 'green' : '')}</div><h3>${esc(entry.name)}</h3><p>${esc(entry.description)}</p><span class="integration-kind">${entry.kind === 'local' ? 'No account needed · Runs on your router' : entry.id === 'context7' ? 'Start without an account' : 'Connect your existing account'}</span>${button(entry.connectedServer ? 'Open setup guide' : entry.kind === 'local' ? 'Set up tool' : 'Connect', 'setup-integration', entry.id, 'primary', 'arrow-right')}</article>`).join('')}</div>`;
  if (!entries.length) $('integration-results').innerHTML = empty('No matching integrations', 'Try another name or category. Custom connections are still available from Advanced setup.', 'search');
  hydrateIcons();
}

function searchToolbar(isMarketplace) {
  return `<div class="toolbar"><div class="search-box">${icon('search')}<input id="skill-search" type="search" placeholder="Search ${isMarketplace ? 'skills, descriptions, or repositories' : 'your skill library'}…" aria-label="Search skills" value="${esc(STATE.search)}"></div>
    ${isMarketplace ? `<select id="source-filter" aria-label="Filter by repository"><option value="">All repositories</option>${STATE.sources.map((source) => `<option value="${source.id}" ${STATE.sourceFilter === source.id ? 'selected' : ''}>${esc(source.name)}</option>`).join('')}</select><select id="market-filter" aria-label="Filter installation status"><option value="">All skills</option><option value="available" ${STATE.marketFilter === 'available' ? 'selected' : ''}>Not installed</option><option value="installed" ${STATE.marketFilter === 'installed' ? 'selected' : ''}>Installed</option><option value="updates" ${STATE.marketFilter === 'updates' ? 'selected' : ''}>Updates available</option></select>` : ''}<span id="result-count" class="result-count"></span></div><div id="skill-results"></div>`;
}

function skillKey(skill) { return skill.id || `${skill.sourceId}:${skill.path}`; }
function skillCard(skill, marketplace) {
  const key = skillKey(skill);
  return `<article class="skill-card"><div class="skill-card-top"><span class="entity-icon ${marketplace ? '' : 'accent'}">${icon('file-text')}</span><div class="inline-row">${skill.updateAvailable ? tag('Update available', 'amber') : marketplace && skill.installedId ? tag('Installed', 'green') : !marketplace ? tag(skill.enabled === false ? 'Disabled' : 'Installed', skill.enabled === false ? '' : 'green') : tag(skill.license || 'License unspecified')}</div></div>
    <h3><button data-action="${marketplace ? 'preview-market' : 'preview-skill'}" data-id="${esc(key)}">${esc(skill.name)}</button></h3><p class="skill-description">${esc(skill.description || 'Reusable instructions for your next task.')}</p><div class="skill-meta"><a href="${esc(skill.sourceUrl || '#skills')}" ${skill.sourceUrl ? 'target="_blank" rel="noopener noreferrer"' : ''}>${icon(skill.sourceUrl ? 'github' : 'user')}${esc(skill.sourceName || 'Personal')}</a>${!marketplace && skill.license ? `<span>· ${esc(skill.license)}</span>` : ''}</div>
    <div class="skill-card-actions">${button('Copy for chat', marketplace ? 'copy-market' : 'copy-skill', key, marketplace ? 'small copy-action' : 'small primary', 'copy')}
      ${marketplace ? button(skill.updateAvailable ? 'Update' : skill.installedId ? 'View' : 'Install', skill.installedId && !skill.updateAvailable ? 'view-installed' : 'install-market', key, 'small quiet', skill.installedId && !skill.updateAvailable ? 'arrow-up-right' : 'download') : iconButton('Edit skill', 'edit-skill', key, 'edit-2') + iconButton(skill.enabled === false ? 'Enable skill' : 'Disable skill', 'toggle-skill', key, skill.enabled === false ? 'play' : 'pause')}
    </div></article>`;
}

function renderSkillResults() {
  if (!$('skill-results')) return;
  const marketplace = STATE.page === 'marketplace';
  const query = STATE.search.trim().toLowerCase();
  const items = (marketplace ? STATE.marketplace : STATE.skills).filter((skill) =>
    (!query || `${skill.name} ${skill.description} ${skill.sourceName}`.toLowerCase().includes(query)) &&
    (!marketplace || !STATE.sourceFilter || skill.sourceId === STATE.sourceFilter) &&
    (!marketplace || !STATE.marketFilter || (STATE.marketFilter === 'installed' ? skill.installedId : STATE.marketFilter === 'available' ? !skill.installedId : skill.updateAvailable)));
  $('result-count').textContent = `${items.length} skill${items.length === 1 ? '' : 's'}`;
  $('skill-results').innerHTML = items.length ? `<div class="skill-grid">${items.slice(0, STATE.limit).map((skill) => skillCard(skill, marketplace)).join('')}</div>${items.length > STATE.limit ? button(`Show more (${items.length - STATE.limit} remaining)`, 'show-more', '', 'quiet show-more', 'chevron-down') : ''}`
    : empty(query || STATE.sourceFilter || STATE.marketFilter ? 'No matching skills' : marketplace ? 'Make GitHub your marketplace' : 'Your next great prompt starts here',
      query || STATE.sourceFilter || STATE.marketFilter ? 'Try a different search or clear your filters.' : marketplace ? 'Add a repository containing SKILL.md files. Browse its skills, preview the instructions, and install only what you need.' : 'Write your own skill or install one from a repository. Your Copy for chat button is always within reach.', marketplace ? 'github' : 'layers',
      query || STATE.sourceFilter || STATE.marketFilter ? button('Clear filters', 'clear-filters', '', 'quiet', 'x') : marketplace ? button('Add repository', 'add-source', '', 'primary', 'plus') : `<div class="button-row" style="justify-content:center">${button('Create a skill', 'add-skill', '', 'primary', 'plus')}<a class="button quiet" href="#marketplace">Browse marketplace ${icon('arrow-right')}</a></div>`);
  hydrateIcons();
}

function renderMarketplace() {
  return `<div class="tab-bar"><button class="${STATE.marketTab === 'browse' ? 'active' : ''}" data-action="market-tab" data-id="browse">Browse skills ${tag(STATE.marketplace.length)}</button><button class="${STATE.marketTab === 'sources' ? 'active' : ''}" data-action="market-tab" data-id="sources">My repositories ${tag(STATE.sources.length)}</button></div>` + (STATE.marketTab === 'sources' ? renderSources() : searchToolbar(true));
}

function renderSources() {
  return `<div class="section-heading"><div><h2>Your marketplace sources</h2><p>Built-in catalogs are ready to browse. Remove any source; it stays removed after restart. Installed skills are kept.</p></div>${STATE.defaultsEnabled && STATE.removedDefaults.length ? button('Restore built-in sources', 'restore-defaults', '', 'small quiet', 'rotate-ccw') : ''}</div>${STATE.sources.length ? `<div class="source-list">${STATE.sources.map((source) => `<div class="source-card"><span class="entity-icon">${icon('github')}</span><div class="source-info"><h3>${esc(source.name)} ${source.builtinId ? tag('Built-in', 'green') : ''} ${tag(source.count + ' skills')}</h3>${source.description ? `<p>${esc(source.description)}</p>` : ''}<p>${esc(source.url)}${source.path ? '/' + esc(source.path) : ''}</p><p>${esc(source.ref)} · ${esc(source.license || 'License unspecified')} · Indexed ${timeAgo(source.indexedAt)}</p></div><div class="source-actions">${button('Browse', 'browse-source', source.id, 'small quiet', 'compass')}${button('Refresh', 'refresh-source', source.id, 'small quiet', 'refresh-cw')}${iconButton('Remove ' + source.name, 'delete-source', source.id, 'trash-2')}</div></div>`).join('')}</div>` : empty('Your repositories go here', 'Add any GitHub repository or restore the bundled catalogs. Branch and path overrides are supported.', 'github', button('Add repository', 'add-source', '', 'primary', 'plus'))}`;
}

function connectionSnippets() {
  return {
    claude: `export ANTHROPIC_BASE_URL="${origin}"\nexport ANTHROPIC_API_KEY="YOUR_GATEWAY_KEY"\nunset ANTHROPIC_AUTH_TOKEN`,
    openai: `export OPENAI_BASE_URL="${origin}/v1"\nexport OPENAI_API_KEY="YOUR_GATEWAY_KEY"`,
    mcp: JSON.stringify({ mcpServers: { 'giga-router': { url: `${origin}/mcp`, headers: { Authorization: 'Bearer YOUR_GATEWAY_KEY' } } } }, null, 2),
  };
}

function renderAccess() {
  const snippets = connectionSnippets();
  return `<div class="settings-grid"><div><div class="panel"><div class="panel-header"><h2>Gateway endpoints</h2>${tag('Unified authentication', 'green')}</div>${[
    ['OpenAI-compatible API', origin + '/v1', 'openai-url'], ['Anthropic Messages API', origin, 'anthropic-url'], ['MCP gateway', origin + '/mcp', 'mcp-url'],
  ].map(([name, url, id]) => `<div class="endpoint"><div><h3>${name}</h3><code>${esc(url)}</code></div>${button('Copy', 'copy-endpoint', id, 'small quiet', 'copy')}</div>`).join('')}</div>
  <div class="panel"><div class="panel-header"><h2>Access keys</h2>${button('Create key', 'add-key', '', 'small', 'plus')}</div><div class="setting-row"><div><h3>Router key ${tag(STATE.hasRouterKey ? 'Configured' : 'Not set', STATE.hasRouterKey ? 'green' : '')}</h3><p>Your existing ROUTER_KEY. Allows LLM and all MCP servers.</p></div>${STATE.hasRouterKey ? button('Copy key', 'copy-router-key', '', 'small quiet', 'copy') : ''}</div>${STATE.keys.map((key) => `<div class="setting-row"><div><h3>${esc(key.name)} ${key.revokedAt ? tag('Revoked', 'red') : tag(key.scopes.join(' + '))}</h3><p><code>${esc(key.prefix)}…</code> · ${key.serverIds !== null ? `${key.serverIds?.length || 0} MCP servers allowed` : 'All MCP servers'} · Used ${timeAgo(key.lastUsedAt)}</p></div>${!key.revokedAt ? button('Revoke', 'revoke-key', key.id, 'small danger') : ''}</div>`).join('')}</div></div>
  <div><div class="panel"><div class="panel-header"><h2>Quick connection guide</h2>${icon('terminal')}</div><div class="panel-body"><h3>Claude Code / Anthropic SDK</h3><div class="code-block with-copy">${iconButton('Copy Anthropic setup', 'copy-snippet', 'claude', 'copy')}<pre>${esc(snippets.claude)}</pre></div><p class="subtle" style="font-size:10px;margin-bottom:22px">Replace YOUR_GATEWAY_KEY with a key from this page. The base URL does not include /v1.</p><h3>OpenAI-compatible clients</h3><div class="code-block with-copy">${iconButton('Copy OpenAI setup', 'copy-snippet', 'openai', 'copy')}<pre>${esc(snippets.openai)}</pre></div><h3 class="section-space">MCP client configuration</h3><div class="code-block with-copy">${iconButton('Copy MCP configuration', 'copy-snippet', 'mcp', 'copy')}<pre>${esc(snippets.mcp)}</pre></div><p class="subtle" style="font-size:10px">Use a client that supports Streamable HTTP and custom authorization headers. Installed skills appear as MCP prompts and resources.</p></div></div></div></div>`;
}

function renderPage() {
  const page = PAGE[STATE.page];
  document.title = `${page.label} · Giga Router`;
  $('page-label').textContent = page.label;
  $('page-eyebrow').textContent = page.eyebrow;
  $('page-title').innerHTML = page.title;
  $('page-description').textContent = page.description;
  document.querySelectorAll('nav a').forEach((node) => { node.classList.toggle('active', node.dataset.page === STATE.page); if (node.dataset.page === STATE.page) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
  $('page-actions').innerHTML = STATE.page === 'overview' ? `<a class="button quiet" href="#access">${icon('terminal')}Connect a client</a>${button('Add provider', 'add-provider', '', 'primary', 'plus')}`
    : STATE.page === 'providers' ? button('Add provider', 'add-provider', '', 'primary', 'plus')
      : STATE.page === 'mcp' ? `${button('Advanced setup', 'add-mcp', '', 'quiet', 'sliders')}${button('Browse integrations', 'mcp-tab', 'browse', 'primary', 'plus')}`
        : STATE.page === 'skills' ? `<a class="button quiet" href="#marketplace">${icon('compass')}Browse marketplace</a>${button('Create a skill', 'add-skill', '', 'primary', 'plus')}`
          : STATE.page === 'marketplace' ? button('Add repository', 'add-source', '', 'primary', 'plus') : button('Create key', 'add-key', '', 'primary', 'plus');
  $('page-content').innerHTML = STATE.page === 'overview' ? renderOverview() : STATE.page === 'providers' ? renderProviders() : STATE.page === 'mcp' ? renderMcp() : STATE.page === 'skills' ? searchToolbar(false) : STATE.page === 'marketplace' ? renderMarketplace() : renderAccess();
  if (STATE.page === 'skills' || (STATE.page === 'marketplace' && STATE.marketTab === 'browse')) renderSkillResults();
  if (STATE.page === 'mcp' && STATE.mcpTab === 'browse') renderIntegrationResults();
  hydrateIcons();
}

function navigate() {
  const requested = location.hash.slice(1) || 'overview';
  STATE.page = PAGE[requested] ? requested : 'overview';
  STATE.search = ''; STATE.limit = 60;
  if (authenticated) renderPage();
}

function showDialog(title, content, eyebrow = 'WORKSPACE') {
  $('dialog-title').textContent = title;
  $('dialog-eyebrow').textContent = eyebrow;
  $('dialog-content').innerHTML = content;
  hydrateIcons();
  if (!$('editor-dialog').open) $('editor-dialog').showModal();
}
function closeDialog() { $('editor-dialog').close(); $('dialog-content').innerHTML = ''; setupWizard = null; }
const field = (name, label, value = '', options = {}) => `<div class="field${options.full ? ' full' : ''}"><label for="field-${name}">${esc(label)}</label>${options.multiline ? `<textarea id="field-${name}" name="${name}" ${options.rows ? `rows="${options.rows}"` : ''} ${options.required ? 'required' : ''} placeholder="${esc(options.placeholder || '')}" ${options.mono ? 'style="font-family:var(--mono);font-size:11px"' : ''}>${esc(value)}</textarea>` : `<input id="field-${name}" name="${name}" type="${options.type || 'text'}" value="${esc(value)}" placeholder="${esc(options.placeholder || '')}" ${options.required ? 'required' : ''} ${options.autocomplete ? `autocomplete="${options.autocomplete}"` : ''}>`}${options.help ? `<small>${esc(options.help)}</small>` : ''}</div>`;
const footer = (label) => `<div class="dialog-footer"><p id="form-error" class="form-error" role="alert"></p><button class="button quiet" type="button" data-action="close-dialog">Cancel</button><button class="button primary" type="submit">${esc(label)}</button></div>`;
function jsonField(form, name, fallback = {}) {
  const text = new FormData(form).get(name)?.trim();
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { throw new Error(`${name} must be valid JSON`); }
}

function bindForm(handler) {
  $('edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type=submit]');
    const original = submit.innerHTML;
    submit.disabled = true;
    $('form-error').textContent = '';
    try {
      await handler(form, Object.fromEntries(new FormData(form)));
    } catch (error) {
      if ($('form-error')) $('form-error').textContent = error.message;
    } finally { if (submit.isConnected) { submit.disabled = false; submit.innerHTML = original; } }
  });
}

function editProvider(provider = {}) {
  showDialog(provider.id ? 'Edit provider' : 'Bring your own provider', `<form id="edit-form"><div class="dialog-body"><p class="details-description">Add a custom endpoint. Both client API formats work through the same router.</p><div class="field-grid">${field('name', 'Provider name', provider.name, { required: true, placeholder: 'My provider' })}<div class="field"><label for="field-type">API format</label><select id="field-type" name="type"><option value="openai" ${provider.type !== 'anthropic' ? 'selected' : ''}>OpenAI-compatible</option><option value="anthropic" ${provider.type === 'anthropic' ? 'selected' : ''}>Anthropic Messages</option></select></div>${field('baseUrl', 'Base URL', provider.baseUrl, { required: true, type: 'url', full: true, placeholder: 'https://api.example.com/v1', help: 'Local HTTP endpoints work too. For other API roots, set an endpoint path below.' })}${field('defaultModel', 'Default model', provider.defaultModel, { required: true, full: true, placeholder: 'provider/model-id' })}${field('apiKey', 'Provider API key', '', { type: 'password', full: true, autocomplete: 'new-password', placeholder: provider.apiKey ? 'Leave blank to keep your saved key' : 'Optional for auth-less local models' })}</div><details><summary>Compatibility & custom headers</summary><div>${field('userAgent', 'User-Agent', provider.userAgent, { placeholder: 'Optional client User-Agent' })}${field('endpointPath', 'Endpoint path', provider.endpointPath, { placeholder: 'chat/completions', help: 'Optional. Appended directly to your base URL instead of the default /v1 path.' })}${field('headers', 'Custom headers (JSON)', JSON.stringify(provider.headers || {}, null, 2), { multiline: true, mono: true, rows: 4, help: 'Saved values are masked. Leave *** to preserve them.' })}<label class="check-label"><input type="checkbox" name="noReasoning" ${provider.compat?.noReasoningEffortWithTools ? 'checked' : ''}>Force reasoning_effort=none when calling tools</label></div></details></div>${footer(provider.id ? 'Save provider' : 'Add provider')}</form>`, 'LLM PROVIDER');
  bindForm(async (form, values) => {
    const body = { name: values.name.trim(), type: values.type, baseUrl: values.baseUrl.trim(), defaultModel: values.defaultModel.trim(),
      apiKey: values.apiKey.trim() || (provider.apiKey ? '***' : ''), userAgent: values.userAgent.trim(), endpointPath: values.endpointPath.trim(),
      headers: jsonField(form, 'headers'), compat: { noReasoningEffortWithTools: !!values.noReasoning } };
    await api(provider.id ? `/api/providers/${provider.id}` : '/api/providers', { method: provider.id ? 'PUT' : 'POST', body });
    closeDialog(); toast(provider.id ? 'Provider updated' : 'Provider added'); await loadWorkspace();
  });
}

function editSchedule(schedule = {}) {
  if (!STATE.providers.length) return toast('Add a provider before creating a schedule.', true);
  showDialog(schedule.id ? 'Edit routing window' : 'Route on your schedule', `<form id="edit-form"><div class="dialog-body"><div class="field"><label for="field-providerId">Provider</label><select id="field-providerId" name="providerId">${STATE.providers.map((provider) => `<option value="${provider.id}" ${schedule.providerId === provider.id ? 'selected' : ''}>${esc(provider.name)}</option>`).join('')}</select></div><div class="field-grid">${field('start', 'Start time', schedule.start || '01:30', { type: 'time', required: true })}${field('end', 'End time', schedule.end || '03:30', { type: 'time', required: true })}${field('label', 'Label', schedule.label, { full: true, placeholder: 'Overnight coding' })}${field('timezone', 'Timezone', schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, { full: true, required: true })}</div><div class="field"><label>Days (leave empty for every day)</label><div class="inline-row">${['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => `<label class="check-label"><input name="days" value="${day}" type="checkbox" ${schedule.days?.includes(day) ? 'checked' : ''}>${day}</label>`).join('')}</div></div><label class="check-label"><input name="fallback" type="checkbox" ${schedule.fallbackOnFailure ? 'checked' : ''}>Use the fallback chain if the scheduled provider fails</label><p class="subtle" style="font-size:10px;margin-top:12px">An end time before the start time wraps past midnight.</p></div>${footer('Save window')}</form>`, 'ROUTING');
  bindForm(async (form, values) => {
    try { new Intl.DateTimeFormat('en', { timeZone: values.timezone }); } catch { throw new Error('Enter a valid IANA timezone, such as Asia/Kolkata.'); }
    await api(schedule.id ? `/api/schedules/${schedule.id}` : '/api/schedules', { method: schedule.id ? 'PUT' : 'POST', body: {
      providerId: values.providerId, start: values.start, end: values.end, timezone: values.timezone, label: values.label, days: new FormData(form).getAll('days'), fallbackOnFailure: !!values.fallback,
    } });
    closeDialog(); toast('Routing window saved'); await loadWorkspace();
  });
}

function editMcp(server = {}) {
  showDialog(server.id ? 'Edit MCP server' : 'Connect an MCP server', `<form id="edit-form"><div class="dialog-body"><p class="details-description">Your gateway key authenticates clients. Backend headers are optional for auth-less MCPs.</p><div class="field-grid">${field('name', 'Server name', server.name, { required: true, placeholder: 'My search server' })}${field('slug', 'Namespace', server.slug, { placeholder: 'my-search', help: 'Used in names like my-search__query.' })}<div class="field full"><label for="field-transport">Transport</label><select id="field-transport" name="transport"><option value="http" ${server.transport === 'http' || !server.transport ? 'selected' : ''}>Streamable HTTP</option><option value="sse" ${server.transport === 'sse' ? 'selected' : ''}>Legacy SSE</option><option value="stdio" ${server.transport === 'stdio' ? 'selected' : ''}>Local stdio command</option></select></div></div><div id="mcp-remote">${field('url', 'MCP endpoint', server.url, { type: 'url', placeholder: 'http://host.docker.internal:8000/mcp', help: 'The gateway must be able to reach this address.' })}${field('headers', 'Backend headers (JSON)', JSON.stringify(server.headers || {}, null, 2), { multiline: true, mono: true, rows: 3, help: 'For example: {"Authorization":"Bearer …"}. Leave empty for an auth-less server.' })}</div><div id="mcp-stdio">${field('command', 'Executable', server.command, { placeholder: 'npx' })}${field('args', 'Arguments (JSON array)', JSON.stringify(server.args || [], null, 2), { multiline: true, mono: true, rows: 3, placeholder: '["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]' })}${field('cwd', 'Working directory', server.cwd, { placeholder: 'Optional directory on the gateway host' })}${field('env', 'Environment variables (JSON)', JSON.stringify(server.env || {}, null, 2), { multiline: true, mono: true, rows: 3, help: 'Only these values and the SDK’s safe environment are passed to the process.' })}<p class="subtle" style="font-size:10px;margin-bottom:18px">The command runs on the gateway host (inside the container when using Docker). It starts only when connected or discovered.</p></div>${field('timeoutMs', 'Request timeout (milliseconds)', server.timeoutMs || 30000, { type: 'number' })}</div>${footer(server.id ? 'Save server' : 'Add server')}</form>`, 'MCP GATEWAY');
  const updateTransport = () => { const stdio = $('field-transport').value === 'stdio'; $('mcp-remote').hidden = stdio; $('mcp-stdio').hidden = !stdio; };
  $('field-transport').addEventListener('change', updateTransport); updateTransport();
  bindForm(async (form, values) => {
    const body = { name: values.name.trim(), transport: values.transport, timeoutMs: Number(values.timeoutMs), ...(values.slug.trim() ? { slug: values.slug.trim() } : {}),
      ...(values.transport === 'stdio' ? { command: values.command.trim(), args: jsonField(form, 'args', []), env: jsonField(form, 'env'), cwd: values.cwd.trim() } : { url: values.url.trim(), headers: jsonField(form, 'headers') }) };
    await api(server.id ? `/api/mcp/servers/${server.id}` : '/api/mcp/servers', { method: server.id ? 'PUT' : 'POST', body });
    closeDialog(); toast(server.id ? 'MCP server updated' : 'MCP server added'); await loadWorkspace();
  });
}

function openIntegration(id, step = 0) {
  const entry = STATE.integrations.find((integration) => integration.id === id);
  if (!entry) throw new Error('Integration not found. Refresh your workspace.');
  setupWizard = { entry, step, method: entry.connectedServer?.authKind || entry.defaultMethod,
    values: { ...(entry.connectedServer?.setupValues || {}) }, serverId: entry.connectedServer?.id || null };
  renderIntegrationWizard();
}

function wizardSteps(step) {
  return `<ol class="wizard-steps" aria-label="Setup progress">${['Choose', 'Connect', 'Ready'].map((label, index) => `<li class="${index === step ? 'active' : index < step ? 'complete' : ''}" ${index === step ? 'aria-current="step"' : ''}><span>${index < step ? '✓' : index + 1}</span>${label}</li>`).join('')}</ol>`;
}

function methodLabel(method, entry) {
  return method === 'oauth' ? `Sign in to ${entry.name}` : method === 'token' ? 'Use an access token' : entry.kind === 'local' ? 'Use the included tool' : 'Start without a key';
}

function renderIntegrationWizard() {
  const wizard = setupWizard;
  if (!wizard) return;
  const { entry, method, step } = wizard;
  if (step === 0) {
    showDialog(`Set up ${entry.name}`, `<div class="dialog-body">${wizardSteps(0)}<div class="wizard-intro"><span class="entity-icon accent">${icon(entry.icon)}</span><div><h3>${esc(entry.name)}</h3><p>${esc(entry.description)}</p></div></div><div class="guide-note"><h3>What you’ll need</h3><p>${entry.kind === 'local' ? 'No account or software download. This tool is already included with Giga Router. We’ll turn it on and test it for you.' : entry.id === 'context7' ? 'You can start without an account. Add a free Context7 key later if you need higher limits.' : `An account with ${esc(entry.name)}. Your account’s permissions and usage limits apply.`}</p></div><div class="guide-note"><h3>How it works</h3><p>${entry.kind === 'local' ? 'It runs on the machine hosting Giga Router.' : 'We connect to the service for you.'} Your assistant keeps using its one Giga Router connection.</p></div><h3 class="guide-title">Try it with a prompt like this</h3><div class="code-block"><pre>${esc(entry.example)}</pre></div></div><div class="dialog-footer">${button('Cancel', 'close-dialog', '', 'quiet')}${button('Let’s get started', 'wizard-next', '', 'primary', 'arrow-right')}</div>`, 'STEP 1 OF 3 · CHOOSE YOUR TOOL');
    return;
  }
  const activeMethod = entry.methods.includes(method) ? method : entry.defaultMethod;
  let content = `<div class="dialog-body">${wizardSteps(1)}`;
  if (entry.methods.length > 1) content += `<label>How would you like to connect?</label><div class="method-options">${entry.methods.map((option) => `<button type="button" class="method-option ${activeMethod === option ? 'selected' : ''}" data-action="wizard-method" data-id="${option}">${icon(option === 'oauth' ? 'log-in' : option === 'token' ? 'key' : 'zap')}<span>${esc(methodLabel(option, entry))}${entry.defaultMethod === option ? '<small>Easy starting point</small>' : ''}</span>${activeMethod === option ? icon('check') : ''}</button>`).join('')}</div>`;
  const inputs = entry.fields.map((input) => {
    const value = wizard.values[input.name] ?? input.default ?? '';
    if (input.type === 'boolean') return `<div class="field"><label class="check-label"><input type="checkbox" name="${input.name}" ${value ? 'checked' : ''}>${esc(input.label)}</label><small>${esc(input.help)}</small></div>`;
    return field(input.name, input.label, value, { required: input.required, placeholder: input.placeholder, help: input.help });
  }).join('');
  content += `<form id="integration-form">${inputs}`;
  if (activeMethod === 'token') {
    const hasSavedToken = entry.connectedServer?.authKind === 'token' && entry.connectedServer.auth?.connected;
    content += `<div class="setup-instructions"><h3>Get your ${esc(entry.tokenLabel.toLowerCase())}</h3><p>A token is a key that lets this router connect to your account. You get it from the service, not from Giga Router.</p><ol>${entry.tokenSteps.map((instruction) => `<li>${esc(instruction)}</li>`).join('')}</ol><a class="button quiet" href="${esc(entry.tokenUrl)}" target="_blank" rel="noopener noreferrer">Open ${esc(entry.name)} token settings ${icon('external-link')}</a></div>${entry.tokenHelp ? `<p class="guide-note">${esc(entry.tokenHelp)}</p>` : ''}${field('token', entry.tokenLabel, '', { type: 'password', autocomplete: 'new-password', placeholder: hasSavedToken ? 'Leave blank to keep the saved token' : 'Paste your token here', required: !hasSavedToken })}`;
  } else if (activeMethod === 'oauth') {
    content += `<div class="setup-instructions"><h3>Sign in, approve, and come back</h3><ol><li>Click the Sign in button below.</li><li>A ${esc(entry.name)} sign-in page will open. Sign in and choose the account or workspace you want to connect.</li><li>Approve the access you want your assistant to have.</li><li>You’ll return here automatically. We’ll test the connection and show the available tools.</li></ol></div>`;
    if (!STATE.mcpSetup.oauthAvailable) content += `<div class="guide-note warning">${esc(STATE.mcpSetup.error || 'Browser sign-in needs an HTTPS router address.')} ${entry.methods.includes('token') ? 'Choose “Use an access token” above to continue without browser sign-in.' : ''}</div>`;
    if (entry.oauth?.requiresClient) content += `<details class="app-setup" ${!entry.connectedServer?.auth?.hasClient ? 'open' : ''}><summary>One-time GitHub app setup ${entry.connectedServer?.auth?.hasClient ? '· Saved' : ''}</summary><div><p class="details-description">GitHub asks self-hosted tools to register an app first. You only do this once. The access-token option above skips this setup.</p><ol class="guide-list">${entry.oauthSteps.map((instruction) => `<li>${esc(instruction)}</li>`).join('')}</ol><a class="button quiet" href="${entry.appUrl}" target="_blank" rel="noopener noreferrer">Create GitHub OAuth App ${icon('external-link')}</a><div class="copy-setting"><label>Homepage URL</label><code>${esc(STATE.mcpSetup.site || origin)}</code>${button('Copy', 'wizard-copy-home', '', 'small quiet', 'copy')}</div><div class="copy-setting"><label>Callback URL</label><code>${esc(STATE.mcpSetup.callbackUrl || 'Set an HTTPS router address first')}</code>${button('Copy', 'wizard-copy-callback', '', 'small quiet', 'copy')}</div>${field('clientId', 'GitHub Client ID', '', { placeholder: entry.connectedServer?.auth?.hasClient ? 'Leave blank to keep the saved app' : 'Paste the Client ID from your new app' })}${field('clientSecret', 'GitHub Client secret', '', { type: 'password', autocomplete: 'new-password', placeholder: 'Paste the Client secret for the app' })}</div></details>`;
  } else if (entry.kind === 'local') {
    content += `<div class="guide-note"><h3>No installation steps to figure out</h3><p>This ${esc(entry.name.toLowerCase())} tool is already packaged with Giga Router. Click Set up & test to activate it.</p>${entry.id === 'files' ? '<p>With the easy shared folder, the next screen lets you upload documents directly. Your assistant can then find and use those files.</p>' : ''}</div>`;
  } else content += `<div class="guide-note"><p>No key needed to begin. Click Connect & test and we’ll check the service for you.</p></div>`;
  content += `</form><p id="wizard-error" class="form-error" role="alert">${esc(wizard.error || '')}</p><a class="guide-docs" href="${entry.docs}" target="_blank" rel="noopener noreferrer">Official ${esc(entry.name)} help ${icon('external-link')}</a></div><div class="dialog-footer">${button('Back', 'wizard-back', '', 'quiet', 'arrow-left')}${button(activeMethod === 'oauth' ? `Sign in to ${entry.name}` : entry.kind === 'local' ? 'Set up & test' : 'Connect & test', 'wizard-connect', '', 'primary', activeMethod === 'oauth' ? 'log-in' : 'zap')}</div>`;
  showDialog(`Connect ${entry.name}`, content, 'STEP 2 OF 3 · CONNECT YOUR ACCOUNT');
  $('integration-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const connect = $('editor-dialog').querySelector('[data-action="wizard-connect"]');
    if (connect && !connect.disabled) connect.click();
  });
  if (activeMethod === 'oauth' && !STATE.mcpSetup.oauthAvailable) $('editor-dialog').querySelector('[data-action="wizard-connect"]').disabled = true;
}

function rememberWizardValues() {
  if (!setupWizard || !$('integration-form')) return;
  const values = Object.fromEntries(new FormData($('integration-form')));
  for (const input of setupWizard.entry.fields) setupWizard.values[input.name] = input.type === 'boolean' ? !!values[input.name] : values[input.name]?.trim() || '';
}

async function connectWizard(node) {
  if (!setupWizard) return;
  const wizard = setupWizard;
  const form = $('integration-form');
  if (!form.reportValidity()) return;
  rememberWizardValues();
  const values = Object.fromEntries(new FormData(form));
  $('wizard-error').textContent = '';
  node.textContent = wizard.method === 'oauth' ? 'Preparing sign-in…' : 'Testing your connection…';
  try {
    const result = await api(`/api/mcp/catalog/${wizard.entry.id}/connect`, { method: 'POST', body: { method: wizard.method, values: wizard.values, ...(values.token?.trim() ? { token: values.token.trim() } : {}) } });
    wizard.serverId = result.server.id;
    await loadWorkspace(false);
    if (result.next === 'sign_in') {
      const signIn = await api(`/api/mcp/servers/${result.server.id}/oauth/start`, { method: 'POST', body: values.clientId?.trim() ? { clientId: values.clientId.trim(), clientSecret: values.clientSecret?.trim() || '' } : {} });
      location.assign(signIn.authorizationUrl);
    } else if (result.next === 'ready') showConnectionReady(result.server, result.discovery);
    else { wizard.error = result.message; setupWizard = wizard; renderIntegrationWizard(); }
  } catch (error) { if ($('wizard-error')) $('wizard-error').textContent = error.message; }
}

function showConnectionReady(server, discovery = {}) {
  const entry = STATE.integrations.find((integration) => integration.id === server.integrationId);
  setupWizard = null;
  showDialog(`${server.name} is connected`, `<div class="dialog-body">${wizardSteps(2)}<div class="connection-success">${icon('check-circle')}<h3>Connected to your router.</h3><p>${discovery.tools ?? server.health?.tools ?? 0} tools were found. Connect your assistant below if you haven’t done that yet.</p></div><div class="guide-note"><h3>Next: connect your assistant</h3><p>You only do this once. We’ll show you where to paste the Giga Router connection settings. If your assistant already uses Giga Router, skip to the example prompt.</p>${button('Show connection steps', 'assistant-guide', '', 'primary', 'arrow-right')}</div>${server.sharedFolder ? `<div class="guide-note"><h3>Add your first document</h3><p>Upload files into the shared folder. They live on this router and are available to your assistant.</p>${button('Open shared files', 'shared-files', server.id, 'quiet', 'upload')}</div>` : ''}<h3 class="guide-title">Then try this with your assistant</h3><div class="code-block"><pre>${esc(entry?.example || `Use ${server.name} to list the available information.`)}</pre></div>${button('Copy example prompt', 'copy-integration-prompt', server.integrationId, 'quiet', 'copy')}</div><div class="dialog-footer">${button('Done', 'finish-integration', '', 'primary', 'check')}</div>`, 'STEP 3 OF 3 · READY');
}

function assistantGuide(client = 'claude-code') {
  const choices = [['claude-code', 'Claude Code'], ['cursor', 'Cursor'], ['vscode', 'VS Code'], ['opencode', 'OpenCode']];
  const endpoint = `${origin}/mcp`;
  const placeholder = 'YOUR_GIGA_ROUTER_KEY';
  let instructions, code;
  if (client === 'claude-code') {
    instructions = ['Open a terminal in the project where you use Claude Code.', 'Copy the command below. Replace YOUR_GIGA_ROUTER_KEY with the key copied from Access & endpoints, then run the command.', 'Start Claude Code. Use /mcp to check that Giga Router is connected.', 'Try an example prompt from your integration’s setup guide.'];
    code = `claude mcp add --transport http giga-router "${endpoint}" --header "Authorization: Bearer ${placeholder}"`;
  } else if (client === 'cursor') {
    instructions = ['Open Cursor Settings → Tools & MCP (or MCP), then choose Add custom MCP.', 'Paste the configuration below into the MCP configuration file that opens. If it already contains servers, add just the giga-router entry inside mcpServers.', 'Replace YOUR_GIGA_ROUTER_KEY with your key from Access & endpoints and save.', 'Enable Giga Router in Cursor’s MCP list. Start a chat and try the integration’s example prompt.'];
    code = JSON.stringify({ mcpServers: { 'giga-router': { url: endpoint, headers: { Authorization: `Bearer ${placeholder}` } } } }, null, 2);
  } else if (client === 'vscode') {
    instructions = ['Open VS Code and press Ctrl+Shift+P (Cmd+Shift+P on Mac). Search for “MCP: Open User Configuration”.', 'Paste the configuration below. If it already has servers, add giga-router inside servers.', 'Replace YOUR_GIGA_ROUTER_KEY with your key from Access & endpoints and save.', 'Run “MCP: List Servers”, select Giga Router, and start it. Try the integration in an agent chat.'];
    code = JSON.stringify({ servers: { 'giga-router': { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${placeholder}` } } } }, null, 2);
  } else {
    instructions = ['Find the project folder where you use OpenCode. Open that folder in your editor or file manager.', 'If there is no opencode.json in that folder, create a plain text file with that exact name. Paste the complete configuration below into it.', 'If opencode.json already exists, keep its other settings. Expand “Updating an existing file” below and copy only the giga-router entry into its mcp object.', 'Replace YOUR_GIGA_ROUTER_KEY with the key copied from Access & endpoints. Save the file, then open OpenCode from this same project folder.', 'Run “opencode mcp list” in a terminal in that project folder. Find giga-router and confirm it is connected. Then open a new chat and try your integration’s example prompt.'];
    code = JSON.stringify({ mcp: { 'giga-router': { type: 'remote', url: endpoint, enabled: true, oauth: false, headers: { Authorization: `Bearer ${placeholder}` } } } }, null, 2);
  }
  const fullConfig = client !== 'claude-code' && JSON.parse(code);
  const objectKey = client === 'opencode' ? 'mcp' : client === 'vscode' ? 'servers' : 'mcpServers';
  const entryCode = fullConfig ? JSON.stringify(fullConfig[objectKey]['giga-router'], null, 2) : '';
  const insert = fullConfig ? `"giga-router": ${entryCode}` : '';
  showDialog('Connect your assistant once', `<div class="dialog-body"><p class="details-description">Your apps are connected to this router. Now add Giga Router to the assistant you use. You won’t need to add each app separately.</p><label for="assistant-choice">Which assistant do you use?</label><select id="assistant-choice">${choices.map(([value, label]) => `<option value="${value}" ${value === client ? 'selected' : ''}>${label}</option>`).join('')}</select><ol class="guide-list section-space">${instructions.map((step) => `<li>${esc(step)}</li>`).join('')}</ol><h3 class="guide-title">${fullConfig ? 'For a new or empty configuration file' : 'Command to run in your terminal'}</h3><div class="code-block"><pre id="assistant-config">${esc(code)}</pre></div><div class="button-row">${button('Copy configuration', 'copy-assistant-config', '', 'primary', 'copy')}${button('Copy router key', 'copy-router-key', '', 'quiet', 'key')}</div>${fullConfig ? `<details class="section-space"><summary>Updating an existing file</summary><div><p class="details-description">Inside <code>"${objectKey}": { … }</code>, add just the entry below. Do not add another ${objectKey} object inside it. If there is already another server, put a comma after that server’s closing brace before adding this entry. Keep the outer braces and all your other settings.</p><div class="code-block"><pre id="assistant-entry">${esc(insert)}</pre></div>${button('Copy only the server entry', 'copy-assistant-entry', '', 'quiet', 'copy')}<p class="guide-note">For an existing file with no <code>${objectKey}</code> object, add <code>"${objectKey}": { … }</code> at the top level and place this entry inside it. Your editor should report no JSON syntax errors before you save.</p></div></details>` : ''}<p class="guide-note">The router key is copied separately so your key isn’t printed in the guide. If you share this setup, create a scoped key in Access & endpoints. Keep its connection URL reachable from your assistant’s machine.</p></div><div class="dialog-footer">${button('Done', 'close-dialog', '', 'primary')}</div>`, 'ONE CONNECTION FOR ALL YOUR TOOLS');
  $('assistant-choice').addEventListener('change', (event) => assistantGuide(event.target.value));
}

async function sharedFiles(id) {
  const result = await api(`/api/mcp/servers/${id}/files`);
  showDialog('Your shared files', `<div class="dialog-body"><p class="details-description">Upload a document here, then ask your assistant to read it using Files. It is stored on this router, not in a third-party service.</p><div class="field"><label for="shared-upload">Choose files to upload (up to 8 MB each)</label><input id="shared-upload" type="file" multiple></div><p id="upload-status" class="subtle"></p><div class="panel section-space">${result.items.length ? result.items.map((item) => `<div class="setting-row"><h3>${esc(item.name)}</h3><span class="subtle">${Math.ceil(item.size / 1024)} KB</span></div>`).join('') : '<div class="panel-body subtle">No files yet. Choose your first document above.</div>'}</div><p class="guide-note">Folder on this router: <code>${esc(result.folder)}</code></p></div><div class="dialog-footer">${button('Done', 'close-dialog', '', 'primary')}</div>`, 'FILES YOUR ASSISTANT CAN USE');
  $('shared-upload').addEventListener('change', async (event) => {
    event.target.disabled = true;
    try {
      for (const file of event.target.files) {
        if (file.size > 8 * 1024 * 1024) throw new Error(`${file.name} is larger than 8 MB.`);
        $('upload-status').textContent = `Uploading ${file.name}…`;
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
        await api(`/api/mcp/servers/${id}/files`, { method: 'POST', body: { name: file.name, data } });
      }
      toast('Files uploaded. Your assistant can read them now.'); await sharedFiles(id);
    } catch (error) { toast(error.message, true); event.target.disabled = false; }
  });
}

async function editSkill(id) {
  const skill = id ? await api(`/api/skills/${id}`) : {};
  showDialog(id ? 'Edit your skill' : 'Create a reusable skill', `<form id="edit-form"><div class="dialog-body"><p class="details-description">Write instructions once, then copy them into any chat or load them through MCP. Paste a complete SKILL.md or plain instructions.</p>${field('name', 'Skill name', skill.name, { required: true, placeholder: 'code-review' })}${field('description', 'Description', skill.description, { placeholder: 'When to use this skill' })}${field('content', 'Instructions / SKILL.md', skill.content, { required: true, multiline: true, mono: true, rows: 14, placeholder: 'You are reviewing a code change. Start by…' })}${skill.sourceId ? `<p class="subtle" style="font-size:10px">This creates a local edit. Updating from the marketplace replaces it with the repository version.</p>` : ''}</div>${footer(id ? 'Save changes' : 'Create skill')}</form>`, 'SKILL LIBRARY');
  bindForm(async (form, values) => {
    await api(id ? `/api/skills/${id}` : '/api/skills', { method: id ? 'PUT' : 'POST', body: { name: values.name.trim(), description: values.description.trim(), content: values.content } });
    previews.delete(id); closeDialog(); toast(id ? 'Skill updated' : 'Skill saved. Ready to copy into chat.'); await loadWorkspace();
  });
}

function addSource(repo = '') {
  showDialog('Turn a repository into a marketplace', `<form id="edit-form"><div class="dialog-body"><p class="details-description">Giga Router finds SKILL.md files, reads their descriptions, and gives you a searchable catalog. Add a repo or a link to one of its directories.</p>${field('url', 'GitHub URL or owner/repo', repo, { required: true, placeholder: 'https://github.com/obra/superpowers', help: 'Repository, /tree/branch/directory, and /blob/branch/SKILL.md links work.' })}<details><summary>Branch, directory, and display name</summary><div>${field('ref', 'Branch or commit', '', { placeholder: 'Default repository branch' })}${field('path', 'Directory inside repository', '', { placeholder: 'skills' })}${field('name', 'Display name', '', { placeholder: 'Optional source name' })}</div></details><div class="info-strip">${icon('github')}<p>The index is saved locally. Refresh a source when you want new skills. GITHUB_TOKEN on the server enables private repos and a higher GitHub API limit.</p></div></div>${footer('Index repository')}</form>`, 'MARKETPLACE SOURCE');
  bindForm(async (form, values) => {
    const submit = form.querySelector('button[type=submit]');
    submit.textContent = 'Indexing repository…';
    const result = await api('/api/sources', { method: 'POST', body: { url: values.url, ...(values.ref.trim() ? { ref: values.ref.trim() } : {}), ...(values.path.trim() ? { path: values.path.trim() } : {}), ...(values.name.trim() ? { name: values.name.trim() } : {}) } });
    closeDialog(); toast(`Indexed ${result.count} skills from ${result.name}`);
    if (result.warnings?.length) toast(`${result.warnings.length} files could not be indexed. ${result.warnings[0]}`, true);
    STATE.marketTab = 'browse'; STATE.sourceFilter = result.id; STATE.search = '';
    if (STATE.page !== 'marketplace') location.hash = 'marketplace';
    await loadWorkspace();
  });
}

function addKey() {
  showDialog('Create an access key', `<form id="edit-form"><div class="dialog-body">${field('name', 'Key name', '', { required: true, placeholder: 'My coding agent' })}<div class="field"><label>Allowed APIs</label><label class="check-label"><input name="llm" type="checkbox" checked>LLM routing</label><label class="check-label"><input name="mcp" type="checkbox" checked>MCP gateway and installed skills</label></div><label class="check-label"><input id="all-servers" name="allServers" type="checkbox" checked>Allow all enabled MCP servers</label><div id="key-servers" hidden>${STATE.servers.map((server) => `<label class="check-label"><input name="serverIds" type="checkbox" value="${server.id}">${esc(server.name)}</label>`).join('') || '<p class="subtle">No MCP servers added yet.</p>'}</div><p class="subtle" style="font-size:11px;margin-top:18px">The key is shown once. Copy it before closing the next screen.</p></div>${footer('Create key')}</form>`, 'UNIFIED AUTHENTICATION');
  $('all-servers').addEventListener('change', () => { $('key-servers').hidden = $('all-servers').checked; });
  bindForm(async (form, values) => {
    const scopes = [values.llm ? 'llm' : '', values.mcp ? 'mcp' : ''].filter(Boolean);
    if (!scopes.length) throw new Error('Select at least one API.');
    const key = await api('/api/access/keys', { method: 'POST', body: { name: values.name.trim(), scopes, serverIds: values.allServers ? null : new FormData(form).getAll('serverIds') } });
    showDialog('Your key is ready', `<div class="dialog-body"><p class="details-description">Save this key now. It will not be shown again.</p><div class="code-block"><pre id="new-key">${esc(key.key)}</pre></div>${tag(key.scopes.join(' + '), 'green')}</div><div class="dialog-footer">${button('Copy key', 'copy-new-key', '', 'primary', 'copy')}${button('Done', 'close-dialog', '', 'quiet')}</div>`, 'ACCESS KEY CREATED');
    await loadWorkspace();
  });
}

function marketSkill(key) { return STATE.marketplace.find((skill) => skillKey(skill) === key); }
async function getPreview(id, marketplace) {
  const entry = marketplace ? marketSkill(id) : STATE.skills.find((skill) => skill.id === id);
  if (!entry) throw new Error('Skill not found. Refresh your workspace.');
  const cacheKey = `${id}:${entry.bundleHash || entry.sha || entry.updatedAt}:${entry.installedId || ''}:${!!entry.updateAvailable}`;
  if (!previews.has(cacheKey)) {
    const endpoint = marketplace ? `/api/marketplace/${entry.sourceId}/preview?path=${encodeURIComponent(entry.path)}` : `/api/skills/${id}`;
    const promise = api(endpoint).catch((error) => { previews.delete(cacheKey); throw error; });
    previews.set(cacheKey, promise);
  }
  return previews.get(cacheKey);
}

async function previewSkill(id, marketplace = false) {
  showDialog('Loading skill…', '<div class="loading-state">Reading instructions…</div>', marketplace ? 'MARKETPLACE PREVIEW' : 'SKILL LIBRARY');
  let skill;
  try { skill = await getPreview(id, marketplace); }
  catch (error) { closeDialog(); throw error; }
  const installedId = marketplace ? skill.installedId : skill.id;
  showDialog(skill.name, `<div class="dialog-body"><div class="preview-meta">${tag(skill.sourceName || 'Personal')}${tag(skill.license || 'License unspecified')}${skill.commit ? tag(skill.commit.slice(0, 8)) : ''}${installedId ? tag('Installed', 'green') : ''}</div><p class="details-description" style="margin-bottom:0">${esc(skill.description)}</p>${skill.sourceUrl ? `<a class="source-chip" style="margin-top:14px" href="${esc(skill.sourceUrl)}" target="_blank" rel="noopener noreferrer">${icon('github')}View original on GitHub ${icon('arrow-up-right')}</a>` : ''}<pre class="preview-text">${esc(skill.text)}</pre>${skill.files ? `<div class="preview-files">Bundle files: ${skill.files.map((file) => esc(file.path)).join(' · ')}</div>` : ''}</div><div class="dialog-footer">${button('Copy for chat', marketplace ? 'copy-market' : 'copy-skill', id, 'primary', 'copy')}${button('Copy SKILL.md', marketplace ? 'copy-market-raw' : 'copy-raw', id, 'quiet', 'file-text')}${marketplace && (!installedId || skill.updateAvailable) ? button(skill.updateAvailable ? 'Update skill' : 'Install skill', 'install-market', id, 'quiet', 'download') : ''}${installedId ? `<a class="button quiet" href="/api/skills/${installedId}/download">${icon('download')}Download</a>${iconButton('Delete installed skill', 'delete-skill', installedId, 'trash-2')}` : ''}</div>`, marketplace ? 'MARKETPLACE PREVIEW' : 'SKILL LIBRARY');
}

async function copyText(text) {
  if (typeof text !== 'string' || !text) throw new Error('There is no text to copy.');
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch { /* HTTP or restricted browsers use the selection fallback below. */ }
  const previousFocus = document.activeElement;
  const area = document.createElement('textarea');
  area.value = text;
  area.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;';
  // A modal makes the rest of the document inert. Clipboard fallback must live
  // inside the modal when one is open, otherwise select() silently fails.
  ($('editor-dialog').open ? $('editor-dialog') : document.body).append(area);
  area.focus(); area.select(); area.setSelectionRange(0, area.value.length);
  const copied = document.execCommand('copy');
  area.remove(); previousFocus?.focus();
  if (!copied) throw new Error('Clipboard access was blocked. Open the preview and select the instructions to copy manually.');
}

async function copySkill(id, marketplace = false, raw = false) {
  const preview = await getPreview(id, marketplace);
  await copyText(raw ? preview.content : preview.text);
  toast(raw ? 'SKILL.md copied' : 'Skill copied. Paste it into your chat.');
}

function confirmAction(title, description, handler) {
  showDialog(title, `<div class="dialog-body"><p class="details-description">${esc(description)}</p></div><form id="edit-form"><div class="dialog-footer"><p id="form-error" class="form-error" role="alert"></p>${button('Cancel', 'close-dialog', '', 'quiet')}<button class="button danger" type="submit">Confirm</button></div></form>`, 'CONFIRM CHANGE');
  bindForm(async () => { await handler(); closeDialog(); await loadWorkspace(); });
}

async function installMarket(id) {
  const skill = marketSkill(id);
  if (!skill) throw new Error('Skill is no longer in this catalog. Refresh the source.');
  const run = async () => {
    await api(`/api/marketplace/${skill.sourceId}/install`, { method: 'POST', body: { path: skill.path } });
    toast(skill.installedId ? 'Skill updated from GitHub' : 'Skill installed. Ready to copy or load over MCP.');
  };
  const installed = skill.installedId && STATE.skills.find((entry) => entry.id === skill.installedId);
  if (installed?.locallyEdited) return confirmAction('Replace your local edits?', 'This skill has local edits. Updating installs the repository version in their place.', run);
  await run(); if ($('editor-dialog').open) closeDialog(); await loadWorkspace();
}

async function handleAction(node) {
  const { action, id } = node.dataset;
  const provider = STATE.providers.find((entry) => entry.id === id);
  const server = STATE.servers.find((entry) => entry.id === id);
  const skill = STATE.skills.find((entry) => entry.id === id);
  switch (action) {
    case 'add-provider': return editProvider();
    case 'edit-provider': return editProvider(provider);
    case 'use-provider': await api('/api/active', { method: 'POST', body: { id } }); toast('Active provider changed'); return loadWorkspace();
    case 'toggle-provider': await api(`/api/providers/${id}`, { method: 'PUT', body: { enabled: provider.enabled === false } }); return loadWorkspace();
    case 'delete-provider': return confirmAction(`Delete ${provider.name}?`, 'The provider and its routing windows will be removed.', () => api(`/api/providers/${id}`, { method: 'DELETE' }));
    case 'copy-alias': await copyText(`${provider.slug}/${provider.defaultModel}`); return toast('Model alias copied');
    case 'provider-tab': STATE.providerTab = id; return renderPage();
    case 'routing-tab': STATE.providerTab = 'routing'; return;
    case 'set-mode': await api('/api/routing', { method: 'POST', body: { mode: id } }); return loadWorkspace();
    case 'reset-health': await api('/api/health/reset', { method: 'POST' }); toast('Provider cooldowns cleared'); return loadWorkspace();
    case 'move-provider': {
      const list = orderedProviders(); const from = list.findIndex((entry) => entry.id === id); const to = from + Number(node.dataset.direction);
      if (to < 0 || to >= list.length) return;
      [list[from], list[to]] = [list[to], list[from]];
      await api('/api/routing', { method: 'POST', body: { autoOrder: list.map((entry) => entry.id) } }); return loadWorkspace();
    }
    case 'add-schedule': return editSchedule();
    case 'edit-schedule': return editSchedule(STATE.routing.schedules.find((entry) => entry.id === id));
    case 'delete-schedule': return confirmAction('Remove this routing window?', 'Normal routing will apply during this time.', () => api(`/api/schedules/${id}`, { method: 'DELETE' }));
    case 'add-mcp': return editMcp();
    case 'mcp-tab': STATE.mcpTab = id; return renderPage();
    case 'setup-integration': return openIntegration(id);
    case 'wizard-next': setupWizard.step = 1; return renderIntegrationWizard();
    case 'wizard-back': rememberWizardValues(); setupWizard.step = 0; return renderIntegrationWizard();
    case 'wizard-method': rememberWizardValues(); setupWizard.method = id; return renderIntegrationWizard();
    case 'wizard-connect': return connectWizard(node);
    case 'wizard-copy-home': await copyText(STATE.mcpSetup.site || origin); return toast('Homepage address copied');
    case 'wizard-copy-callback': await copyText(STATE.mcpSetup.callbackUrl); return toast('Callback address copied');
    case 'finish-integration': closeDialog(); STATE.mcpTab = 'connections'; return loadWorkspace();
    case 'assistant-guide': return assistantGuide();
    case 'copy-assistant-config': await copyText($('assistant-config').textContent); return toast('Configuration copied. Replace the placeholder with your router key.');
    case 'copy-assistant-entry': await copyText($('assistant-entry').textContent); return toast('Server entry copied. Add it inside your existing servers section.');
    case 'copy-integration-prompt': await copyText(STATE.integrations.find((entry) => entry.id === id)?.example); return toast('Example prompt copied');
    case 'shared-files': return sharedFiles(id);
    case 'check-mcp': {
      const result = await api(`/api/mcp/servers/${id}/check`, { method: 'POST' });
      await loadWorkspace(); return showConnectionReady(result.server, result.discovery);
    }
    case 'disconnect-mcp': return confirmAction(`Disconnect ${server.name}?`, 'Your settings stay here for reconnecting. This router will stop using your account or tool.', async () => { const result = await api(`/api/mcp/servers/${id}/disconnect`, { method: 'POST' }); toast(result.note); });
    case 'edit-mcp': return editMcp(server);
    case 'toggle-mcp': await api(`/api/mcp/servers/${id}`, { method: 'PUT', body: { enabled: server.enabled === false } }); return loadWorkspace();
    case 'delete-mcp': return confirmAction(`Remove ${server.name}?`, 'Clients will lose access to this server’s tools through the gateway.', () => api(`/api/mcp/servers/${id}`, { method: 'DELETE' }));
    case 'discover-mcp': {
      const result = await api(`/api/mcp/servers/${id}/discover`, { method: 'POST' });
      toast(`${result.tools} tools discovered`); await loadWorkspace();
      showDialog(`${server.name} tools`, `<div class="dialog-body">${result.items.length ? result.items.map((tool) => `<div class="field"><h3><code>${esc(tool.name)}</code></h3><p class="subtle" style="font-size:11px;margin-top:8px">${esc(tool.description || 'No description')}</p></div>`).join('') : '<p class="subtle">This server does not advertise tools.</p>'}</div><div class="dialog-footer">${button('Done', 'close-dialog', '', 'primary')}</div>`, 'MCP DISCOVERY'); return;
    }
    case 'copy-mcp-url': await copyText(origin + '/mcp'); return toast('MCP endpoint copied');
    case 'add-skill': return editSkill();
    case 'edit-skill': return editSkill(id);
    case 'preview-skill': return previewSkill(id);
    case 'copy-skill': return copySkill(id);
    case 'copy-raw': return copySkill(id, false, true);
    case 'toggle-skill': await api(`/api/skills/${id}`, { method: 'PUT', body: { enabled: skill.enabled === false } }); return loadWorkspace();
    case 'delete-skill': return confirmAction(`Remove ${skill.name}?`, 'The installed bundle will be removed. Repository skills can be installed again from the marketplace.', () => api(`/api/skills/${id}`, { method: 'DELETE' }));
    case 'preview-market': return previewSkill(id, true);
    case 'copy-market': return copySkill(id, true);
    case 'copy-market-raw': return copySkill(id, true, true);
    case 'install-market': return installMarket(id);
    case 'view-installed': return previewSkill(marketSkill(id).installedId);
    case 'add-source': return addSource();
    case 'restore-defaults': {
      const result = await api('/api/sources/restore-defaults', { method: 'POST' });
      toast(`Restored ${result.added + result.repaired} built-in sources`); return loadWorkspace();
    }
    case 'market-tab': STATE.marketTab = id; return renderPage();
    case 'browse-source': STATE.marketTab = 'browse'; STATE.sourceFilter = id; STATE.search = ''; return renderPage();
    case 'refresh-source': {
      toast('Refreshing repository…'); const result = await api(`/api/sources/${id}/refresh`, { method: 'POST' }); previews.clear(); toast(`Refreshed ${result.count} skills`); return loadWorkspace();
    }
    case 'delete-source': return confirmAction('Remove this repository?', 'It disappears from the marketplace. Your installed skills stay in your library.', () => api(`/api/sources/${id}`, { method: 'DELETE' }));
    case 'show-more': STATE.limit += 60; return renderSkillResults();
    case 'clear-filters': STATE.search = ''; STATE.sourceFilter = ''; STATE.marketFilter = ''; STATE.limit = 60; return renderPage();
    case 'add-key': return addKey();
    case 'revoke-key': return confirmAction('Revoke this key?', 'Clients using this key will no longer be able to make LLM or MCP requests.', () => api(`/api/access/keys/${id}`, { method: 'DELETE' }));
    case 'copy-router-key': await copyText((await api('/api/access/router-key')).key); return toast('Router key copied');
    case 'copy-new-key': await copyText($('new-key').textContent); return toast('Access key copied');
    case 'copy-snippet': await copyText(connectionSnippets()[id]); return toast('Connection configuration copied');
    case 'copy-endpoint': await copyText(id === 'openai-url' ? origin + '/v1' : id === 'mcp-url' ? origin + '/mcp' : origin); return toast('Endpoint copied');
    case 'close-dialog': return closeDialog();
    case 'logout': await api('/api/logout', { method: 'POST' }); showLogin(); previews.clear(); return;
  }
}

document.addEventListener('click', async (event) => {
  const node = event.target.closest('[data-action]');
  if (!node || node.disabled) return;
  if (node.tagName === 'BUTTON') event.preventDefault();
  const original = node.innerHTML;
  if (node.tagName === 'BUTTON') node.disabled = true;
  try { await handleAction(node); }
  catch (error) { toast(error.message, true); }
  finally { if (node.isConnected && node.tagName === 'BUTTON') { node.disabled = false; node.innerHTML = original; hydrateIcons(); } }
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'skill-search') { STATE.search = event.target.value; STATE.limit = 60; renderSkillResults(); }
  if (event.target.id === 'integration-search') { STATE.integrationSearch = event.target.value; renderIntegrationResults(); }
});
document.addEventListener('change', (event) => {
  if (event.target.id === 'source-filter') { STATE.sourceFilter = event.target.value; STATE.limit = 60; renderSkillResults(); }
  if (event.target.id === 'market-filter') { STATE.marketFilter = event.target.value; STATE.limit = 60; renderSkillResults(); }
  if (event.target.id === 'integration-category') { STATE.integrationCategory = event.target.value; renderIntegrationResults(); }
});
$('dialog-close').addEventListener('click', closeDialog);
$('editor-dialog').addEventListener('click', (event) => {
  if (event.target === $('editor-dialog')) { const rect = $('editor-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(); }
});
async function handleOauthReturn() {
  if (!oauthReturn || window.__oauthReturnHandled) return;
  window.__oauthReturnHandled = true;
  history.replaceState(null, '', '/#mcp');
  STATE.page = 'mcp'; STATE.mcpTab = 'connections'; renderPage();
  showDialog('Finishing your connection', '<div class="loading-state">Signed in. Testing your connection and finding tools…</div>', 'STEP 3 OF 3 · CONNECTION TEST');
  try {
    const result = await api(`/api/mcp/servers/${encodeURIComponent(oauthReturn)}/check`, { method: 'POST' });
    await loadWorkspace(false); showConnectionReady(result.server, result.discovery);
  } catch (error) {
    closeDialog(); await loadWorkspace();
    const server = STATE.servers.find((entry) => entry.id === oauthReturn);
    if (server?.integrationId) { openIntegration(server.integrationId, 1); $('wizard-error').textContent = error.message; }
    else toast(error.message, true);
  }
}
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('button');
  submit.disabled = true; $('login-error').textContent = '';
  try { await api('/api/login', { method: 'POST', body: { user: $('login-user').value, password: $('login-password').value } }); await loadWorkspace(); $('login-password').value = ''; await handleOauthReturn(); }
  catch (error) { $('login-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
$('logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); showLogin(); previews.clear(); } catch (error) { toast(error.message, true); }
});
$('refresh').addEventListener('click', () => { previews.clear(); loadWorkspace().then(() => toast('Workspace refreshed')).catch((error) => toast(error.message, true)); });
window.addEventListener('hashchange', navigate);
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) && !$('editor-dialog').open && $('skill-search')) { event.preventDefault(); $('skill-search').focus(); }
});
// Prefetch previews on intent so copying is responsive and more likely to retain
// the clipboard user gesture even on restrictive browsers.
document.addEventListener('pointerover', (event) => {
  const node = event.target.closest('[data-action="copy-skill"], [data-action="copy-market"]');
  if (node) getPreview(node.dataset.id, node.dataset.action === 'copy-market').catch(() => {});
});
hydrateIcons(); navigate();
loadWorkspace().then(handleOauthReturn).catch((error) => { if (error.message !== 'Sign in to continue') $('login-error').textContent = error.message; });
// Retain the original router's live routing refresh without repeatedly loading
// the marketplace or interrupting forms and skill searches.
let polling = false;
setInterval(async () => {
  if (!authenticated || document.hidden || loading || polling || $('editor-dialog').open || !['overview', 'providers', 'mcp'].includes(STATE.page)) return;
  polling = true;
  try {
    const [routing, overview, servers] = await Promise.all([api('/api/routing'), api('/api/overview'), api('/api/mcp/servers')]);
    STATE.routing = routing; STATE.overview = overview; STATE.servers = servers.items; STATE.mcpSessions = servers.sessions;
    document.querySelector('.gateway-status').innerHTML = '<span class="status-dot"></span>Gateway online';
    if (!$('editor-dialog').open) renderPage();
  } catch (error) {
    document.querySelector('.gateway-status').textContent = 'Connection lost';
  } finally { polling = false; }
}, 15000);
