import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackup, mergeBackup, saveBackup } from '../public/backup.js';
import { STORAGE_KEY } from '../public/site-config.js';
import { FAVORITES_KEY } from '../public/favorites.js';

const site = { id: 'old', name: 'Site A', url: 'https://api.example.org', apiKey: 'discard' };
const favorite = { url: site.url, model: 'claude-test', group: 'default' };

test('configuration backups restore sites and group-specific favorites without extra fields', () => {
  const backup = createBackup([site], [favorite, { ...favorite, group: '' }]);
  assert.equal(backup.sites[0].apiKey, undefined);
  const restored = mergeBackup([], [], JSON.parse(JSON.stringify(backup)), () => 'new');
  assert.equal(restored.sites[0].id, 'new');
  assert.deepEqual(restored.favorites, [favorite, { ...favorite, group: '' }]);
  assert.equal(mergeBackup([site], [favorite], backup, () => 'unused').sites[0].id, 'old');
  assert.equal(mergeBackup([site], [favorite], backup, () => 'unused').favorites.length, 2);
});

test('old backups preserve current favorites and malformed new backups fail before writes', () => {
  assert.deepEqual(mergeBackup([], [favorite], { version: 1, sites: [] }, () => 'new').favorites, [favorite]);
  assert.throws(() => mergeBackup([], [favorite], { version: 1, sites: [], favorites: [{ ...favorite, url: 'http://api.example.org' }] }, () => 'new'));
});

test('failed favorite storage rolls back site import and never changes previous favorites', () => {
  for (const existing of [null, 'old-sites']) {
    const data = new Map([[FAVORITES_KEY, 'old-favorites']]);
    if (existing !== null) data.set(STORAGE_KEY, existing);
    const storage = { getItem: key => data.get(key) ?? null, removeItem: key => data.delete(key), setItem(key, value) { if (key === FAVORITES_KEY) throw new Error('QUOTA'); data.set(key, value); } };
    assert.throws(() => saveBackup(storage, { version: 1, sites: [site] }, [favorite]), /QUOTA/);
    assert.equal(storage.getItem(STORAGE_KEY), existing);
    assert.equal(storage.getItem(FAVORITES_KEY), 'old-favorites');
  }
});
