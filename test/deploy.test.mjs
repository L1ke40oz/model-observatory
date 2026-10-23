import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const revision = 'a'.repeat(40);
const oldImage = `sha256:${'b'.repeat(64)}`;
const script = readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8');
const bash = process.platform === 'win32'
  ? path.join(path.dirname(path.dirname(execFileSync('where.exe', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0])), 'bin', 'bash.exe')
  : 'bash';
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const unixPath = value => value.replaceAll('\\', '/').replace(/^([A-Z]):\//i, (_, drive) => `/${drive.toLowerCase()}/`);

function runDeployment(scenario, requested = revision) {
  const root = mkdtempSync(path.join(tmpdir(), 'observatory-deploy-'));
  const bin = path.join(root, 'bin');
  const app = path.join(root, 'app');
  mkdirSync(bin);
  mkdirSync(path.join(app, '.git'), { recursive: true });
  const log = path.join(root, 'calls.jsonl');
  const mock = path.join(root, 'mock.mjs');
  writeFileSync(mock, `
import {appendFileSync,readFileSync} from 'node:fs';
const [tool,...args]=process.argv.slice(2);
const file=process.env.OBSERVATORY_TEST_LOG;
let calls=[];try{calls=readFileSync(file,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse)}catch{}
appendFileSync(file,JSON.stringify({tool,args})+'\\n');
const mode=process.env.OBSERVATORY_TEST_SCENARIO;
if(tool==='git'){
 if(args[0]==='diff'&&mode==='dirty')process.exit(1);
 if(args[0]==='rev-parse')console.log(mode==='superseded'?'c'.repeat(40):'${revision}');
}
if(tool==='docker'){
 if(args.includes('ps'))console.log('previous-container');
 if(args[0]==='inspect')console.log('${oldImage}');
 if(args.includes('build')&&mode==='build-failed')process.exit(1);
 if(args.includes('up')&&mode==='unhealthy'&&!calls.some(c=>c.tool==='docker'&&c.args.includes('up')))process.exit(1);
}
`);
  for (const tool of ['git', 'docker', 'curl', 'flock']) {
    writeFileSync(path.join(bin, tool), `#!/usr/bin/env bash\nnode ${shellQuote(mock.replaceAll('\\', '/'))} ${shellQuote(tool)} "$@"\n`, { mode: 0o755 });
  }
  const copy = path.join(root, 'deploy.sh');
  writeFileSync(copy, script.replace('observatory_dir=/opt/model-observatory', `observatory_dir=${shellQuote(app.replaceAll('\\', '/'))}`));
  try {
    const result = spawnSync(bash, ['-c', `export PATH=${shellQuote(unixPath(bin))}:"$PATH"; exec bash ${shellQuote(unixPath(copy))}`], {
      env: { ...process.env, SSH_ORIGINAL_COMMAND: requested, OBSERVATORY_TEST_LOG: log, OBSERVATORY_TEST_SCENARIO: scenario },
      encoding: 'utf8', timeout: 20_000,
    });
    let calls = [];
    try { calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
    assert.equal(result.error, undefined, String(result.error));
    return { ...result, calls };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('deployment only rebuilds after main verification and builds before replacing the service', () => {
  const result = runDeployment('healthy');
  assert.equal(result.status, 0, result.stderr);
  const build = result.calls.findIndex(c => c.tool === 'docker' && c.args.includes('build'));
  const start = result.calls.findIndex(c => c.tool === 'docker' && c.args.includes('up'));
  assert.ok(build >= 0 && build < start);
  assert.ok(result.calls.some(c => c.tool === 'curl'));
  assert.match(result.stdout, /Deployed/);
});

test('SSH command injection, outdated commits and local edits never touch Docker', () => {
  for (const [scenario, request, status] of [['healthy', 'main; whoami', 64], ['superseded', revision, 0], ['dirty', revision, 1]]) {
    const result = runDeployment(scenario, request);
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.calls.some(c => c.tool === 'docker'), false);
  }
});

test('a failed image build leaves the running container in place', () => {
  const result = runDeployment('build-failed');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.calls.some(c => c.tool === 'docker' && c.args.includes('up')), false);
});

test('unhealthy deployments restore the previous image and still report failure', () => {
  const result = runDeployment('unhealthy');
  assert.equal(result.status, 1, result.stderr);
  const starts = result.calls.filter(c => c.tool === 'docker' && c.args.includes('up'));
  assert.equal(starts.length, 2);
  assert.ok(starts[1].args.includes('-f'));
  assert.match(result.stderr, /Previous container image restored/);
  assert.equal(result.calls.some(c => c.args.includes('prune') || c.args.includes('reset')), false);
});
