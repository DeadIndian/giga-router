// routing logic tests — run: node --test test/routing.test.js
const assert = require('assert');
const { toMinutes, matchSchedule, resolveCandidates, routingOf } = require('../server');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

console.log('\ntoMinutes');
t('parses HH:MM', () => assert.strictEqual(toMinutes('01:30'), 90));
t('parses midnight', () => assert.strictEqual(toMinutes('00:00'), 0));
t('parses 23:59', () => assert.strictEqual(toMinutes('23:59'), 1439));
t('rejects 24:00', () => assert.strictEqual(toMinutes('24:00'), null));
t('rejects 12:60', () => assert.strictEqual(toMinutes('12:60'), null));
t('rejects garbage', () => assert.strictEqual(toMinutes('nope'), null));
t('rejects empty', () => assert.strictEqual(toMinutes(''), null));

console.log('\nroutingOf defaults');
t('defaults to auto mode', () => {
  const r = routingOf({});
  assert.strictEqual(r.mode, 'auto');
  assert.deepStrictEqual(r.schedules, []);
  assert.deepStrictEqual(r.autoOrder, []);
});
t('rejects bogus mode', () => assert.strictEqual(routingOf({ routing: { mode: 'wat' } }).mode, 'auto'));

console.log('\nmatchSchedule');
const sched = (start, end, days, providerId = 'a') => ({ providerId, start, end, timezone: 'UTC', days });
const at = (mins, day = 'mon') => ({ minutes: mins, day });

t('matches inside window', () => assert.ok(matchSchedule([sched('01:30', '03:30')], at(120))));
t('matches at start boundary', () => assert.ok(matchSchedule([sched('01:30', '03:30')], at(90))));
t('excludes at end boundary', () => assert.strictEqual(matchSchedule([sched('01:30', '03:30')], at(210)), null));
t('excludes before window', () => assert.strictEqual(matchSchedule([sched('01:30', '03:30')], at(89)), null));
t('excludes after window', () => assert.strictEqual(matchSchedule([sched('01:30', '03:30')], at(211)), null));
t('handles midnight wrap (inside late)', () => assert.ok(matchSchedule([sched('23:00', '02:00')], at(1380))));
t('handles midnight wrap (inside early)', () => assert.ok(matchSchedule([sched('23:00', '02:00')], at(60))));
t('handles midnight wrap (outside)', () => assert.strictEqual(matchSchedule([sched('23:00', '02:00')], at(600)), null));
t('respects day filter', () => assert.strictEqual(matchSchedule([sched('01:30', '03:30', ['tue'])], at(120, 'mon')), null));
t('matches when day in filter', () => assert.ok(matchSchedule([sched('01:30', '03:30', ['mon'])], at(120, 'mon'))));
t('empty day array means every day', () => assert.ok(matchSchedule([sched('01:30', '03:30', [])], at(120, 'sun'))));
t('returns first match when windows overlap', () => {
  const a = sched('01:00', '05:00'), b = sched('02:00', '04:00');
  assert.strictEqual(matchSchedule([a, b], at(180)), a);
});
t('skips malformed entries', () => assert.strictEqual(matchSchedule([{ start: 'x' }], at(180)), null));

console.log('\nresolveCandidates');
const providers = [
  { id: 'a', name: 'alpha', defaultModel: 'm1', type: 'openai', baseUrl: 'https://a/v1', apiKey: 'k' },
  { id: 'b', name: 'beta', defaultModel: 'm2', type: 'openai', baseUrl: 'https://b/v1', apiKey: 'k' },
  { id: 'c', name: 'gamma', defaultModel: 'm3', type: 'openai', baseUrl: 'https://c/v1', apiKey: 'k' },
];
const cfg = (routing, activeId = 'a') => ({ providers, activeId, routing });

t('schedule overrides auto and yields single provider', () => {
  const r = resolveCandidates(cfg({ mode: 'auto', schedules: [sched('01:30', '03:30')] }), at(120));
  assert.strictEqual(r.providers.length, 1);
  assert.strictEqual(r.providers[0].id, 'a');
  assert.ok(r.reason.startsWith('schedule:'));
});
t('schedule matches by provider id', () => {
  const s = { providerId: 'b', start: '01:30', end: '03:30', timezone: 'UTC' };
  const r = resolveCandidates(cfg({ mode: 'auto', schedules: [s] }), at(120));
  assert.strictEqual(r.providers[0].id, 'b');
  assert.strictEqual(r.providers.length, 1);
});
t('schedule can match by provider name', () => {
  const s = { providerId: 'gamma', start: '01:30', end: '03:30', timezone: 'UTC' };
  const r = resolveCandidates(cfg({ mode: 'auto', schedules: [s] }), at(120));
  assert.strictEqual(r.providers[0].id, 'c');
});
t('schedule with unknown provider falls through to auto', () => {
  const s = { providerId: 'nope', start: '01:30', end: '03:30', timezone: 'UTC' };
  const r = resolveCandidates(cfg({ mode: 'auto', schedules: [s] }), at(120));
  assert.strictEqual(r.reason, 'auto');
  assert.strictEqual(r.providers.length, 3);
});
t('manual mode yields only active', () => {
  const r = resolveCandidates(cfg({ mode: 'manual' }, 'b'), at(600));
  assert.strictEqual(r.providers.length, 1);
  assert.strictEqual(r.providers[0].id, 'b');
});
t('manual mode ignores schedule windows', () => {
  const s = { providerId: 'c', start: '01:30', end: '03:30', timezone: 'UTC' };
  const r = resolveCandidates(cfg({ mode: 'manual', schedules: [s] }, 'a'), at(120));
  assert.strictEqual(r.providers[0].id, 'a');
});
t('auto mode orders by autoOrder first', () => {
  const r = resolveCandidates(cfg({ mode: 'auto', autoOrder: ['c', 'b'] }), at(600));
  assert.deepStrictEqual(r.providers.map((p) => p.id), ['c', 'b', 'a']);
});
t('auto mode appends active when not in autoOrder', () => {
  const r = resolveCandidates(cfg({ mode: 'auto', autoOrder: ['c'] }, 'b'), at(600));
  assert.deepStrictEqual(r.providers.map((p) => p.id), ['c', 'b', 'a']);
});
t('auto mode includes every provider exactly once', () => {
  const r = resolveCandidates(cfg({ mode: 'auto', autoOrder: ['c', 'c', 'b'] }), at(600));
  const ids = r.providers.map((p) => p.id);
  assert.deepStrictEqual(ids, ['c', 'b', 'a']);
  assert.strictEqual(new Set(ids).size, ids.length);
});
t('autoOrder tolerates unknown keys', () => {
  const r = resolveCandidates(cfg({ mode: 'auto', autoOrder: ['zzz', 'b'] }), at(600));
  assert.deepStrictEqual(r.providers.map((p) => p.id), ['b', 'a', 'c']);
});
t('empty provider list yields empty chain', () => {
  const r = resolveCandidates({ providers: [], activeId: null, routing: { mode: 'auto' } }, at(0));
  assert.deepStrictEqual(r.providers, []);
});
t('schedule outside window falls back to auto chain', () => {
  const r = resolveCandidates(cfg({ mode: 'auto', schedules: [sched('01:30', '03:30')] }), at(900));
  assert.strictEqual(r.reason, 'auto');
  assert.strictEqual(r.providers.length, 3);
});

console.log('\nschedule fallbackOnFailure');
t('default: window is the ONLY provider (no failover)', () => {
  const r = resolveCandidates(cfg({ mode: 'auto', schedules: [sched('01:30', '03:30')] }), at(120));
  assert.deepStrictEqual(r.providers.map((p) => p.id), ['a']);
});
t('fallbackOnFailure: pinned first, then the rest', () => {
  const s = { providerId: 'b', start: '01:30', end: '03:30', timezone: 'UTC', fallbackOnFailure: true };
  const r = resolveCandidates(cfg({ mode: 'auto', schedules: [s] }), at(120));
  assert.strictEqual(r.providers[0].id, 'b', 'pinned provider must stay first');
  assert.strictEqual(r.providers.length, 3);
  assert.strictEqual(new Set(r.providers.map((p) => p.id)).size, 3);
});
t('fallbackOnFailure respects autoOrder for the tail', () => {
  const s = { providerId: 'b', start: '01:30', end: '03:30', timezone: 'UTC', fallbackOnFailure: true };
  const r = resolveCandidates(cfg({ mode: 'auto', autoOrder: ['c'], schedules: [s] }), at(120));
  assert.deepStrictEqual(r.providers.map((p) => p.id), ['b', 'c', 'a']);
});
t('fallbackOnFailure still reports the schedule reason', () => {
  const s = { providerId: 'b', start: '01:30', end: '03:30', timezone: 'UTC', fallbackOnFailure: true, label: 'cron' };
  const r = resolveCandidates(cfg({ mode: 'auto', schedules: [s] }), at(120));
  assert.strictEqual(r.reason, 'schedule:cron');
  assert.ok(r.scheduled);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
