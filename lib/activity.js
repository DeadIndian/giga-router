const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, writeJson } = require('./storage');
const file = path.join(DATA_DIR, 'activity.json');
const startedAt = new Date().toISOString();
let recent;
const counts = { llm: 0, mcp: 0, errors: 0 };
function history() {
  if (!recent) {
    try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); recent = Array.isArray(saved.recent) ? saved.recent.slice(0, 200) : []; }
    catch { recent = []; }
  }
  return recent;
}

function recordActivity(event) {
  const item = { at: new Date().toISOString(), ...event };
  history().unshift(item);
  if (recent.length > 200) recent.pop();
  if (item.kind in counts) counts[item.kind]++;
  if (item.status === 'error') counts.errors++;
  try { writeJson(file, { recent }); } catch { /* Diagnostics must not fail a successful request. */ }
}

function activitySnapshot() {
  return { startedAt, counts: { ...counts }, recent: history().slice(0, 100) };
}

module.exports = { recordActivity, activitySnapshot };
