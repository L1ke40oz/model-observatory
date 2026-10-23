import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrigin, normalizeSite, validateSiteList } from '../public/site-config.js';
import { isPublicAddress, resolvePublicAddress } from '../lib/public-request.mjs';

test('site addresses are normalized without retaining paths or credentials', () => {
  assert.equal(normalizeOrigin('https://api.luminestella.top/pricing'), 'https://api.luminestella.top');
  assert.equal(normalizeOrigin('https://api.luminestella.top/v1/'), 'https://api.luminestella.top');
  for (const url of ['http://api.luminestella.top', 'https://user:secret@api.luminestella.top', 'https://api.luminestella.top?key=secret', 'https://api.luminestella.top/#secret', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://server.local', 'https://api.luminestella.top:8443', 'https://api.luminestella.top/v1/chat/completions']) assert.throws(() => normalizeOrigin(url));
});
test('imports are bounded and discard extra fields including keys', () => {
  const result = validateSiteList({ version: 1, sites: [{ name: 'Private', url: 'https://api.luminestella.top', apiKey: 'do-not-store' }] });
  assert.deepEqual(Object.keys(result[0]).sort(), ['adapter', 'id', 'name', 'url']);
  assert.throws(() => validateSiteList({ version: 1, sites: Array(31).fill({ url: 'https://api.luminestella.top' }) }));
  assert.throws(() => validateSiteList({ version: 1, sites: [{ url: 'https://api.luminestella.top' }, { url: 'https://api.luminestella.top/pricing' }] }));
  assert.throws(() => normalizeSite({ name: 'x'.repeat(61), url: 'https://api.luminestella.top' }, 'id'));
  assert.deepEqual(validateSiteList({ version: 1, sites: [] }), []);
});
test('private, reserved, mapped and transition addresses cannot be fetched', () => {
  for (const ip of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.17.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '192.0.0.9', '203.0.113.5', '224.0.0.1', '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001::1', '2001:db8::1', '2002:7f00:1::1', '3fff::1']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '104.21.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(ip), true, ip);
});
test('DNS validation rejects mixed public/private answers and returns the pinned address', async () => {
  await assert.rejects(resolvePublicAddress('api.luminestella.top', async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }]), /UNSAFE_ADDRESS/);
  const result = await resolvePublicAddress('api.luminestella.top', async () => [{ address: '1.1.1.1', family: 4 }]);
  assert.deepEqual(result, { address: '1.1.1.1', family: 4 });
});
