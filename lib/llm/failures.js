const { FAIL_COOLDOWN_MS } = require('./routing');
function retryAfter(headers, now = Date.now()) {
  const value = headers?.get('retry-after');
  const milliseconds = headers?.get('retry-after-ms');
  let delay = milliseconds ? Number(milliseconds) : value && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : value ? Date.parse(value) - now : NaN;
  if (!Number.isFinite(delay)) return null;
  return Math.min(24 * 60 * 60_000, Math.max(1000, delay));
}
function failure(status, message, headers, category) {
  if (!category) {
    if ([401, 403].includes(status)) category = 'credential';
    else if (status === 402 || ([400, 429].includes(status) && /quota|spend.?limit|spend.?cap|credit|billing|budget|insufficient_quota/i.test(message))) category = 'quota';
    else if (status === 429) category = 'rate_limit';
    else if (status === 404 || (status === 400 && /not supported|unsupported|context.{0,30}(exceed|length)|model.{0,30}(not found|unavailable)/i.test(message))) category = 'capability_mismatch';
    else if ([408, 504].includes(status)) category = 'timeout';
    else if (status >= 500 || [409, 425].includes(status)) category = 'transient';
    else category = 'caller_error';
  }
  const retryMs = retryAfter(headers);
  return Object.assign(new Error(message), { status, category, retryMs, retryable: !['caller_error', 'cancelled'].includes(category),
    penalize: !['caller_error', 'cancelled', 'capability_mismatch'].includes(category), cooldownMs: retryMs || (['quota', 'credential'].includes(category) ? 5 * 60_000 : FAIL_COOLDOWN_MS) });
}
module.exports = { failure, retryAfter };
