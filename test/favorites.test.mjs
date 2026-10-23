import test from 'node:test';
import assert from 'node:assert/strict';
import { Favorites, favoriteKey, validateFavorites, favoriteResult, FAVORITES_KEY } from '../public/favorites.js';

const item = { url: 'https://api.alpha.com', model: 'claude-test', group: '' };
const referenceNow = Date.now();
const metric = rate => ({ model_name: item.model, success_rate: rate, recent_success_series: [{ ts: referenceNow / 1000 - 60, success_rate: rate }] });
const overview = { catalog: { models: [{ model_name: item.model }] }, metrics: { models: [metric(100)] } };

test('favorite identity separates sites, exact model names and groups, normalizing origin only', () => {
  const values = [item, { ...item, url: 'https://api.beta.com' }, { ...item, model: 'Claude-test' }, { ...item, group: 'default' }, { ...item, group: 'premium' }];
  assert.equal(new Set(values.map(favoriteKey)).size, 5);
  assert.equal(favoriteKey(item), favoriteKey({ ...item, url: 'https://API.ALPHA.COM/pricing' }));
  assert.equal(validateFavorites({ version: 1, items: [item, item] }).length, 1);
});

test('browser persistence survives reload and site renames; failed writes do not change stars', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const first = new Favorites(storage);
  assert.equal(first.toggle(item), true);
  const second = new Favorites(storage);
  assert.equal(second.has({ ...item, name: 'renamed site' }), true);
  second.storage = { setItem() { throw new Error('QUOTA'); } };
  assert.throws(() => second.toggle(item));
  assert.equal(second.has(item), true);
  second.storage = storage;
  assert.equal(second.toggle(item), false);
  assert.deepEqual(new Favorites(storage).items, []);
  data.set(FAVORITES_KEY, '{broken');
  assert.equal(new Favorites(storage).error, true);
});

test('favorite groups use their actual statistics and never fall back to global success', () => {
  assert.equal(favoriteResult(item, overview, null, referenceNow).state, 'healthy');
  const grouped = { ...item, group: 'paid' };
  const detail = { data: { groups: [{ group: 'paid', success_rate: 0, series: metric(0).recent_success_series }] } };
  const result = favoriteResult(grouped, overview, detail, referenceNow);
  assert.equal(result.state, 'failed');
  assert.equal(result.metric.success_rate, 0);
  assert.equal(favoriteResult(grouped, overview, { data: { groups: [] } }, referenceNow).state, 'unknown');
  assert.equal(favoriteResult(grouped, overview, { error: 'FETCH_FAILED' }, referenceNow).state, 'interrupted');
  assert.equal(favoriteResult(item, { ...overview, metrics: { ...overview.metrics, error: 'FETCH_FAILED' } }, null, referenceNow).state, 'interrupted');
});

test('invalid or unbounded favorite data cannot be saved', () => {
  for (const changed of [{ model: '' }, { url: 'http://api.alpha.com' }, { group: 'a\nb' }]) assert.throws(() => validateFavorites({ version: 1, items: [{ ...item, ...changed }] }));
  assert.throws(() => validateFavorites({ version: 1, items: Array(301).fill(item) }));
});
