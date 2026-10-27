// Rewrite only protocol-defined URI fields, never opaque text or structuredContent.
const wrapUri = (slug, uri) => `giga://${slug}/${uri}`;
function content(block, slug) {
  if (block.type === 'resource_link') return { ...block, uri: wrapUri(slug, block.uri) };
  if (block.type === 'resource' && block.resource) return { ...block, resource: { ...block.resource, uri: wrapUri(slug, block.resource.uri) } };
  return block;
}
function qualifyResult(result, slug) {
  return { ...result,
    ...(Array.isArray(result.content) ? { content: result.content.map(block => content(block, slug)) } : {}),
    ...(Array.isArray(result.messages) ? { messages: result.messages.map(message => ({ ...message, content: content(message.content, slug) })) } : {}),
    ...(Array.isArray(result.contents) ? { contents: result.contents.map(item => ({ ...item, uri: wrapUri(slug, item.uri) })) } : {}),
  };
}
module.exports = { wrapUri, qualifyResult };
