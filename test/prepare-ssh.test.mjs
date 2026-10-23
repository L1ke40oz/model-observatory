import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareKnownHosts } from '../scripts/prepare-ssh.mjs';

const type = Buffer.from('ssh-ed25519');
const size = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const publicKey = Buffer.concat([size(type.length), type, size(32), Buffer.alloc(32, 1)]).toString('base64');
const raw = `ssh-ed25519 ${publicKey} root@server`;

test('raw host public keys match the actual SSH host and default or custom port', () => {
  assert.equal(prepareKnownHosts(raw, '203.0.113.10'), `203.0.113.10 ssh-ed25519 ${publicKey}\n`);
  assert.equal(prepareKnownHosts(raw, '203.0.113.10', '2222'), `[203.0.113.10]:2222 ssh-ed25519 ${publicKey}\n`);
  assert.equal(prepareKnownHosts(raw, 'SSH.EXAMPLE.ORG', '022'), `ssh.example.org ssh-ed25519 ${publicKey}\n`);
  assert.equal(prepareKnownHosts(raw, '2001:db8::1', '2222'), `[2001:db8::1]:2222 ssh-ed25519 ${publicKey}\n`);
});

test('previous entries keep their pinned keys while correcting mismatched IP and port prefixes', () => {
  const wrongPrefix = `[]:observatory_port=incorrect ssh-ed25519 ${publicKey}`;
  assert.equal(prepareKnownHosts(wrongPrefix, '203.0.113.10', '2222'), `[203.0.113.10]:2222 ssh-ed25519 ${publicKey}\n`);
  assert.equal(prepareKnownHosts(`wrong.example.org ${raw}\r\n${raw}\r\n`, '203.0.113.10'), `203.0.113.10 ssh-ed25519 ${publicKey}\n`);
});

test('bad copies, truncated keys and misplaced login private keys fail without echoing their contents', () => {
  for (const value of ['', 'observatory_port=22', '-----BEGIN OPENSSH PRIVATE KEY-----', 'ssh-ed25519 AAAA', `ssh-ed25519 ${publicKey.slice(0, -4)}`]) {
    assert.throws(() => prepareKnownHosts(value, '203.0.113.10'), /SSH_KNOWN_HOSTS/);
  }
  for (const host of ['https://ssh.example.org', 'ssh.example.org:2222', ' ssh.example.org', 'user@ssh.example.org']) assert.throws(() => prepareKnownHosts(raw, host), /SSH_HOST/);
  for (const port of ['0', '65536', 'text']) assert.throws(() => prepareKnownHosts(raw, '203.0.113.10', port), /SSH_PORT/);
});
