export const labels = { healthy: '近期正常', degraded: '成功率偏低', failed: '近期失败', stale: '仅历史数据', unknown: '暂无数据', interrupted: '同步中断' };
export const finite = value => typeof value === 'number' && Number.isFinite(value);
export function validSeries(series, now = Date.now()) {
  return (Array.isArray(series) ? series : []).filter(p => finite(p.ts) && p.ts > 0 && p.ts * 1000 <= now + 120_000 && finite(p.success_rate) && p.success_rate >= 0 && p.success_rate <= 100).sort((a, b) => a.ts - b.ts);
}
export function classify(metric, now = Date.now(), interrupted = false) {
  if (interrupted) return 'interrupted';
  const points = validSeries(metric?.recent_success_series, now);
  const latest = points.at(-1);
  if (!latest) return 'unknown';
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
  for (const model of catalog || []) if (typeof model.model_name === 'string') map.set(model.model_name, { ...model });
  for (const metric of metrics || []) if (typeof metric.model_name === 'string') map.set(metric.model_name, { ...map.get(metric.model_name), model_name: metric.model_name, metric });
  return [...map.values()].map(model => ({
    ...model, family: family(model.model_name),
    state: classify(model.metric, now, interrupted),
    latest: validSeries(model.metric?.recent_success_series, now).at(-1)?.ts ?? null
  }));
}
