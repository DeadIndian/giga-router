// Local, credential-free fixture for exercising the real stdio SDK transport.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const types = require('@modelcontextprotocol/sdk/types.js');
const server = new Server({ name: 'stdio-fixture', version: '1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(types.ListToolsRequestSchema, () => ({ tools: [{ name: 'echo', description: 'Test stdio round trip', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }));
server.setRequestHandler(types.CallToolRequestSchema, (request) => ({ content: [{ type: 'text', text: `${request.params.arguments.text}:${process.env.FIXTURE_VALUE || 'missing'}:${process.env.ROUTER_KEY ? 'leaked' : 'isolated'}` }] }));
server.connect(new StdioServerTransport()).catch(() => process.exit(1));
