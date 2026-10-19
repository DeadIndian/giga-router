const startedAt = new Date().toISOString();
const recent = [];
const counts = { llm: 0, mcp: 0, errors: 0 };

function recordActivity(event) {
  const item = { at: new Date().toISOString(), ...event };
  recent.unshift(item);
  if (recent.length > 100) recent.pop();
  if (item.kind in counts) counts[item.kind]++;
  if (item.status === 'error') counts.errors++;
}

function activitySnapshot() {
  return { startedAt, counts: { ...counts }, recent: recent.slice(0, 30) };
}

module.exports = { recordActivity, activitySnapshot };
