function inputError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function httpUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw inputError('Enter an absolute HTTP or HTTPS URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw inputError('Use an HTTP/HTTPS URL without embedded credentials or a fragment');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '169.254.169.254' || host === 'metadata.google.internal' || host === 'fd00:ec2::254') {
    throw inputError('Cloud metadata is not an upstream endpoint');
  }
  return url;
}

function headerMap(value, previous = {}) {
  if (value === undefined) return { ...previous };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw inputError('Headers must be a JSON object of name/value strings');
  const out = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof raw !== 'string' || /[\r\n]/.test(raw)) throw inputError('Header names and values must be valid single-line strings');
    if (['host', 'connection', 'content-length', 'transfer-encoding'].includes(name.toLowerCase())) throw inputError(`Header ${name} is managed by the gateway`);
    const content = raw === '***' ? previous[name] : raw;
    if (content !== undefined) out[name] = content;
  }
  return out;
}

function maskedMap(value) {
  return Object.fromEntries(Object.keys(value || {}).map((name) => [name, '***']));
}

module.exports = { inputError, httpUrl, headerMap, maskedMap };
