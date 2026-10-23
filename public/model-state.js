export const labels = { healthy: '近期正常', degraded: '成功率偏低', failed: '近期失败', stale: '仅历史数据', untimed: '未提供时间', summary: '仅汇总数据', unknown: '暂无数据', loading: '待读取', interrupted: '同步中断' };
export const finite = value => typeof value === 'number' && Number.isFinite(value);
export function metricNumber(value) {
  if (finite(value)) return value;
  if (typeof value === 'string' && value.trim() && /^\d+(?:\.\d+)?%?$/.test(value.trim())) return Number(value.trim().replace(/%$/, ''));
  return null;
}
export function validSeries(series, now = Date.now()) {
  return (Array.isArray(series) ? series : []).filter(p => p && typeof p === 'object').map(p => {
    let ts = metricNumber(p.ts);
    if (ts !== null && ts >= 1e12) ts /= 1000;
    return { ...p, ts, success_rate: metricNumber(p.success_rate) };
  }).filter(p => finite(p.ts) && p.ts > 0 && p.ts * 1000 <= now + 120_000 && finite(p.success_rate) && p.success_rate >= 0 && p.success_rate <= 100).sort((a, b) => a.ts - b.ts);
}
export function normalizeMetric(metric, now = Date.now()) {
  if (!metric) return undefined;
  return { ...metric, success_rate: metricNumber(metric.success_rate), avg_latency_ms: metricNumber(metric.avg_latency_ms), avg_tps: metricNumber(metric.avg_tps), recent_success_series: validSeries(metric.recent_success_series ?? metric.series, now) };
}
export function recentRates(series) {
  return (Array.isArray(series) ? series : []).map(metricNumber).filter(rate => finite(rate) && rate >= 0 && rate <= 100);
}
export function classify(metric, now = Date.now(), interrupted = false) {
  if (interrupted) return 'interrupted';
  if (metric?.pending) return 'loading';
  const points = validSeries(metric?.recent_success_series, now);
  const latest = points.at(-1);
  if (!latest) return recentRates(metric?.recent_success_rates).length ? 'untimed' : finite(metricNumber(metric?.success_rate)) ? 'summary' : 'unknown';
  if (now - latest.ts * 1000 >= 2 * 60 * 60 * 1000) return 'stale';
  return rateState(latest.success_rate);
}
export function rateState(rate) {
  if (!finite(rate) || rate < 0 || rate > 100) return 'unknown';
  if (rate === 0) return 'failed';
  return rate >= 95 ? 'healthy' : 'degraded';
}
export function family(name) {
  const n = name.toLowerCase();
  if (/claude|opus|sonnet|haiku/.test(n)) return 'Claude';
  if (/gemini/.test(n)) return 'Gemini';
  if (/gpt|chatgpt|^o[134](?:-|$)|codex/.test(n)) return 'GPT';
  if (/deepseek/.test(n)) return 'DeepSeek';
  if (/qwen/.test(n)) return 'Qwen';
  if (/glm/.test(n)) return 'GLM';
  if (/kimi/.test(n)) return 'Kimi';
  return '其他';
}
export function mergeModels(catalog, metrics, now, interrupted) {
  const map = new Map();
  for (const model of catalog || []) if (model && typeof model.model_name === 'string') map.set(model.model_name, { ...model });
  for (const metric of metrics || []) if (metric && typeof metric.model_name === 'string') map.set(metric.model_name, { ...map.get(metric.model_name), model_name: metric.model_name, metric: normalizeMetric(metric, now) });
  return [...map.values()].map(model => ({
    ...model, family: family(model.model_name),
    state: classify(model.metric, now, interrupted),
    latest: validSeries(model.metric?.recent_success_series, now).at(-1)?.ts ?? null
  }));
}
