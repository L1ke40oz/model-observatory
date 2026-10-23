import { STORAGE_KEY, validateSiteList, MAX_SITES } from './site-config.js';
import { FAVORITES_KEY, validateFavorites, favoriteKey } from './favorites.js';

export function createBackup(sites, favorites) {
  return { version: 1, sites: sites.map(({ name, url }) => ({ name, url })), favorites: validateFavorites({ version: 1, items: favorites }) };
}

export function mergeBackup(sites, favorites, raw, makeId) {
  const incoming = validateSiteList(raw);
  const merged = new Map(sites.map(site => [site.url, site]));
  for (const site of incoming) merged.set(site.url, { ...site, id: merged.get(site.url)?.id || makeId() });
  if (merged.size > MAX_SITES) throw new Error(`最多保存 ${MAX_SITES} 个站点。`);
  // Old site-only backups leave existing favorites intact.
  const imported = raw.favorites === undefined ? [] : validateFavorites({ version: 1, items: raw.favorites });
  const followed = new Map(favorites.map(item => [favoriteKey(item), item]));
  for (const item of imported) followed.set(favoriteKey(item), item);
  return { sites: [...merged.values()], favorites: validateFavorites({ version: 1, items: [...followed.values()] }) };
}

export function saveBackup(storage, sites, favorites) {
  const previousSites = storage.getItem(STORAGE_KEY);
  const nextFavorites = validateFavorites({ version: 1, items: favorites });
  storage.setItem(STORAGE_KEY, JSON.stringify(sites));
  try {
    storage.setItem(FAVORITES_KEY, JSON.stringify({ version: 1, items: nextFavorites }));
  } catch (error) {
    // A failed second write must not leave half of an import installed.
    if (previousSites === null) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, previousSites);
    throw error;
  }
  return nextFavorites;
}
