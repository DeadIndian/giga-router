// health / trip tests — run: node --test test/health.test.js
const assert = require('assert');
const {
  markFailure, markSuccess, isCooling, isTripped, healthy, healthSnapshot,
  health, resolveCandidates, TRIP_AFTER, FAIL_COOLDOWN_MS, TRIP_COOLDOWN_MS,
} = require('../server');

let pass = 0, fail = 0;
function t(name, fn) {
  try { health.clear(); fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const P = { id: 'p1', name: 'alpha', defaultModel: 'm', type: 'openai', baseUrl: 'https://a/v1', apiKey: 'k' };
const Q = { id: 'p2', name: 'beta', defaultModel: 'm', type: 'openai', baseUrl: 'https://b/v1', apiKey: 'k' };

console.log('\ncooldown (short bench)');
t('fresh provider is healthy', () => assert.ok(healthy(P)));
t('one failure -> cooling but NOT tripped', () => {
  markFailure(P.id);
  assert.ok(isCooling(P));
  assert.ok(!isTripped(P));
  assert.ok(!healthy(P));
});
t('cooldown duration matches FAIL_COOLDOWN_MS', () => {
  markFailure(P.id);
  const e = health.get(P.id);
  assert.ok(e.until - Date.now() <= FAIL_COOLDOWN_MS + 50);
  assert.ok(e.until - Date.now() > FAIL_COOLDOWN_MS - 500);
});
t('success clears all state', () => {
  markFailure(P.id); markFailure(P.id);
  markSuccess(P.id);
  assert.ok(healthy(P));
  assert.strictEqual(health.get(P.id), undefined);
});

console.log('\ntrip (consecutive failures)');
t('TRIP_AFTER is 5', () => assert.strictEqual(TRIP_AFTER, 5));
t('trips exactly on the 5th failure', () => {
  for (let i = 1; i < TRIP_AFTER; i++) {
    const tripped = markFailure(P.id);
    assert.strictEqual(tripped, false, `should not trip on failure ${i}`);
    assert.ok(!isTripped(P), `not tripped after ${i}`);
  }
  const tripped = markFailure(P.id);
  assert.strictEqual(tripped, true, 'should trip on the 5th');
  assert.ok(isTripped(P));
});
t('trip cooldown is longer than the bench', () => assert.ok(TRIP_COOLDOWN_MS > FAIL_COOLDOWN_MS));
t('success resets the consecutive counter', () => {
  for (let i = 0; i < TRIP_AFTER - 1; i++) markFailure(P.id);
  markSuccess(P.id);
  // after a success, it takes TRIP_AFTER fresh failures to trip again
  for (let i = 1; i < TRIP_AFTER; i++) assert.strictEqual(markFailure(P.id), false, `failure ${i} must not trip`);
  assert.strictEqual(markFailure(P.id), true);
});
t('failures are counted per provider, not globally', () => {
  for (let i = 0; i < TRIP_AFTER; i++) markFailure(P.id);
  assert.ok(isTripped(P));
  assert.ok(!isTripped(Q));
  assert.ok(healthy(Q));
});
t('tripped provider is neither cooling-healthy nor usable', () => {
  for (let i = 0; i < TRIP_AFTER; i++) markFailure(P.id);
  assert.ok(isTripped(P));
  assert.ok(!healthy(P));
});

console.log('\nsnapshot');
t('snapshot reports fails, cooling, tripped', () => {
  markFailure(P.id);
  const snap = healthSnapshot([P, Q]);
  const a = snap.find((s) => s.name === 'alpha');
  const b = snap.find((s) => s.name === 'beta');
  assert.strictEqual(a.fails, 1);
  assert.strictEqual(a.cooling, true);
  assert.strictEqual(a.tripped, false);
  assert.strictEqual(b.fails, 0);
  assert.strictEqual(b.cooling, false);
});
t('snapshot after trip shows tripped + until timestamp', () => {
  for (let i = 0; i < TRIP_AFTER; i++) markFailure(P.id);
  const a = healthSnapshot([P]).find((s) => s.name === 'alpha');
  assert.strictEqual(a.tripped, true);
  assert.ok(a.trippedUntil > Date.now());
});

console.log('\nintegration with resolveCandidates');
t('tripped pinned provider drops out of a fallback window', () => {
  const cfg = {
    providers: [P, Q], activeId: Q.id,
    routing: {
      mode: 'auto', autoOrder: [],
      schedules: [{
        providerId: P.id, start: '00:00', end: '23:59',
        timezone: 'UTC', label: 'cron', fallbackOnFailure: true,
      }],
    },
  };
  // before trip: pinned first
  let r = resolveCandidates(cfg, { minutes: 600, day: 'mon' });
  assert.strictEqual(r.providers[0].id, P.id);
  assert.ok(!r.trippedProvider);

  for (let i = 0; i < TRIP_AFTER; i++) markFailure(P.id);

  // after trip: pinned provider gone, reason marked, others still serve
  r = resolveCandidates(cfg, { minutes: 600, day: 'mon' });
  assert.strictEqual(r.providers.length, 1);
  assert.strictEqual(r.providers[0].id, Q.id);
  assert.ok(r.reason.endsWith(':tripped'), `reason was ${r.reason}`);
  assert.strictEqual(r.trippedProvider.id, P.id);
});
t('strict window still returns the tripped provider (no silent bypass)', () => {
  const cfg = {
    providers: [P, Q], activeId: Q.id,
    routing: {
      mode: 'auto', autoOrder: [],
      schedules: [{ providerId: P.id, start: '00:00', end: '23:59', timezone: 'UTC', label: 'strict' }],
    },
  };
  for (let i = 0; i < TRIP_AFTER; i++) markFailure(P.id);
  const r = resolveCandidates(cfg, { minutes: 600, day: 'mon' });
  assert.strictEqual(r.providers.length, 1);
  assert.strictEqual(r.providers[0].id, P.id);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
