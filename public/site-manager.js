import { MAX_SITES, STORAGE_KEY, normalizeSite, validateSiteList } from './site-config.js';
import { createBackup, mergeBackup, saveBackup } from './backup.js';
import { favoriteKey } from './favorites.js';
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const localId = () => crypto.randomUUID?.() || `local-${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0]}`;

export class SiteManager {
  constructor(defaultSites, onChange, favorites) {
    this.favorites = favorites;
    this.sites = defaultSites.map((site, index) => normalizeSite(site, `local-${index}`));
    this.onChange = onChange;
    this.selectedUrl = this.sites[0]?.url;
    this.storageError = '';
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw !== null) {
        const saved = JSON.parse(raw);
        this.sites = validateSiteList(saved);
        this.selectedUrl = saved.selectedUrl;
      }
    } catch { this.storageError = '无法读取本机配置，暂时显示默认站点。请确认浏览器允许保存网站数据。'; }
    this.dialog = document.getElementById('sites-dialog');
    this.dialog.innerHTML = `<div class="dialog-top"><span class="dialog-eyebrow">本机配置</span><button class="icon-button" id="close-sites" aria-label="关闭站点管理"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><h2>管理站点</h2><p class="detail-intro">列表只保存在当前浏览器，不会保存到服务器。查询时，站点地址会发送给本站服务器以获取公开统计。</p><div class="manager-list" id="manager-list"></div><form id="site-form"><h3 id="site-form-title">添加站点</h3><label for="site-name">名称</label><input id="site-name" maxlength="60" placeholder="例如：我的 API 站点" autocomplete="off"><label for="site-url">站点地址</label><input id="site-url" type="url" required maxlength="300" placeholder="https://api.example.com" autocomplete="off" spellcheck="false"><p class="field-hint">支持提供公开统计的 New API 站点，无需填写 API Key。</p><div class="form-actions"><button class="button button-primary" type="submit" id="save-site">保存站点</button><button class="button button-neutral" type="button" id="cancel-site-edit" hidden>取消编辑</button></div></form><p class="manager-error" id="manager-error" role="alert" hidden></p><div class="backup-actions"><button class="button button-neutral" id="export-sites">导出配置</button><button class="button button-neutral" id="import-sites">导入配置</button><input type="file" id="import-file" accept="application/json,.json" hidden></div><p class="field-hint">清除浏览器数据会移除站点和关注记录。导出包含这两类配置，请自行保管；导入会按站点地址、模型名和分组合并。</p>`;
    document.getElementById('close-sites').onclick = () => this.dialog.close();
    document.getElementById('site-form').onsubmit = event => { event.preventDefault(); this.saveForm(); };
    document.getElementById('cancel-site-edit').onclick = () => this.resetForm();
    document.getElementById('manager-list').onclick = event => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const site = this.sites[Number(button.dataset.index)];
      if (button.dataset.action === 'edit') {
        this.editId = site.id;
        document.getElementById('site-name').value = site.name;
        document.getElementById('site-url').value = site.url;
        document.getElementById('site-form-title').textContent = '编辑站点';
        document.getElementById('cancel-site-edit').hidden = false;
        document.getElementById('site-name').focus();
      } else {
        this.persist(this.sites.filter(item => item !== site), this.selectedUrl === site.url ? undefined : this.selectedUrl);
        this.resetForm();
      }
    };
    document.getElementById('export-sites').onclick = () => {
      const data = JSON.stringify(createBackup(this.sites, this.favorites.items), null, 2);
      const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'model-observatory-sites.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    document.getElementById('import-sites').onclick = () => document.getElementById('import-file').click();
    document.getElementById('import-file').onchange = async event => {
      try {
        const file = event.target.files[0];
        if (!file) return;
        if (file.size > 1024 * 1024) throw new Error('配置文件不能超过 1 MB。');
        const merged = mergeBackup(this.sites, this.favorites.items, JSON.parse(await file.text()), localId);
        if (this.persist(merged.sites, this.selectedUrl, merged.favorites)) this.resetForm();
      } catch (error) { this.error(error instanceof SyntaxError ? '配置文件不是有效的 JSON。' : error.message); }
      finally { event.target.value = ''; }
    };
    this.render();
  }
  error(message) { const el = document.getElementById('manager-error'); el.textContent = message; el.hidden = !message; }
  rememberSelection(id) {
    const selected = this.sites.find(site => site.id === id);
    if (!selected) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, selectedUrl: selected.url, sites: this.sites.map(({ name, url }) => ({ name, url })) }));
      this.selectedUrl = selected.url;
    } catch { this.storageError = '当前浏览器无法保存最近选择的站点，请检查网站存储设置。'; }
  }
  open() { this.resetForm(); this.error(this.storageError); this.render(); this.dialog.showModal(); }
  resetForm() {
    this.editId = null;
    document.getElementById('site-form').reset();
    document.getElementById('site-form-title').textContent = '添加站点';
    document.getElementById('cancel-site-edit').hidden = true;
  }
  render() {
    document.getElementById('manager-list').innerHTML = this.sites.length ? this.sites.map((site, index) => `<div class="manager-site"><div><strong>${escape(site.name)}</strong><span>${escape(site.url)}</span></div><button class="text-button" data-action="edit" data-index="${index}" aria-label="编辑 ${escape(site.name)}">编辑</button><button class="text-button delete-site" data-action="delete" data-index="${index}" aria-label="移除 ${escape(site.name)}">移除</button></div>`).join('') : '<p class="detail-intro">尚未添加站点。</p>';
  }
  persist(sites, selectedUrl, importedFavorites) {
    try {
      if (sites.length > MAX_SITES) throw new Error(`最多保存 ${MAX_SITES} 个站点。`);
      const selected = sites.find(site => site.url === selectedUrl) || sites[0];
      const saved = { version: 1, selectedUrl: selected?.url, sites: sites.map(({ name, url }) => ({ name, url })) };
      if (importedFavorites !== undefined) {
        const valid = saveBackup(localStorage, saved, importedFavorites);
        this.favorites.items = valid;
        this.favorites.keys = new Set(valid.map(favoriteKey));
      } else localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      this.sites = sites;
      this.selectedUrl = selected?.url;
      this.storageError = '';
      this.error(''); this.render(); this.onChange(sites, selected?.id);
      return true;
    } catch (error) { this.error(error.name === 'QuotaExceededError' || error.name === 'SecurityError' ? '浏览器无法保存配置，请允许网站存储或先导出备份。' : error.message); return false; }
  }
  saveForm() {
    try {
      const site = normalizeSite({ name: document.getElementById('site-name').value, url: document.getElementById('site-url').value }, this.editId || localId());
      if (this.sites.some(item => item.url === site.url && item.id !== this.editId)) throw new Error('这个站点已经在列表中。');
      const sites = this.editId ? this.sites.map(item => item.id === this.editId ? site : item) : [...this.sites, site];
      if (this.persist(sites, site.url)) { this.resetForm(); this.dialog.close(); }
    } catch (error) { this.error(error.message); }
  }
}
