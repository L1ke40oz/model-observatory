import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
let child;
let base;
before(async () => {
  child = spawn(process.execPath, ['server.mjs'], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start')), 10_000);
    child.stdout.on('data', data => { const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}`)); });
  });
});
after(() => child?.kill());
const post = (path, data, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
test('personal site registration cannot create a server-side shared list', async () => {
  assert.equal((await post('/api/sites', { site: { url: 'https://private.luminestella.top' } })).status, 405);
  const { sites } = await (await fetch(base + '/api/sites')).json();
  assert.ok(sites.every(site => site.url !== 'https://private.luminestella.top'));
});
test('custom proxy rejects private origins and unsupported paths before making requests', async () => {
  for (const url of ['https://127.0.0.1', 'http://api.luminestella.top', 'https://169.254.169.254', 'https://api.luminestella.top?token=secret']) assert.equal((await post('/api/overview', { site: { url }, hours: 24 })).status, 400);
  assert.equal((await post('/api/overview', { site: { url: 'https://api.luminestella.top' }, hours: 999 })).status, 400);
  assert.equal((await post('/api/overview', { site: { url: 'https://api.luminestella.top' } }, { Origin: 'https://other-site.invalid' })).status, 403);
  assert.equal((await fetch(base + '/api/overview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
});
