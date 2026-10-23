import { normalizeOrigin } from './site-config.js';
import { mergeModels, normalizeMetric, classify, validSeries } from './model-state.js';

export const FAVORITES_KEY = 'model-observatory.favorites.v1';
export const favoriteKey = item => JSON.stringify([normalizeOrigin(item.url), item.model, item.group || '']);

export function validateFavorites(raw) {
  if (raw?.version !== 1 || !Array.isArray(raw.items) || raw.items.length > 300) throw new Error('关注记录格式不正确。');
  const unique = new Map();
  for (const item of raw.items) {
    if (!item || typeof item.model !== 'string' || !item.model || item.model.length > 300 || typeof item.group !== 'string' || item.group.length > 200 || /[\u0000-\u001f\u007f]/.test(item.model + item.group)) throw new Error('关注记录格式不正确。');
    const entry = { url: normalizeOrigin(item.url), model: item.model, group: item.group };
    unique.set(favoriteKey(entry), entry);
  }
  return [...unique.values()];
}

export class Favorites {
  constructor(storage) {
    this.storage = storage;
    this.items = [];
    this.error = false;
    try {
      const saved = storage.getItem(FAVORITES_KEY);
      if (saved) this.items = validateFavorites(JSON.parse(saved));
    } catch { this.error = true; }
    this.keys = new Set(this.items.map(favoriteKey));
  }
  has(item) { return this.keys.has(favoriteKey(item)); }
  toggle(item) {
    const selected = this.has(item);
    const next = selected ? this.items.filter(saved => favoriteKey(saved) !== favoriteKey(item)) : [...this.items, item];
    if (next.length > 300) throw new Error('最多关注 300 个模型，请先取消部分关注。');
    const valid = validateFavorites({ version: 1, items: next });
    // Commit only after browser storage succeeds, so the star never promises an unsaved change.
    this.storage.setItem(FAVORITES_KEY, JSON.stringify({ version: 1, items: valid }));
    this.items = valid;
    this.keys = new Set(valid.map(favoriteKey));
    return !selected;
  }
}

export function favoriteResult(item, overview, detail, referenceNow = Date.now()) {
  const model = mergeModels(overview.catalog?.models || [], overview.metrics?.models || [], referenceNow).find(model => model.model_name === item.model);
  const interrupted = Boolean(overview.metrics?.error || overview.catalog?.error || (item.group && detail?.error));
  const group = item.group ? detail?.data?.groups?.find(group => group.group === item.group) : null;
  const metric = item.group ? (group ? normalizeMetric(group, referenceNow) : undefined) : model?.metric;
  return { metric, state: classify(metric, referenceNow, interrupted), latest: validSeries(metric?.recent_success_series, referenceNow).at(-1)?.ts ?? null,
    note: interrupted ? '统计读取失败' : !model ? '所选时段未收录此模型' : item.group && !group ? '此分组暂无统计' : '' };
}
