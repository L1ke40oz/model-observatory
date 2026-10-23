import { labels, finite, validSeries, rateState, mergeModels, classify, normalizeMetric, recentRates } from './model-state.js';
import { SiteManager } from './site-manager.js';
import { Favorites, favoriteKey, favoriteResult } from './favorites.js';
let siteManager;

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
const fullFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const clockFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const liveClockFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function updateLiveClock() {
  const date = new Date();
  $('live-clock').dateTime = date.toISOString();
  $('live-clock').textContent = liveClockFormat.format(date);
}
const stateOrder = ['healthy', 'degraded', 'failed', 'stale', 'untimed', 'summary', 'loading', 'unknown', 'interrupted'];
const familyOrder = ['Claude', 'GPT', 'Gemini', 'DeepSeek', 'Qwen', 'GLM', 'Kimi', '其他'];
const symbols = { Claude: '✳', GPT: '◎', Gemini: '✦', DeepSeek: '≈', Qwen: 'Q', GLM: 'G', Kimi: 'K', '其他': '◇' };
const state = { view: 'overview', sites: [], site: null, group: '', hours: 24, family: 'all', filter: 'all', search: '', recorded: true, sort: 'default', data: null, models: [], busy: false, interval: 30, nextRefresh: 0, serverTime: Date.now(), receivedAt: performance.now(), detailRequest: 0, loadRequest: 0 };
let favorites;
try { favorites = new Favorites(localStorage); }
catch { favorites = new Favorites({ getItem: () => null, setItem: () => { throw new Error('STORAGE_UNAVAILABLE'); } }); favorites.error = true; }
const favoriteRows = new Map();
let favoriteController;
let favoriteGeneration = 0;
const details = new Map();
const detailRequests = new Map();
const detailQueue = [];
let activeDetails = 0;
let historyObserver;
let renderScheduled = false;
const now = () => state.serverTime + performance.now() - state.receivedAt;
const badge = key => `<span class="state-badge ${key}"><i class="dot"></i>${labels[key]}</span>`;
const fmt = (value, digits = 2) => finite(value) ? value.toFixed(digits).replace(/\.00$/, '') : '—';
function value(value, unit, digits = 2) { return finite(value) && value >= 0 ? `${fmt(value, digits)}<span class="unit">${unit}</span>` : '<span class="no-value">—</span>'; }
const time = ts => finite(ts) ? timeFormat.format(ts) : '—';
const avatar = family => `<span class="model-avatar ${family.toLowerCase()}">${symbols[family] || '◇'}</span>`;
const detailKey = (name, site = state.sites.find(site => site.id === state.site), hours = state.hours) => JSON.stringify([site?.url, hours, name]);

function currentFavorite(model) {
  return { url: state.sites.find(site => site.id === state.site)?.url, model, group: state.group };
}

function favoriteButton(name) {
  const item = currentFavorite(name);
  const selected = favorites.has(item);
  const label = `${selected ? '取消关注' : '关注'} ${name}（${item.group || '全部分组'}）`;
  return `<button class="favorite-button${selected ? ' followed' : ''}" data-favorite="${escape(name)}" aria-pressed="${selected}" aria-label="${escape(label)}" title="${escape(label)}">${selected ? '★' : '☆'}</button>`;
}

function toggleFavorite(item) {
  try {
    const selected = favorites.toggle(item);
    $('favorites-count').textContent = favorites.items.length;
    if (!selected) favoriteRows.delete(favoriteKey(item));
    render();
    showToast(selected ? '已关注，可在“关注的模型”中查看' : '已取消关注');
  } catch { showToast(favorites.items.length >= 300 && !favorites.has(item) ? '最多关注 300 个模型，请先取消部分关注' : '保存失败，请检查浏览器存储空间和权限'); }
}

function setView(view) {
  state.view = view;
  const followed = view === 'favorites';
  window.history.replaceState(null, '', followed ? '#favorites' : location.pathname + location.search);
  $('overview-nav').classList.toggle('selected', !followed);
  $('favorites-nav').classList.toggle('selected', followed);
  $('overview-nav').setAttribute('aria-current', String(!followed));
  $('favorites-nav').setAttribute('aria-current', String(followed));
  for (const button of document.querySelectorAll('[data-view]')) { button.classList.toggle('active', button.dataset.view === view); button.setAttribute('aria-pressed', String(button.dataset.view === view)); }
  $('view-name').textContent = followed ? '关注的模型' : '模型总览';
  $('page-title').textContent = followed ? '关注的模型' : '模型状态';
  $('page-description').textContent = followed ? '集中查看已关注模型的公开统计。' : '根据站点公开统计查看模型近期状态。';
  $('models-title').textContent = followed ? '关注列表' : '模型一览';
  document.querySelector('.station-panel').hidden = followed;
  for (const selector of ['.filter-row', '.group-filter-row', '.filter-subrow']) document.querySelector(selector).hidden = followed;
  $('favorites-note').hidden = !followed;
  $('sort-name').disabled = followed;
  $('sort-rate').disabled = followed;
  $('notice').hidden = true;
}

function openFavorites() {
  if (state.view === 'favorites') return;
  state.controller?.abort();
  state.loadRequest++;
  state.detailRequest++;
  state.busy = false;
  historyObserver?.disconnect();
  setView('favorites');
  loadFavorites();
}

function renderFavorites() {
  $('model-count').textContent = favorites.items.length;
  $('history-title').textContent = `${state.hours} 小时记录`;
  $('favorites-count').textContent = favorites.items.length;
  if (!favorites.items.length) {
    $('model-rows').innerHTML = '<tr><td colspan="8"><div class="empty-state"><h3>还没有关注的模型</h3><p>在模型总览中点击模型旁的 ☆，即可在这里查看。</p><button class="button button-neutral" data-favorite-overview>查看模型总览</button></div></td></tr>';
    return;
  }
  $('model-rows').innerHTML = favorites.items.map(item => {
    const key = favoriteKey(item);
    const site = state.sites.find(site => site.url === item.url);
    const result = site ? favoriteRows.get(key) || { state: 'loading' } : { state: 'unknown', note: '站点已移除，重新添加后恢复同步' };
    const metric = result.metric;
    const rate = metric?.success_rate;
    const label = `取消关注 ${item.model}（${new URL(item.url).hostname} / ${item.group || '全部分组'}）`;
    return `<tr class="model-row favorite-row"><td><div class="model-cell"><button class="favorite-button followed" data-favorite="${escape(key)}" aria-pressed="true" aria-label="${escape(label)}" title="${escape(label)}">★</button><div><strong class="favorite-model-name">${escape(item.model)}</strong><div class="favorite-site">${escape(site?.name || new URL(item.url).hostname)}</div><div class="model-caption">${escape(new URL(item.url).hostname)} / ${escape(item.group || '全部分组')}</div></div></div></td><td>${badge(result.state)}${result.note ? `<div class="favorite-row-note">${escape(result.note)}</div>` : ''}</td><td>${result.state === 'loading' ? '<span class="history-empty">正在读取统计…</span>' : renderHistory(metric)}</td><td class="numeric">${finite(rate) && rate >= 0 && rate <= 100 ? `<span class="rate-value ${rateState(rate)}">${rate.toFixed(2)}<span class="unit">%</span></span>` : '—'}</td><td class="numeric">${value(finite(metric?.avg_latency_ms) ? metric.avg_latency_ms / 1000 : null, 's')}</td><td class="numeric">${metric?.avg_tps > 0 ? value(metric.avg_tps, 'tok/s', 1) : '—'}</td><td class="time-cell">${result.latest ? escape(fullFormat.format(result.latest * 1000)) : '—'}</td><td>${site ? `<button class="row-detail" data-favorite-open="${escape(key)}" aria-label="在站点中查看 ${escape(item.model)}" title="在站点中查看">›</button>` : ''}</td></tr>`;
  }).join('');
}

async function loadFavorites(manual = false) {
  if (state.busy) return;
  const generation = ++favoriteGeneration;
  favoriteController?.abort();
  favoriteController = new AbortController();
  const controller = favoriteController;
  const hours = state.hours;
  const items = [...favorites.items];
  favoriteRows.clear();
  state.busy = true;
  $('refresh').disabled = true;
  $('refresh').querySelector('span').textContent = '同步中';
  $('sync-dot').className = 'sync-dot loading';
  renderFavorites();
  const tasks = [];
  let failed = false;
  let latestFetch = 0;
  const current = () => generation === favoriteGeneration && state.view === 'favorites';
  const post = async (path, body) => {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(22_000)]), cache: 'no-store' });
    if (!response.ok) throw new Error('FETCH_FAILED');
    return response.json();
  };
  for (const url of new Set(items.map(item => item.url))) {
    const savedSite = state.sites.find(site => site.url === url);
    if (!savedSite) continue;
    const site = { name: savedSite.name, url };
    const siteItems = items.filter(item => item.url === url);
    tasks.push(async () => {
      try {
        const data = await post('/api/overview', { site, hours });
        if (!current()) return;
        failed ||= Boolean(data.catalog.error || data.metrics.error);
        latestFetch = Math.max(latestFetch, data.metrics.fetchedAt || 0);
        const grouped = new Map();
        const knownModels = new Set([...(data.catalog.models || []), ...(data.metrics.models || [])].map(model => model.model_name));
        for (const item of siteItems) {
          if (!item.group || !knownModels.has(item.model)) favoriteRows.set(favoriteKey(item), favoriteResult(item, data));
          else {
            if (!grouped.has(item.model)) grouped.set(item.model, []);
            grouped.get(item.model).push(item);
          }
        }
        // Reuse one detail response for all followed groups of the same site/model.
        for (const [model, groupItems] of grouped) tasks.push(async () => {
          let detail;
          try { detail = await post('/api/detail', { site, hours, model }); }
          catch { detail = { error: 'FETCH_FAILED' }; }
          if (!current()) return;
          failed ||= Boolean(detail.error);
          latestFetch = Math.max(latestFetch, detail.fetchedAt || 0);
          for (const item of groupItems) favoriteRows.set(favoriteKey(item), favoriteResult(item, data, detail));
          renderFavorites();
        });
        renderFavorites();
      } catch {
        if (!current()) return;
        failed = true;
        for (const item of siteItems) favoriteRows.set(favoriteKey(item), { state: 'interrupted', note: '站点统计读取失败，请稍后刷新' });
        renderFavorites();
      }
    });
  }
  // Four shared workers bound requests across both sites and model groups.
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, async () => {
    while (current() && cursor < tasks.length) await tasks[cursor++]();
  }));
  if (!current()) return;
  state.busy = false;
  state.nextRefresh = Date.now() + state.interval * 1000;
  $('refresh').disabled = false;
  $('refresh').querySelector('span').textContent = '立即刷新';
  $('sync-dot').className = 'sync-dot' + (failed ? ' error' : '');
  $('sync-dot').title = latestFetch ? `统计获取时间：${clockFormat.format(latestFetch)}${failed ? '；部分同步失败' : ''}` : '尚未取得统计';
  $('notice').hidden = !failed;
  $('notice').textContent = '部分统计读取失败，请查看各模型的状态提示，或稍后刷新。';
  if (manual) showToast(failed ? '部分统计同步失败' : '关注的模型已刷新');
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { renderScheduled = false; render(); });
}

function getDetail(name) {
  const site = state.sites.find(site => site.id === state.site);
  const hours = state.hours;
  const key = detailKey(name, site, hours);
  const cached = details.get(key);
  if (cached && Date.now() - cached.checkedAt < 30_000) return Promise.resolve(cached);
  if (detailRequests.has(key)) return detailRequests.get(key);
  const promise = new Promise(resolve => detailQueue.push({ key, site, hours, name, resolve }));
  detailRequests.set(key, promise);
  drainDetails();
  return promise;
}

function drainDetails() {
  while (activeDetails < 4 && detailQueue.length) {
    const job = detailQueue.shift();
    const current = state.sites.find(site => site.id === state.site);
    if (job.site?.url !== current?.url || job.hours !== state.hours) {
      detailRequests.delete(job.key); job.resolve({ data: null, error: 'CANCELLED', checkedAt: Date.now() }); continue;
    }
    activeDetails++;
    (async () => {
      let entry;
      try {
        const response = await fetch('/api/detail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ site: { name: job.site.name, url: job.site.url }, hours: job.hours, model: job.name }), signal: AbortSignal.timeout(22_000) });
        const payload = await response.json();
        entry = { ...payload, checkedAt: Date.now(), error: response.ok ? payload.error : payload.error || 'FETCH_FAILED' };
      } catch { entry = { data: null, error: 'FETCH_FAILED', checkedAt: Date.now() }; }
      details.delete(job.key);
      details.set(job.key, entry);
      while (details.size > 256) details.delete(details.keys().next().value);
      detailRequests.delete(job.key);
      activeDetails--;
      job.resolve(entry);
      if (state.sites.find(site => site.id === state.site)?.url === job.site.url && state.hours === job.hours) scheduleRender();
      drainDetails();
    })();
  }
}

function observeGroupRows() {
  historyObserver?.disconnect();
  if (!state.group) return;
  historyObserver ??= new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      historyObserver.unobserve(entry.target);
      const model = state.models.find(model => model.model_name === entry.target.dataset.hydrate);
      if (model?.needsDetail) getDetail(model.model_name);
    }
  }, { rootMargin: '300px' });
  for (const row of document.querySelectorAll('[data-hydrate]')) historyObserver.observe(row);
}

function renderHistory(metric, large = false) {
  if (validSeries(metric?.recent_success_series, now()).length) return history(metric.recent_success_series, state.hours, large);
  const rates = recentRates(metric?.recent_success_rates);
  if (rates.length) return `<div class="history untimed-history" style="grid-template-columns:repeat(${rates.length},minmax(2px,1fr))" role="img" aria-label="最近 ${rates.length} 段成功率，上游未提供时间">${rates.map((rate, index) => `<span class="${rateState(rate)}" title="第 ${index + 1} 段：请求成功率 ${fmt(rate)}%；上游未提供时间"></span>`).join('')}</div><div class="history-caption untimed-caption">最近 ${rates.length} 段 / 未提供时间</div>`;
  return `<span class="history-empty">${metric?.pending ? '正在读取分组记录…' : metric?.unavailable ? '分组记录读取失败' : metric ? '上游未提供历史记录' : '暂无记录'}</span>`;
}

function history(series, hours = state.hours, large = false) {
  const points = validSeries(series, now());
  // Keep missing buckets empty. Do not interpolate or carry a successful point forward.
  let step = 3600;
  for (let i = 1; i < points.length; i++) {
    const distance = points[i].ts - points[i - 1].ts;
    if (distance >= 60 && distance < step) step = distance;
  }
  const slots = Math.min(48, Math.max(1, Math.ceil(hours * 3600 / step)));
  step = Math.max(step, hours * 3600 / slots);
  const end = Math.floor(now() / 1000 / step) * step;
  const start = end - (slots - 1) * step;
  const bins = Array(slots).fill(null);
  for (const point of points) {
    const i = Math.floor((point.ts - start) / step);
    if (i >= 0 && i < slots) bins[i] = point;
  }
  const bars = bins.map((point, i) => {
    const label = fullFormat.format((start + i * step) * 1000);
    const title = point ? `${fullFormat.format(point.ts * 1000)} 统计时段 · 请求成功率 ${fmt(point.success_rate)}%` : `${label} · 无统计记录`;
    return `<span class="${point ? rateState(point.success_rate) : 'unknown'}" title="${escape(title)}" aria-label="${escape(title)}"></span>`;
  }).join('');
  return `<div class="history" style="grid-template-columns:repeat(${slots},minmax(2px,1fr))" role="img" aria-label="最近 ${hours} 小时统计；${points.length ? '悬停查看各统计时段' : '暂无记录'}">${bars}</div><div class="history-caption"><span>${time(start * 1000)}</span><span>${large ? '最近 ' + hours + ' 小时' : ''}</span><span>${time(end * 1000)}</span></div>`;
}

function showToast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { $('toast').hidden = true; }, 2800);
}

function showInfo() {
    $('info-content').innerHTML = `<h2>状态说明</h2><p>${state.interval ? `每 ${state.interval} 秒同步站点公开统计` : '当前已暂停自动同步，可点击“立即刷新”读取统计'}。近期状态根据最近一个统计时段的请求成功率计算，分类阈值由本页面设定。</p><div class="explain-list"><div class="explain-row">${badge('healthy')}<span>最近统计时段的请求成功率 ≥ 95%。</span></div><div class="explain-row">${badge('degraded')}<span>最近统计时段的请求成功率大于 0%、低于 95%。</span></div><div class="explain-row">${badge('failed')}<span>最近统计时段的请求成功率为 0%。</span></div><div class="explain-row">${badge('stale')}<span>最近统计时段的开始时间距现在已满 2 小时。</span></div><div class="explain-row">${badge('untimed')}<span>上游返回了近期成功率，但没有提供记录时间。</span></div><div class="explain-row">${badge('summary')}<span>只有时段汇总，未提供历史记录。</span></div><div class="explain-row">${badge('loading')}<span>分组统计会在模型进入可见区域时读取。</span></div><div class="explain-row">${badge('unknown')}<span>所选时段内没有可用的统计记录。</span></div><div class="explain-row">${badge('interrupted')}<span>读取统计失败，保留上次读取的数据。</span></div></div><p class="info-note">表格中的请求成功率、耗时和速度是所选时段的汇总；“近期状态”按最近一个统计时段判断。统计时段显示的是开始时间，不是最后一次请求时间。页面只读取统计，不发起模型请求。没有近期数据不代表模型不可用。</p>`;
  $('info-dialog').showModal();
}

function renderSites() {
  $('site-count').textContent = state.sites.length;
  $('site-nav').innerHTML = state.sites.map(site => `<button class="site-button${site.id === state.site ? ' active' : ''}" data-site="${escape(site.id)}" ${site.id === state.site ? 'aria-current="true"' : ''}><span class="site-mini-icon">✧</span>${escape(site.name)}<span class="dot"></span></button>`).join('');
  $('mobile-sites').innerHTML = state.sites.map(site => `<option value="${escape(site.id)}" ${site.id === state.site ? 'selected' : ''}>${escape(site.name)}</option>`).join('');
}

function render() {
  if (state.view === 'favorites') { renderFavorites(); return; }
  const data = state.data;
  if (!data) return;
  const referenceNow = now();
  const globalModels = mergeModels(data.catalog.models, data.metrics.models, referenceNow, Boolean(data.metrics.error));
  const groupNames = new Set((data.catalog.groups || []).filter(group => typeof group === 'string' && group));
  for (const model of globalModels) {
    for (const group of Array.isArray(model.enable_groups) ? model.enable_groups : []) if (typeof group === 'string' && group) groupNames.add(group);
    for (const group of details.get(detailKey(model.model_name))?.data?.groups || []) if (typeof group.group === 'string' && group.group) groupNames.add(group.group);
  }
  if (state.group) groupNames.add(state.group);
  const groupScrollTop = $('group-tabs').scrollTop;
  $('group-tabs').innerHTML = [['', '全部分组'], ...[...groupNames].sort((a, b) => a.localeCompare(b)).map(group => [group, group])].map(([group, name]) => `<button class="${state.group === group ? 'active' : ''}" data-group="${escape(group)}" aria-pressed="${state.group === group}">${escape(name)}</button>`).join('');
  $('group-tabs').scrollTop = groupScrollTop;
  state.models = globalModels.filter(model => !state.group || !Array.isArray(model.enable_groups) || model.enable_groups.includes(state.group) || details.get(detailKey(model.model_name))?.data?.groups?.some(group => group.group === state.group)).map((model, scopeIndex) => {
    const entry = details.get(detailKey(model.model_name));
    const expired = !entry || Date.now() - entry.checkedAt >= 30_000;
    const hasGlobalMetric = Boolean(model.metric);
    const selected = state.group ? entry?.data?.groups?.find(group => group.group === state.group) : null;
    const metric = !state.group ? model.metric : selected ? normalizeMetric(selected, referenceNow) : hasGlobalMetric && expired ? { pending: true } : hasGlobalMetric && entry?.error ? { unavailable: true } : undefined;
    const interrupted = Boolean(data.metrics.error || (state.group && entry?.error));
    return { ...model, metric, scopeIndex, hasGlobalMetric, interrupted, needsDetail: Boolean(state.group && hasGlobalMetric && expired), state: classify(metric, referenceNow, interrupted), latest: validSeries(metric?.recent_success_series, referenceNow).at(-1)?.ts ?? null };
  });
  const totalRecorded = state.models.filter(model => model.hasGlobalMetric).length;
  const resolved = state.models.filter(model => model.hasGlobalMetric && details.has(detailKey(model.model_name))).length;
  $('group-progress').textContent = state.group ? `按需读取 ${resolved} / ${totalRecorded} 个模型` : '';
  $('group-progress').title = '只读取当前可见及附近的模型，滚动列表可加载其他分组统计';
  $('station-name').textContent = data.site.name;
  $('station-url').href = data.site.url + '/pricing';
  $('station-url').innerHTML = `${escape(new URL(data.site.url).hostname)} <span aria-hidden="true">↗</span>`;
  const catalogCount = data.catalog.models.length;
  const recordedCount = state.models.filter(model => model.metric && !model.metric.pending && !model.metric.unavailable).length;
  $('nav-total').textContent = state.models.length;
  const latestFetch = data.metrics.fetchedAt;
  $('sync-dot').title = latestFetch ? `统计获取时间：${clockFormat.format(latestFetch)}` : '尚未取得统计';
  $('sync-dot').className = 'sync-dot' + (data.metrics.error || data.catalog.error ? ' error' : '');
  $('station-sync').textContent = `模型列表 ${catalogCount} 个 / ${state.group ? '已读取分组统计' : '有统计'} ${recordedCount} 个`;
  $('summary-scope').textContent = state.group ? '当前分组状态（含待读取）' : '最新统计状态分布';
  const notices = [];
  if (data.metrics.error) notices.push(`模型统计${data.metrics.error === 'AUTH_REQUIRED' ? '需要登录，暂时无法读取' : '同步失败'}。${latestFetch ? '当前展示上次读取的历史数据，状态标记为“同步中断”。' : '暂时没有统计数据，请稍后刷新。'}`);
  if (data.catalog.error) notices.push(`模型列表${data.catalog.error === 'AUTH_REQUIRED' ? '需要登录' : '同步失败'}，当前${data.catalog.fetchedAt ? '保留上次列表' : '仅显示统计接口中出现的模型'}。`);
  $('notice').hidden = !notices.length;
  $('notice').textContent = notices.join(' ');
  const counts = Object.fromEntries(stateOrder.map(key => [key, state.models.filter(m => m.state === key).length]));
  $('distribution').innerHTML = stateOrder.filter(key => counts[key]).map(key => `<span class="${key}" style="flex:${counts[key]}" title="${labels[key]} ${counts[key]} 个"></span>`).join('');
  $('distribution').setAttribute('aria-label', stateOrder.map(key => `${labels[key]} ${counts[key]} 个`).join('，'));
  $('summary-counts').innerHTML = stateOrder.filter(key => !['untimed', 'summary', 'loading', 'interrupted'].includes(key) || counts[key]).map(key => `<button class="summary-stat" data-state="${key}" title="筛选${labels[key]}"><i class="dot ${key}"></i>${labels[key]}<strong>${counts[key]}</strong></button>`).join('') + `<span class="summary-total">共 ${state.models.length} 个模型</span>`;
  const availableFamilies = familyOrder.filter(family => state.models.some(m => m.family === family));
  $('family-tabs').innerHTML = [['all', '全部系列'], ...availableFamilies.map(family => [family, family])].map(([key, text]) => `<button class="${state.family === key ? 'active' : ''}" data-family="${key}" aria-pressed="${state.family === key}">${text}</button>`).join('');
  let models = state.models.filter(model => (!state.recorded || model.metric) && (state.family === 'all' || model.family === state.family) && (state.filter === 'all' || model.state === state.filter || model.metric?.pending) && model.model_name.toLowerCase().includes(state.search.toLowerCase()));
  if (state.sort === 'name') models.sort((a, b) => a.model_name.localeCompare(b.model_name));
  else if (state.sort === 'rate') models.sort((a, b) => (b.metric?.success_rate ?? -1) - (a.metric?.success_rate ?? -1));
  else models.sort((a, b) => {
    if (state.group) return a.scopeIndex - b.scopeIndex;
    const rank = { loading: -1, healthy: 0, degraded: 1, failed: 2, stale: 3, untimed: 4, summary: 5, interrupted: 6, unknown: 7 };
    return rank[a.state] - rank[b.state] || (b.latest ?? 0) - (a.latest ?? 0) || a.model_name.localeCompare(b.model_name);
  });
  $('state-filter').value = state.filter;
  $('model-count').textContent = models.length;
  $('results-description').textContent = `显示 ${models.length} / ${state.models.length} 个模型`;
  $('history-title').textContent = `${state.hours} 小时记录`;
  if (!models.length) {
    const filtered = state.search || state.filter !== 'all' || state.family !== 'all';
    $('model-rows').innerHTML = `<tr><td colspan="8"><div class="empty-state"><span aria-hidden="true">⌕</span><h3>${filtered ? '没有符合筛选的模型' : '这个时段还没有统计记录'}</h3><p>${filtered ? '试试其他名称、系列或状态。' : '可以切换到更长的统计时段，或查看完整模型列表。'}</p><button class="button button-neutral" id="reset-filters">${filtered ? '清除筛选' : '查看全部模型'}</button></div></td></tr>`;
    historyObserver?.disconnect();
    return;
  }
  $('model-rows').innerHTML = models.map(model => {
    const metric = model.metric;
    const rate = metric?.success_rate;
    const rateClass = rateState(rate);
    const rateHtml = finite(rate) && rate >= 0 && rate <= 100 ? `<span class="rate-value ${rateClass}">${rate.toFixed(2)}<span class="unit">%</span></span>` : '<span class="no-value">—</span>';
    const endpoints = model.supported_endpoint_types?.join(' / ');
    return `<tr class="model-row"${model.needsDetail ? ` data-hydrate="${escape(model.model_name)}"` : ''}><td><div class="model-cell">${favoriteButton(model.model_name)}${avatar(model.family)}<div><button class="model-link" data-model="${escape(model.model_name)}" title="${escape(model.model_name)}">${escape(model.model_name)}</button><div class="model-caption">${escape(model.family)}${state.group ? ' / ' + escape(state.group) : endpoints ? ' / ' + escape(endpoints) : ''}</div></div></div></td><td>${badge(model.state)}</td><td>${renderHistory(metric)}</td><td class="numeric">${rateHtml}</td><td class="numeric">${value(finite(metric?.avg_latency_ms) ? metric.avg_latency_ms / 1000 : null, 's')}</td><td class="numeric">${finite(metric?.avg_tps) && metric.avg_tps > 0 ? value(metric.avg_tps, 'tok/s', 1) : '<span class="no-value">—</span>'}</td><td class="time-cell" title="统计时段的开始时间，UTC+8；不是最后一次请求时间">${model.latest ? escape(fullFormat.format(model.latest * 1000)) : '<span class="no-value">—</span>'}</td><td><button class="row-detail" data-model="${escape(model.model_name)}" aria-label="查看 ${escape(model.model_name)} 详情">›</button></td></tr>`;
  }).join('');
  observeGroupRows();
}

async function loadData(manual = false) {
  if (state.view === 'favorites') return loadFavorites(manual);
  if (state.busy || !state.site) return;
  const selectedSite = state.sites.find(site => site.id === state.site);
  if (!selectedSite) return;
  const request = ++state.loadRequest;
  state.busy = true;
  $('refresh').disabled = true;
  $('refresh').querySelector('span').textContent = '同步中';
  $('sync-dot').className = 'sync-dot loading';
  $('sync-dot').title = '正在获取统计';
  try {
    state.controller = new AbortController();
    const response = await fetch('/api/overview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ site: { name: selectedSite.name, url: selectedSite.url }, hours: state.hours }), signal: AbortSignal.any([state.controller.signal, AbortSignal.timeout(22_000)]), cache: 'no-store' });
    if (!response.ok) throw new Error('读取失败');
    const data = await response.json();
    if (request !== state.loadRequest) return;
    state.data = data;
    state.serverTime = data.serverTime;
    state.receivedAt = performance.now();
    render();
    if (manual) showToast(data.metrics.error || data.catalog.error ? '部分数据同步失败，详情见页面提示' : '已读取上游最新统计');
  } catch {
    if (request !== state.loadRequest) return;
    if (state.data) {
      state.data.metrics.error = 'FETCH_FAILED';
      state.data.catalog.error = 'FETCH_FAILED';
      render();
    } else {
      $('model-rows').innerHTML = '<tr><td colspan="8"><div class="empty-state"><span aria-hidden="true">⌁</span><h3>暂时无法读取统计</h3><p>请检查读取服务或站点连接，再点击“立即刷新”重试。</p></div></td></tr>';
      $('station-sync').textContent = '同步失败，稍后重试';
      $('summary-counts').innerHTML = '<span class="loading-text">尚未获取统计数据</span>';
      $('notice').hidden = false;
      $('notice').textContent = '读取服务连接失败。页面将按所选间隔重试，也可以点击“立即刷新”。';
    }
    $('sync-dot').className = 'sync-dot error';
    $('sync-dot').title = '统计同步中断';
  } finally {
    if (request === state.loadRequest) {
      state.busy = false;
      $('refresh').disabled = false;
      $('refresh').querySelector('span').textContent = '立即刷新';
      state.nextRefresh = Date.now() + state.interval * 1000;
    }
  }
}

async function showDetail(modelName) {
  const model = state.models.find(m => m.model_name === modelName);
  if (!model) return;
  const request = ++state.detailRequest;
  const dialog = $('detail-dialog');
  const metric = model.metric;
  const selectedGroup = state.group;
  $('detail-content').innerHTML = `<div class="detail-head">${avatar(model.family)}<div><h2>${escape(model.model_name)}</h2><div class="model-caption">${escape(state.data.site.name)}${state.group ? " / " + escape(state.group) : " / 全部分组"} / ${state.hours} 小时统计</div></div><button class="copy-model" id="copy-model">复制模型名</button></div><p class="detail-intro">${badge(model.state)} <span>以下时间为统计时段的开始时间。</span></p><div class="detail-metrics"><div><span>请求成功率</span><strong>${value(metric?.success_rate, '%')}</strong></div><div><span>平均耗时</span><strong>${value(finite(metric?.avg_latency_ms) ? metric.avg_latency_ms / 1000 : null, 's')}</strong></div><div><span>输出速度</span><strong>${metric?.avg_tps > 0 ? value(metric.avg_tps, 'tok/s', 1) : '—'}</strong></div></div><div class="detail-history">${renderHistory(metric, true)}</div><section class="group-section"><h3>分组统计</h3><div id="detail-groups" class="detail-loading">正在读取各分组统计…</div></section>`;
  if (!dialog.open) dialog.showModal();
  $('copy-model').onclick = async () => {
    try { await navigator.clipboard.writeText(model.model_name); showToast('模型名称已复制'); }
    catch { showToast('无法访问剪贴板，请选择模型名称复制'); }
  };
  try {
    const detail = await getDetail(modelName);
    if (request !== state.detailRequest || !dialog.open) return;
    if (!detail.data) throw new Error('detail missing');
    const groups = detail.data.groups.filter(group => !selectedGroup || group.group === selectedGroup).map(group => ({ ...group, ...normalizeMetric(group, now()) }));
    if (selectedGroup && groups[0]) {
      const group = groups[0];
      const values = dialog.querySelectorAll('.detail-metrics strong');
      values[0].innerHTML = value(group.success_rate, '%');
      values[1].innerHTML = value(finite(group.avg_latency_ms) ? group.avg_latency_ms / 1000 : null, 's');
      values[2].innerHTML = group.avg_tps > 0 ? value(group.avg_tps, 'tok/s', 1) : '—';
      dialog.querySelector('.detail-history').innerHTML = renderHistory(group, true);
      dialog.querySelector('.detail-intro').innerHTML = `${badge(classify(group, now(), Boolean(detail.error)))} <span>以下时间为统计时段的开始时间。</span>`;
    }
    $('detail-groups').className = '';
    $('detail-groups').innerHTML = (detail.error ? '<p class="detail-intro">分组同步失败，下面保留上次读取的数据。</p>' : '') + (groups.length ? groups.map(group => `<div class="group-card"><div class="group-card-heading"><strong>${escape(group.group)}</strong><span>${value(group.success_rate, '%')} 请求成功</span></div>${history(group.series)}<div class="group-stats"><span>平均耗时 <strong>${value(finite(group.avg_latency_ms) ? group.avg_latency_ms / 1000 : null, 's')}</strong></span><span>首 Token 耗时 <strong>${group.avg_ttft_ms > 0 ? value(group.avg_ttft_ms / 1000, 's') : '暂无测量'}</strong></span><span>输出速度 <strong>${group.avg_tps > 0 ? value(group.avg_tps, 'tok/s', 1) : '暂无测量'}</strong></span></div></div>`).join('') : '<p class="detail-intro">这个模型在所选时段内暂无分组统计。</p>');
  } catch {
    if (request === state.detailRequest && dialog.open) $('detail-groups').textContent = '分组统计暂时无法读取，请关闭详情后重新打开。';
  }
}

$('refresh').addEventListener('click', () => loadData(true));
$('search').addEventListener('input', event => { state.search = event.target.value.trim(); render(); });
$('recorded-only').addEventListener('change', event => { state.recorded = event.target.checked; render(); });
$('state-filter').addEventListener('change', event => { state.filter = event.target.value; render(); });
$('sort-name').addEventListener('click', () => { state.sort = state.sort === 'name' ? 'default' : 'name'; render(); });
$('sort-rate').addEventListener('click', () => { state.sort = state.sort === 'rate' ? 'default' : 'rate'; render(); });
$('interval').addEventListener('change', event => { state.interval = Number(event.target.value); state.nextRefresh = Date.now() + state.interval * 1000; });
$('family-tabs').addEventListener('click', event => { const button = event.target.closest('[data-family]'); if (button) { state.family = button.dataset.family; render(); } });
$('group-tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-group]');
  if (!button || state.group === button.dataset.group) return;
  state.group = button.dataset.group;
  state.filter = 'all';
  state.sort = 'default';
  render();
});
$('summary-counts').addEventListener('click', event => {
  const button = event.target.closest('[data-state]');
  if (button) { state.filter = button.dataset.state; state.recorded = false; $('recorded-only').checked = false; render(); }
});
$('window-controls').addEventListener('click', event => {
  const button = event.target.closest('[data-hours]');
  if (!button || state.busy || Number(button.dataset.hours) === state.hours) return;
  state.hours = Number(button.dataset.hours);
  historyObserver?.disconnect();
  if (state.view === 'favorites') {
    for (const item of $('window-controls').children) { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); }
    loadFavorites(); return;
  }
  for (const item of $('window-controls').children) { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); }
  // Clear the previous window immediately so its values cannot be mislabeled.
  state.data = null;
  state.models = [];
  $('model-count').textContent = '—';
  $('station-sync').textContent = '正在读取所选时段';
  $('summary-counts').innerHTML = '<span class="loading-text">正在读取所选时段…</span>';
  $('distribution').innerHTML = '<span class="distribution-loading"></span>';
  $('history-title').textContent = `${state.hours} 小时记录`;
  $('model-rows').innerHTML = '<tr><td colspan="8"><div class="empty-state"><span class="loading-orbit" aria-hidden="true">✧</span><h3>正在切换统计时段</h3></div></td></tr>';
  loadData();
});
$('site-nav').addEventListener('click', event => {
  const button = event.target.closest('[data-site]');
  if (button && (state.view !== 'overview' || state.site !== button.dataset.site)) { siteManager?.rememberSelection(button.dataset.site); selectSite(button.dataset.site); }
});
function selectSite(id) {
  favoriteController?.abort();
  favoriteGeneration++;
  setView('overview');
  state.controller?.abort();
  state.loadRequest++;
  state.detailRequest++;
  state.busy = false;
  state.site = id;
  state.group = '';
  $('group-tabs').scrollTop = 0;
  historyObserver?.disconnect();
  state.data = null;
  state.models = [];
  state.family = 'all';
  state.filter = 'all';
  state.search = '';
  $('search').value = '';
  const site = state.sites.find(site => site.id === state.site);
  renderSites();
  $('notice').hidden = true;
  if (!site) {
    state.site = null;
    $('refresh').disabled = true;
    $('refresh').querySelector('span').textContent = '立即刷新';
    $('station-name').textContent = '尚未添加站点';
    $('station-url').textContent = '';
    $('station-url').removeAttribute('href');
    $('station-sync').textContent = '点击“管理站点”添加';
    $('summary-counts').textContent = '暂无统计';
    $('distribution').innerHTML = '';
    $('nav-total').textContent = '0';
    $('model-count').textContent = '0';
    $('group-tabs').innerHTML = '<button class="active" data-group="" aria-pressed="true">全部分组</button>';
    $('group-progress').textContent = '';
    $('sync-dot').className = 'sync-dot loading';
    $('sync-dot').title = '等待添加站点';
    $('model-rows').innerHTML = '<tr><td colspan="8"><div class="empty-state"><h3>添加一个 API 站点</h3><p>站点列表只保存在当前浏览器。</p><button class="button button-primary" id="empty-add-site">管理站点</button></div></td></tr>';
    return;
  }
  $('station-name').textContent = site.name;
  $('station-url').href = site.url + '/pricing';
  $('station-url').textContent = new URL(site.url).hostname;
  $('station-sync').textContent = '正在读取所选站点';
  $('summary-counts').innerHTML = '<span class="loading-text">正在读取所选站点…</span>';
  $('distribution').innerHTML = '<span class="distribution-loading"></span>';
  $('model-count').textContent = '—';
  $('model-rows').innerHTML = '<tr><td colspan="8"><div class="empty-state"><span class="loading-orbit" aria-hidden="true">✧</span><h3>正在切换站点</h3></div></td></tr>';
  loadData();
}
$('mobile-sites').addEventListener('change', event => { siteManager?.rememberSelection(event.target.value); selectSite(event.target.value); });
$('manage-sites').addEventListener('click', () => siteManager?.open());
$('model-rows').addEventListener('click', event => {
  if (event.target.closest('[data-favorite-overview]')) { selectSite(state.site); return; }
  const favorite = event.target.closest('[data-favorite]');
  if (favorite) {
    const item = state.view === 'favorites' ? favorites.items.find(item => favoriteKey(item) === favorite.dataset.favorite) : currentFavorite(favorite.dataset.favorite);
    if (item) toggleFavorite(item);
    return;
  }
  const open = event.target.closest('[data-favorite-open]');
  if (open) {
    const item = favorites.items.find(item => favoriteKey(item) === open.dataset.favoriteOpen);
    const site = state.sites.find(site => site.url === item?.url);
    if (site) { siteManager?.rememberSelection(site.id); selectSite(site.id); state.group = item.group; state.search = item.model; state.recorded = false; $('search').value = item.model; $('recorded-only').checked = false; }
    return;
  }
  const button = event.target.closest('[data-model]');
  if (button) showDetail(button.dataset.model);
  if (event.target.closest('#reset-filters')) resetFilters();
  if (event.target.closest('#empty-add-site')) siteManager?.open();
});
function resetFilters() {
  state.search = ''; state.family = 'all'; state.filter = 'all'; state.recorded = false;
  $('search').value = ''; $('recorded-only').checked = false; render();
}
$('overview-nav').addEventListener('click', () => { if (state.view === 'favorites') selectSite(state.site); else resetFilters(); });
$('favorites-nav').addEventListener('click', openFavorites);
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => button.dataset.view === 'favorites' ? openFavorites() : selectSite(state.site));
window.addEventListener('hashchange', () => { if (location.hash === '#favorites') openFavorites(); else if (state.view === 'favorites') selectSite(state.site); });
for (const id of ['status-help', 'footer-help']) $(id).addEventListener('click', () => showInfo());
for (const button of document.querySelectorAll('.close-dialog')) button.addEventListener('click', () => button.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => {
  if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); }
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !document.querySelector('dialog[open]')) { event.preventDefault(); (state.view === 'favorites' ? $('favorites-nav') : $('search')).focus(); }
});
document.addEventListener('visibilitychange', () => { updateLiveClock(); if (!document.hidden && state.interval && Date.now() >= state.nextRefresh) loadData(); });
setInterval(() => {
  updateLiveClock();
  // Also age statuses while automatic fetching is paused.
  if (state.view === 'overview' && state.data && state.models.some(model => model.state !== classify(model.metric, now(), model.interrupted))) render();
  if (state.view === 'favorites') {
    let aged = false;
    for (const result of favoriteRows.values()) {
      if (result.state === 'loading' || result.state === 'interrupted') continue;
      const next = classify(result.metric, Date.now());
      if (result.state !== next) { result.state = next; aged = true; }
    }
    if (aged) renderFavorites();
  }
  if (state.interval === 0) { $('next-refresh').textContent = '已暂停自动同步'; return; }
  const remaining = Math.max(0, Math.ceil((state.nextRefresh - Date.now()) / 1000));
  $('next-refresh').textContent = state.busy ? '正在同步…' : `${remaining} 秒后自动同步`;
  if (!document.hidden && !state.busy && (state.site || state.view === 'favorites') && Date.now() >= state.nextRefresh) loadData();
}, 1000);

async function init() {
  try {
    const response = await fetch('/api/sites', { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('sites missing');
    const data = await response.json();
    siteManager = new SiteManager(data.sites, (sites, selectedId) => { state.sites = sites; selectSite(selectedId); });
    state.sites = siteManager.sites;
    const selected = state.sites.find(site => site.url === siteManager.selectedUrl) || state.sites[0];
    selectSite(selected?.id);
    if (initialFavorites) openFavorites();
    if (favorites.error) showToast('关注记录无法读取，请检查浏览器存储设置');
  } catch {
    $('site-nav').innerHTML = '<span class="skeleton-line">站点配置读取失败</span>';
    $('notice').hidden = false;
    $('notice').textContent = '无法读取站点配置，请检查服务后刷新页面。';
    $('model-rows').innerHTML = '<tr><td colspan="8"><div class="empty-state"><h3>暂时无法连接读取服务</h3><p>请确认服务已启动，再刷新页面。</p></div></td></tr>';
    $('refresh').onclick = () => location.reload();
  }
}
const initialFavorites = location.hash === '#favorites';
$('favorites-count').textContent = favorites.items.length;
updateLiveClock();
init();
