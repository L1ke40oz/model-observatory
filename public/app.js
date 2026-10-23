import { labels, finite, validSeries, rateState, mergeModels, classify } from './model-state.js';
import { SiteManager } from './site-manager.js';
let siteManager;

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
const fullFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const clockFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const stateOrder = ['healthy', 'degraded', 'failed', 'stale', 'unknown', 'interrupted'];
const familyOrder = ['Claude', 'GPT', 'Gemini', 'DeepSeek', 'Qwen', 'GLM', 'Kimi', '其他'];
const symbols = { Claude: '✳', GPT: '◎', Gemini: '✦', DeepSeek: '≈', Qwen: 'Q', GLM: 'G', Kimi: 'K', '其他': '◇' };
const state = { sites: [], site: null, hours: 24, family: 'all', filter: 'all', search: '', recorded: true, sort: 'default', data: null, models: [], busy: false, interval: 30, nextRefresh: 0, serverTime: Date.now(), receivedAt: performance.now(), detailRequest: 0, loadRequest: 0 };
const now = () => state.serverTime + performance.now() - state.receivedAt;
const badge = key => `<span class="state-badge ${key}"><i class="dot"></i>${labels[key]}</span>`;
const fmt = (value, digits = 2) => finite(value) ? value.toFixed(digits).replace(/\.00$/, '') : '—';
function value(value, unit, digits = 2) { return finite(value) && value >= 0 ? `${fmt(value, digits)}<span class="unit">${unit}</span>` : '<span class="no-value">—</span>'; }
const time = ts => finite(ts) ? timeFormat.format(ts) : '—';
const avatar = family => `<span class="model-avatar ${family.toLowerCase()}">${symbols[family] || '◇'}</span>`;

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

function showInfo(kind = 'status') {
  if (kind === 'connect') {
    $('info-content').innerHTML = `<h2>站点接入说明</h2><p>在“管理站点”中填写名称和 HTTPS 站点地址，即可添加提供公开统计接口的 New API 站点。</p><div class="explain-list"><div class="explain-row"><span class="site-mini-icon">＋</span><span>支持添加、编辑和移除站点，无需注册或填写 API Key。</span></div><div class="explain-row"><span class="site-mini-icon">↙</span><span>列表保存在当前浏览器，换设备时可导出、导入配置。</span></div></div><p class="info-note">查询时，站点地址会发送给本站服务器以获取公开统计。服务器不保存用户站点列表。清除浏览器数据会移除本机配置，共用同一浏览器的人可能看到该列表。</p>`;
  } else {
    $('info-content').innerHTML = `<h2>状态说明</h2><p>${state.interval ? `每 ${state.interval} 秒同步站点公开统计` : '当前已暂停自动同步，可点击“立即刷新”读取统计'}。近期状态根据最近一个统计时段的请求成功率计算，分类阈值由本页面设定。</p><div class="explain-list"><div class="explain-row">${badge('healthy')}<span>最近统计时段的请求成功率 ≥ 95%。</span></div><div class="explain-row">${badge('degraded')}<span>最近统计时段的请求成功率大于 0%、低于 95%。</span></div><div class="explain-row">${badge('failed')}<span>最近统计时段的请求成功率为 0%。</span></div><div class="explain-row">${badge('stale')}<span>最近统计时段的开始时间距现在已满 2 小时。</span></div><div class="explain-row">${badge('unknown')}<span>所选时段内没有可用的统计记录。</span></div><div class="explain-row">${badge('interrupted')}<span>读取统计失败，保留上次读取的数据。</span></div></div><p class="info-note">表格中的请求成功率、耗时和速度是所选时段的汇总；“近期状态”按最近一个统计时段判断。统计时段显示的是开始时间，不是最后一次请求时间。页面只读取统计，不发起模型请求。没有近期数据不代表模型不可用。</p>`;
  }
  $('info-dialog').showModal();
}

function renderSites() {
  $('site-count').textContent = state.sites.length;
  $('site-nav').innerHTML = state.sites.map(site => `<button class="site-button${site.id === state.site ? ' active' : ''}" data-site="${escape(site.id)}" ${site.id === state.site ? 'aria-current="true"' : ''}><span class="site-mini-icon">✧</span>${escape(site.name)}<span class="dot"></span></button>`).join('');
  $('mobile-sites').innerHTML = state.sites.map(site => `<option value="${escape(site.id)}" ${site.id === state.site ? 'selected' : ''}>${escape(site.name)}</option>`).join('');
}

function render() {
  const data = state.data;
  if (!data) return;
  const referenceNow = now();
  state.models = mergeModels(data.catalog.models, data.metrics.models, referenceNow, Boolean(data.metrics.error));
  $('station-name').textContent = data.site.name;
  $('station-url').href = data.site.url + '/pricing';
  $('station-url').innerHTML = `${escape(new URL(data.site.url).hostname)} <span aria-hidden="true">↗</span>`;
  const catalogCount = data.catalog.models.length;
  const recordedCount = state.models.filter(model => model.metric).length;
  $('nav-total').textContent = state.models.length;
  const latestFetch = data.metrics.fetchedAt;
  $('sync-label').textContent = latestFetch ? `更新于 ${clockFormat.format(latestFetch)}` : '尚未取得统计';
  $('sync-dot').className = 'sync-dot' + (data.metrics.error || data.catalog.error ? ' error' : '');
  $('station-sync').textContent = `模型列表 ${catalogCount} 个 / 有统计 ${recordedCount} 个`;
  const notices = [];
  if (data.metrics.error) notices.push(`模型统计${data.metrics.error === 'AUTH_REQUIRED' ? '需要登录，暂时无法读取' : '同步失败'}。${latestFetch ? '当前展示上次读取的历史数据，状态标记为“同步中断”。' : '暂时没有统计数据，请稍后刷新。'}`);
  if (data.catalog.error) notices.push(`模型列表${data.catalog.error === 'AUTH_REQUIRED' ? '需要登录' : '同步失败'}，当前${data.catalog.fetchedAt ? '保留上次列表' : '仅显示统计接口中出现的模型'}。`);
  $('notice').hidden = !notices.length;
  $('notice').textContent = notices.join(' ');
  const counts = Object.fromEntries(stateOrder.map(key => [key, state.models.filter(m => m.state === key).length]));
  $('distribution').innerHTML = stateOrder.filter(key => counts[key]).map(key => `<span class="${key}" style="flex:${counts[key]}" title="${labels[key]} ${counts[key]} 个"></span>`).join('');
  $('distribution').setAttribute('aria-label', stateOrder.map(key => `${labels[key]} ${counts[key]} 个`).join('，'));
  $('summary-counts').innerHTML = stateOrder.filter(key => key !== 'interrupted' || counts[key]).map(key => `<button class="summary-stat" data-state="${key}" title="筛选${labels[key]}"><i class="dot ${key}"></i>${labels[key]}<strong>${counts[key]}</strong></button>`).join('') + `<span class="summary-total">共 ${state.models.length} 个模型</span>`;
  const availableFamilies = familyOrder.filter(family => state.models.some(m => m.family === family));
  $('family-tabs').innerHTML = [['all', '全部系列'], ...availableFamilies.map(family => [family, family])].map(([key, text]) => `<button class="${state.family === key ? 'active' : ''}" data-family="${key}" aria-pressed="${state.family === key}">${text}</button>`).join('');
  let models = state.models.filter(model => (!state.recorded || model.metric) && (state.family === 'all' || model.family === state.family) && (state.filter === 'all' || model.state === state.filter) && model.model_name.toLowerCase().includes(state.search.toLowerCase()));
  if (state.sort === 'name') models.sort((a, b) => a.model_name.localeCompare(b.model_name));
  else if (state.sort === 'rate') models.sort((a, b) => (b.metric?.success_rate ?? -1) - (a.metric?.success_rate ?? -1));
  else models.sort((a, b) => {
    const rank = { healthy: 0, degraded: 1, failed: 2, stale: 3, interrupted: 4, unknown: 5 };
    return rank[a.state] - rank[b.state] || (b.latest ?? 0) - (a.latest ?? 0) || a.model_name.localeCompare(b.model_name);
  });
  $('state-filter').value = state.filter;
  $('model-count').textContent = models.length;
  $('results-description').textContent = `显示 ${models.length} / ${state.models.length} 个模型`;
  $('history-title').textContent = `${state.hours} 小时记录`;
  if (!models.length) {
    const filtered = state.search || state.filter !== 'all' || state.family !== 'all';
    $('model-rows').innerHTML = `<tr><td colspan="8"><div class="empty-state"><span aria-hidden="true">⌕</span><h3>${filtered ? '没有符合筛选的模型' : '这个时段还没有统计记录'}</h3><p>${filtered ? '试试其他名称、系列或状态。' : '可以切换到更长的统计时段，或查看完整模型列表。'}</p><button class="button button-neutral" id="reset-filters">${filtered ? '清除筛选' : '查看全部模型'}</button></div></td></tr>`;
    return;
  }
  $('model-rows').innerHTML = models.map(model => {
    const metric = model.metric;
    const rate = metric?.success_rate;
    const rateClass = rateState(rate);
    const rateHtml = finite(rate) && rate >= 0 && rate <= 100 ? `<span class="rate-value ${rateClass}">${rate.toFixed(2)}<span class="unit">%</span></span>` : '<span class="no-value">—</span>';
    const endpoints = model.supported_endpoint_types?.join(' / ');
    return `<tr class="model-row"><td><div class="model-cell">${avatar(model.family)}<div><button class="model-link" data-model="${escape(model.model_name)}" title="${escape(model.model_name)}">${escape(model.model_name)}</button><div class="model-caption">${escape(model.family)}${endpoints ? ' / ' + escape(endpoints) : ''}</div></div></div></td><td>${badge(model.state)}</td><td>${history(metric?.recent_success_series)}</td><td class="numeric">${rateHtml}</td><td class="numeric">${value(finite(metric?.avg_latency_ms) ? metric.avg_latency_ms / 1000 : null, 's')}</td><td class="numeric">${finite(metric?.avg_tps) && metric.avg_tps > 0 ? value(metric.avg_tps, 'tok/s', 1) : '<span class="no-value">—</span>'}</td><td class="time-cell" title="统计时段的开始时间，UTC+8；不是最后一次请求时间">${model.latest ? escape(fullFormat.format(model.latest * 1000)) : '<span class="no-value">—</span>'}</td><td><button class="row-detail" data-model="${escape(model.model_name)}" aria-label="查看 ${escape(model.model_name)} 详情">›</button></td></tr>`;
  }).join('');
}

async function loadData(manual = false) {
  if (state.busy || !state.site) return;
  const selectedSite = state.sites.find(site => site.id === state.site);
  if (!selectedSite) return;
  const request = ++state.loadRequest;
  state.busy = true;
  $('refresh').disabled = true;
  $('refresh').querySelector('span').textContent = '同步中';
  $('sync-dot').className = 'sync-dot loading';
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
    $('sync-label').textContent = '同步中断';
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
  $('detail-content').innerHTML = `<div class="detail-head">${avatar(model.family)}<div><h2>${escape(model.model_name)}</h2><div class="model-caption">${escape(state.data.site.name)} / ${state.hours} 小时统计</div></div><button class="copy-model" id="copy-model">复制模型名</button></div><p class="detail-intro">${badge(model.state)} <span>以下时间为统计时段的开始时间。</span></p><div class="detail-metrics"><div><span>请求成功率</span><strong>${value(metric?.success_rate, '%')}</strong></div><div><span>平均耗时</span><strong>${value(finite(metric?.avg_latency_ms) ? metric.avg_latency_ms / 1000 : null, 's')}</strong></div><div><span>输出速度</span><strong>${metric?.avg_tps > 0 ? value(metric.avg_tps, 'tok/s', 1) : '—'}</strong></div></div><div class="detail-history">${history(metric?.recent_success_series, state.hours, true)}</div><section class="group-section"><h3>分组统计</h3><div id="detail-groups" class="detail-loading">正在读取各分组统计…</div></section>`;
  if (!dialog.open) dialog.showModal();
  $('copy-model').onclick = async () => {
    try { await navigator.clipboard.writeText(model.model_name); showToast('模型名称已复制'); }
    catch { showToast('无法访问剪贴板，请选择模型名称复制'); }
  };
  try {
    const selectedSite = state.sites.find(site => site.id === state.site);
    const response = await fetch('/api/detail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ site: { name: selectedSite.name, url: selectedSite.url }, hours: state.hours, model: modelName }), signal: AbortSignal.timeout(22_000) });
    const detail = await response.json();
    if (request !== state.detailRequest || !dialog.open) return;
    if (!response.ok || !detail.data) throw new Error('detail missing');
    const groups = detail.data.groups;
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
$('summary-counts').addEventListener('click', event => {
  const button = event.target.closest('[data-state]');
  if (button) { state.filter = button.dataset.state; state.recorded = false; $('recorded-only').checked = false; render(); }
});
$('window-controls').addEventListener('click', event => {
  const button = event.target.closest('[data-hours]');
  if (!button || state.busy || Number(button.dataset.hours) === state.hours) return;
  state.hours = Number(button.dataset.hours);
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
  if (button && state.site !== button.dataset.site) { siteManager?.rememberSelection(button.dataset.site); selectSite(button.dataset.site); }
});
function selectSite(id) {
  state.controller?.abort();
  state.loadRequest++;
  state.detailRequest++;
  state.busy = false;
  state.site = id;
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
    $('sync-label').textContent = '等待添加站点';
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
  const button = event.target.closest('[data-model]');
  if (button) showDetail(button.dataset.model);
  if (event.target.closest('#reset-filters')) resetFilters();
  if (event.target.closest('#empty-add-site')) siteManager?.open();
});
function resetFilters() {
  state.search = ''; state.family = 'all'; state.filter = 'all'; state.recorded = false;
  $('search').value = ''; $('recorded-only').checked = false; render();
}
$('overview-nav').addEventListener('click', resetFilters);
for (const id of ['status-help', 'footer-help', 'about']) $(id).addEventListener('click', () => showInfo());
$('connect-help').addEventListener('click', () => showInfo('connect'));
for (const button of document.querySelectorAll('.close-dialog')) button.addEventListener('click', () => button.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => {
  if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); }
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !document.querySelector('dialog[open]')) { event.preventDefault(); $('search').focus(); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.interval && Date.now() >= state.nextRefresh) loadData(); });
setInterval(() => {
  // Also age statuses while automatic fetching is paused.
  if (state.data && state.models.some(model => model.state !== classify(model.metric, now(), Boolean(state.data.metrics.error)))) render();
  if (state.interval === 0) { $('next-refresh').textContent = '已暂停自动同步'; return; }
  const remaining = Math.max(0, Math.ceil((state.nextRefresh - Date.now()) / 1000));
  $('next-refresh').textContent = state.busy ? '正在同步…' : `${remaining} 秒后自动同步`;
  if (!document.hidden && !state.busy && state.site && Date.now() >= state.nextRefresh) loadData();
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
  } catch {
    $('site-nav').innerHTML = '<span class="skeleton-line">站点配置读取失败</span>';
    $('notice').hidden = false;
    $('notice').textContent = '无法读取站点配置，请检查服务后刷新页面。';
    $('model-rows').innerHTML = '<tr><td colspan="8"><div class="empty-state"><h3>暂时无法连接读取服务</h3><p>请确认服务已启动，再刷新页面。</p></div></td></tr>';
    $('refresh').onclick = () => location.reload();
  }
}
init();
