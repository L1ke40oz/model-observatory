import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    const [first, second = '0'] = value.split(':');
    // Accept global unicast only; exclude transition and documentation ranges.
    return /^[23]/.test(value) && first !== '2002' && !(first === '2001' && (parseInt(second || '0', 16) <= 0x1ff || second === 'db8')) && first !== '3fff';
  }
  return false;
}

export async function resolvePublicAddress(hostname, lookup = dnsLookup) {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(record => !isPublicAddress(record.address))) throw new Error('UNSAFE_ADDRESS');
  return addresses.find(record => record.family === 4) || addresses[0];
}

export async function fetchPublicJson(origin, resource, maxBytes) {
  const url = new URL(origin);
  const signal = AbortSignal.timeout(15_000);
  // Resolve once, validate every answer, then pin the actual TLS connection to
  // this answer. Never follow redirects or re-resolve between validation/connect.
  const address = await Promise.race([
    resolvePublicAddress(url.hostname),
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('FETCH_FAILED')), { once: true }))
  ]);
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: url.hostname, servername: url.hostname, port: 443,
      method: 'GET', path: resource, signal, agent: false, autoSelectFamily: false,
      lookup: (_host, _options, callback) => callback(null, address.address, address.family),
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'ModelObservatory/0.2' }
    }, response => {
      const fail = message => { response.destroy(); reject(new Error(message)); };
      if (response.statusCode !== 200) return fail(response.statusCode === 401 || response.statusCode === 403 ? 'AUTH_REQUIRED' : `HTTP_${response.statusCode}`);
      if (!response.headers['content-type']?.includes('application/json')) return fail('NOT_JSON');
      if (Number(response.headers['content-length']) > maxBytes) return fail('RESPONSE_TOO_LARGE');
      const chunks = [];
      let size = 0;
      response.on('error', reject);
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) return fail('RESPONSE_TOO_LARGE');
        chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('INVALID_DATA')); }
      });
    });
    request.on('error', reject);
    request.end();
  });
}
