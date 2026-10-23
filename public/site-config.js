export const STORAGE_KEY = 'model-observatory.sites.v1';
export const MAX_SITES = 30;

export function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.length > 300) throw new Error('请输入有效的 HTTPS 站点地址。');
  const input = value.trim();
  if (/\s/.test(input)) throw new Error('站点地址不能包含空格。');
  let url;
  try { url = new URL(input); } catch { throw new Error('请输入完整地址，例如 https://api.example.com。'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) throw new Error('仅支持 HTTPS 默认端口，地址中不能包含账号、密码或查询参数。');
  if (!['/', '/pricing', '/pricing/', '/v1', '/v1/'].includes(url.pathname)) throw new Error('请填写站点域名，不要填写具体 API 路径。');
  const host = url.hostname;
  if (host.length > 253 || !host.includes('.') || !/[a-z]/i.test(host) || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) || /(?:^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(host)) throw new Error('请使用公开域名，不支持 IP 地址或内网域名。');
  return url.origin;
}

export function normalizeSite(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('站点格式不正确。');
  const url = normalizeOrigin(raw.url);
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('站点名称请使用 60 字以内的普通文本。');
  return { id, name: name || new URL(url).hostname, url, adapter: 'new-api' };
}

export function validateSiteList(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.sites) || raw.sites.length > MAX_SITES) throw new Error(`请选择本页面导出的配置文件，最多保存 ${MAX_SITES} 个站点。`);
  const urls = new Set();
  return raw.sites.map((site, index) => {
    const result = normalizeSite(site, `local-${index}`);
    if (urls.has(result.url)) throw new Error('配置中有重复的站点地址。');
    urls.add(result.url);
    return result;
  });
}
