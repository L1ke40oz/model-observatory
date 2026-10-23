import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeSite } from './public/site-config.js';
import { fetchPublicJson } from './lib/public-request.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const TTL = 30_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 256;
const MAX_CONCURRENT = 12;
const rawSites = JSON.parse(await readFile(path.join(root, 'sites.json'), 'utf8'));
if (!Array.isArray(rawSites) || !rawSites.length) throw new Error('sites.json must contain at least one site');
const sites = rawSites.map(site => {
  const url = new URL(site.url);
  if (!/^[a-z0-9-]{1,64}$/.test(site.id) || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) || site.adapter !== 'new-api') {
    throw new Error('Invalid site configuration');
  }
  return { id: site.id, name: String(site.name), url: url.origin, description: String(site.description || ''), adapter: site.adapter };
});
if (new Set(sites.map(site => site.id)).size !== sites.length) throw new Error('Duplicate site id');
const cache = new Map();
const inflight = new Map();
const overviewInflight = new Map();
const allowedHours = new Set(['1', '6', '24']);
let cacheBytes = 0;
function cachePut(key, entry) {
  if (cache.has(key)) cacheBytes -= cache.get(key).bytes;
  cache.delete(key);
  entry.bytes = entry.payload ? Buffer.byteLength(JSON.stringify(entry.payload)) : 0;
  cache.set(key, entry);
  cacheBytes += entry.bytes;
  for (const [oldKey, old] of cache) {
    if (cache.size <= MAX_CACHE_ENTRIES && cacheBytes <= MAX_CACHE_BYTES && Date.now() - old.checkedAt < 600_000) break;
    cache.delete(oldKey);
    cacheBytes -= old.bytes;
  }
}
const cleanup = setInterval(() => {
  for (const [key, entry] of cache) if (Date.now() - entry.checkedAt >= 600_000) { cache.delete(key); cacheBytes -= entry.bytes; }
}, 60_000);
cleanup.unref();

async function upstream(site, resource) {
  const key = site.url + resource;
  let previous = cache.get(key);
  if (previous && Date.now() - previous.checkedAt >= 600_000) { cacheBytes -= previous.bytes; cache.delete(key); previous = undefined; }
  if (previous && Date.now() - previous.checkedAt < TTL) return previous;
  if (inflight.has(key)) return inflight.get(key);
  if (inflight.size >= MAX_CONCURRENT) return { payload: previous?.payload ?? null, fetchedAt: previous?.fetchedAt ?? null, error: 'BUSY' };
  const pending = (async () => {
    const checkedAt = Date.now();
    try {
      const payload = await fetchPublicJson(site.url, resource, MAX_BYTES);
      if (payload.success !== true || (resource.startsWith('/api/pricing') && !Array.isArray(payload.data)) || (resource.startsWith('/api/perf-metrics/summary') && !Array.isArray(payload.data?.models)) || (resource.startsWith('/api/perf-metrics?') && !Array.isArray(payload.data?.groups))) throw new Error('INVALID_DATA');
      const entry = { payload, checkedAt, fetchedAt: Date.now(), error: null };
      cachePut(key, entry);
      return entry;
    } catch (error) {
      const safeError = /^(UNSAFE_ADDRESS|AUTH_REQUIRED|HTTP_\d{3}|NOT_JSON|RESPONSE_TOO_LARGE|INVALID_DATA)$/.test(error.message) ? error.message : 'FETCH_FAILED';
      const usable = previous?.fetchedAt && Date.now() - previous.fetchedAt < 600_000;
      const entry = { payload: usable ? previous.payload : null, checkedAt, fetchedAt: usable ? previous.fetchedAt : null, error: safeError };
      cachePut(key, entry);
      return entry;
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, pending);
  return pending;
}

async function overview(site, hours) {
  const key = `${site.url}:${hours}`;
  if (overviewInflight.has(key)) return overviewInflight.get(key);
  const pending = (async () => {
    const [catalog, metrics] = await Promise.all([
      upstream(site, '/api/pricing'), upstream(site, `/api/perf-metrics/summary?hours=${hours}`)
    ]);
    const data = {
      site, hours: Number(hours), refreshSeconds: TTL / 1000,
      serverTime: Date.now(),
      catalog: { models: catalog.payload?.data || [], groups: [...new Set([...Object.keys(catalog.payload?.usable_group || {}), ...(catalog.payload?.data || []).flatMap(model => Array.isArray(model.enable_groups) ? model.enable_groups.filter(group => typeof group === 'string') : [])])], fetchedAt: catalog.fetchedAt, error: catalog.error },
      metrics: { models: metrics.payload?.data?.models || [], fetchedAt: metrics.fetchedAt, error: metrics.error }
    };
    return data;
  })().finally(() => overviewInflight.delete(key));
  overviewInflight.set(key, pending);
  return pending;
}

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/model-state.js', ['model-state.js', 'text/javascript; charset=utf-8']],
  ['/site-config.js', ['site-config.js', 'text/javascript; charset=utf-8']],
  ['/site-manager.js', ['site-manager.js', 'text/javascript; charset=utf-8']],
  ['/favorites.js', ['favorites.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
]);
function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}
async function readBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('INVALID_BODY');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2048) throw new Error('INVALID_BODY');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('INVALID_BODY'); }
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, 'http://localhost');
    const proxyRoute = url.pathname === '/api/overview' || url.pathname === '/api/detail';
    if (!['GET', 'HEAD'].includes(req.method) && !(proxyRoute && req.method === 'POST')) return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (url.pathname.startsWith('/api/') && (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host))) return json(res, 403, { error: 'ORIGIN_DENIED' });
    if (url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (url.pathname === '/api/sites') return json(res, 200, { sites, refreshSeconds: TTL / 1000 });
    if (proxyRoute) {
      const body = req.method === 'POST' ? await readBody(req) : null;
      let site;
      try { site = body ? normalizeSite(body.site, 'custom') : sites.find(s => s.id === (url.searchParams.get('site') || sites[0].id)); }
      catch (error) { return json(res, 400, { error: 'INVALID_SITE', message: error.message }); }
      const hours = String(body?.hours ?? url.searchParams.get('hours') ?? '24');
      if (!site || !allowedHours.has(hours)) return json(res, 400, { error: 'INVALID_QUERY' });
      if (url.pathname === '/api/overview') {
        const data = await overview(site, hours);
        return json(res, 200, { ...data, site });
      }
      const model = body?.model ?? url.searchParams.get('model');
      if (typeof model !== 'string' || !model || model.length > 256) return json(res, 400, { error: 'UNKNOWN_MODEL' });
      const current = await overview(site, hours);
      if (!model || model.length > 256 || ![...current.catalog.models, ...current.metrics.models].some(m => m.model_name === model)) return json(res, 400, { error: 'UNKNOWN_MODEL' });
      const data = await upstream(site, `/api/perf-metrics?model=${encodeURIComponent(model)}&hours=${hours}`);
      return json(res, data.payload ? 200 : 502, { model, fetchedAt: data.fetchedAt, error: data.error, data: data.payload?.data ?? null });
    }
    const asset = assets.get(url.pathname);
    if (!asset) return json(res, 404, { error: 'NOT_FOUND' });
    const body = await readFile(path.join(root, 'public', asset[0]));
    res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (!res.headersSent) json(res, error.message === 'INVALID_BODY' ? 400 : 500, { error: error.message === 'INVALID_BODY' ? 'INVALID_BODY' : 'INTERNAL_ERROR' });
    else res.end();
  }
});
server.requestTimeout = 25_000;
server.headersTimeout = 10_000;
server.listen(port, host, () => console.log(`Model observatory: http://${host}:${server.address().port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
