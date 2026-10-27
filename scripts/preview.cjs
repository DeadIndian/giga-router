// Disposable, loopback-only workspace.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-preview-'));
process.env.DATA_DIR = data;
process.env.user = 'preview'; process.env.password = 'preview-password'; process.env.ROUTER_KEY = 'preview-key';
const { app, closeAllMcp } = require('../server');
require('../lib/marketplace-defaults').seedDefaultMarketplaces();
const server = app.listen(0, '127.0.0.1', () => console.log(`Preview: http://127.0.0.1:${server.address().port}\nSign in: preview / preview-password\nTemporary data: ${data}`));
async function stop() { await closeAllMcp(); server.closeAllConnections(); server.close(() => { fs.rmSync(data, { recursive: true, force: true }); process.exit(0); }); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
