import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, mergeModels, validSeries, recentRates, normalizeMetric } from '../public/model-state.js';

const now = Date.parse('2026-10-23T10:25:00Z');
const point = (rate, age = 1800) => ({ ts: now / 1000 - age, success_rate: rate });

test('summary-only data is distinct from missing data and measured failures', () => {
  assert.equal(classify({ success_rate: 0 }, now), 'summary');
  assert.equal(classify({ recent_success_series: [] }, now), 'unknown');
  assert.equal(classify({ recent_success_series: [point(0)] }, now), 'failed');
});
test('older untimed rates are preserved without inventing timestamps or freshness', () => {
  const metric = normalizeMetric({ success_rate: 99, recent_success_rates: [99.49, 100, 100] }, now);
  assert.deepEqual(recentRates(metric.recent_success_rates), [99.49, 100, 100]);
  assert.deepEqual(metric.recent_success_series, []);
  assert.equal(classify(metric, now), 'untimed');
  assert.equal(classify({ recent_success_rates: [0] }, now), 'untimed');
});
test('string and millisecond timestamps normalize to the same measured series', () => {
  assert.deepEqual(validSeries([{ ts: String(point(100).ts * 1000), success_rate: '100' }], now), [point(100)]);
  assert.equal(normalizeMetric({ success_rate: '99.5' }, now).success_rate, 99.5);
});
test('group series retains its own success rate and timestamps', () => {
  const healthy = normalizeMetric({ group: 'premium', success_rate: 100, series: [point(100)] }, now);
  const failed = normalizeMetric({ group: 'default', success_rate: 0, series: [point(0)] }, now);
  assert.equal(classify(healthy, now), 'healthy');
  assert.equal(classify(failed, now), 'failed');
  assert.equal(healthy.success_rate, 100);
  assert.equal(failed.success_rate, 0);
});
test('old successful buckets and unavailable fetches cannot imply current health', () => {
  const metric = { recent_success_series: [point(100, 7200)] };
  assert.equal(classify(metric, now), 'stale');
  assert.equal(classify(metric, now, true), 'interrupted');
  assert.equal(classify({ recent_success_series: [point(100)] }, now, true), 'interrupted');
});
test('latest bucket controls the status rather than the full-window average', () => {
  assert.equal(classify({ success_rate: 100, recent_success_series: [point(0), point(100, 3600)] }, now), 'failed');
  assert.equal(classify({ recent_success_series: [point(94.99)] }, now), 'degraded');
  assert.equal(classify({ recent_success_series: [point(95)] }, now), 'healthy');
});
test('malformed or future statistics do not produce a healthy status', () => {
  const points = [point(101), point(-1), { ts: now / 1000 + 3600, success_rate: 100 }, { ts: now / 1000, success_rate: null }];
  assert.deepEqual(validSeries(points, now), []);
  assert.equal(classify({ recent_success_series: points }, now), 'unknown');
});
test('catalog-only models remain unknown and stats-only models remain discoverable', () => {
  const result = mergeModels([{ model_name: 'claude-a' }], [{ model_name: 'gemini-b', recent_success_series: [point(100)] }], now, false);
  assert.equal(result.length, 2);
  assert.equal(result.find(m => m.model_name === 'claude-a').state, 'unknown');
  assert.equal(result.find(m => m.model_name === 'gemini-b').state, 'healthy');
});
