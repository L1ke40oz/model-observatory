import { writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const keyTypes = new Set(['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521']);

export function prepareKnownHosts(input, host, port = '22') {
  if (typeof host !== 'string' || !host || host !== host.trim() || (!isIP(host) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))) {
    throw new Error('SSH_HOST must contain only the VPS IP or SSH hostname, without a URL, port or spaces.');
  }
  if (!/^\d{1,5}$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('SSH_PORT must be between 1 and 65535.');
  const target = Number(port) === 22 ? host.toLowerCase() : `[${host.toLowerCase()}]:${Number(port)}`;
  const records = new Set();
  for (const line of String(input || '').replaceAll('\r', '').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const fields = line.trim().split(/\s+/);
    // Accept the server's raw .pub line and existing known_hosts entries.
    // Pin the supplied key to the actual workflow host/port in both cases.
    const offset = keyTypes.has(fields[0]) ? 0 : keyTypes.has(fields[1]) ? 1 : -1;
    if (offset < 0) throw new Error('SSH_KNOWN_HOSTS is malformed. Copy the complete server host public key line from /etc/ssh/ssh_host_ed25519_key.pub.');
    const [type, encoded] = fields.slice(offset, offset + 2);
    if (!encoded || !/^[a-z0-9+/]+={0,2}$/i.test(encoded)) throw new Error('SSH_KNOWN_HOSTS contains an incomplete public key.');
    const wire = Buffer.from(encoded, 'base64');
    const length = wire.length >= 4 ? wire.readUInt32BE(0) : 0;
    if (!length || 4 + length >= wire.length || wire.subarray(4, 4 + length).toString() !== type || wire.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
      throw new Error('SSH_KNOWN_HOSTS contains an invalid or truncated public key. Copy the complete server .pub line.');
    }
    if (type === 'ssh-ed25519' && (wire.length !== 51 || wire.readUInt32BE(15) !== 32)) throw new Error('SSH_KNOWN_HOSTS contains an invalid Ed25519 host key.');
    records.add(`${target} ${type} ${encoded}`);
  }
  if (!records.size) throw new Error('SSH_KNOWN_HOSTS must contain the server host public key.');
  return [...records].join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2]) throw new Error('A known_hosts output file is required.');
    const result = prepareKnownHosts(process.env.SSH_KNOWN_HOSTS, process.env.SSH_HOST, process.env.SSH_PORT || '22');
    writeFileSync(process.argv[2], result, { mode: 0o600 });
  } catch (error) {
    // Deliberately omit secret values from diagnostics.
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
