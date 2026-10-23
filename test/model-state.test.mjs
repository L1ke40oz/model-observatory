import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, mergeModels, validSeries } from '../public/model-state.js';

const now = Date.parse('2026-10-23T10:25:00Z');
const point = (rate, age = 1800) => ({ ts: now / 1000 - age, success_rate: rate });

test('absence of samples is unknown, while a measured 0% is failure', () => {
  assert.equal(classify({ success_rate: 0 }, now), 'unknown');
  assert.equal(classify({ recent_success_series: [] }, now), 'unknown');
  assert.equal(classify({ recent_success_series: [point(0)] }, now), 'failed');
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
