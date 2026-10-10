import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseArguments} from '../src/cli-options.js';
import {collect} from '../src/github.js';

test('standard PR URLs select the same read-only collector target as existing flags', () => {
  for (const args of [
    ['https://github.com/example/acme-widget/pull/42'],
    ['--format', 'html', 'https://github.com/example/acme-widget/pull/42/', '--output', 'report.html'],
    ['--repo', 'example/acme-widget', '--pr', '42']
  ]) {
    const options = parseArguments(args), calls = [];
    assert.equal(options['--repo'], 'example/acme-widget');
    assert.equal(options['--pr'], '42');
    assert.throws(() => collect(options['--repo'], Number(options['--pr']), (endpoint, input) => {
      calls.push({endpoint, input}); return {available: false, error: 'test stops before network'};
    }), /test stops/);
    assert.deepEqual(calls, [{endpoint: 'repos/example/acme-widget/pulls/42', input: undefined}]);
  }
});
test('PR URL validation rejects alternate hosts, credentials, normalization tricks and invalid numbers', () => {
  const urls = [
    'http://github.com/x/y/pull/1', 'https://github.com.evil.test/x/y/pull/1', 'https://example.test/x/y/pull/1',
    'https://user@github.com/x/y/pull/1', 'https://github.com:443/x/y/pull/1', 'https://github.com/x/y/pull/1?query=1',
    'https://github.com/x/y/pull/1#comment', 'https://github.com/x/y/pull/1/files', 'https://github.com/x/y/issues/1',
    'https://github.com/x/y/pull/0', 'https://github.com/x/y/pull/-1', 'https://github.com/x/y/pull/1.5',
    'https://github.com/x/y/pull/1e2', 'https://github.com/x/y/pull/01', 'https://github.com/x/y/pull/9007199254740992',
    'https://github.com/x/../pull/1', 'https://github.com/x/%79/pull/1', 'https://github.com/-x/y/pull/1',
    'https://github.com/x--z/y/pull/1', 'https://github.com/x/y/../y/pull/1', 'https://github.com/x\\y/pull/1',
    'https://github.com/x/y/pull/1\n', ' https://github.com/x/y/pull/1'
  ];
  for (const url of urls) assert.throws(() => parseArguments([url]), /standard https:\/\/github.com/, url);
});
test('CLI rejects conflicts and duplicates before calling GitHub', () => {
  const url = 'https://github.com/example/acme-widget/pull/42';
  for (const option of ['--repo', '--pr', '--snapshot']) {
    const result = spawnSync(process.execPath, ['bin/gh-pr-check-explainer.js', url, option, option === '--pr' ? '42' : 'example/acme-widget'], {encoding: 'utf8'});
    assert.equal(result.status, 2);
    assert.match(result.stderr, /PR URL cannot be combined/);
  }
  assert.throws(() => parseArguments([url, url]), /only one/);
  assert.throws(() => parseArguments(['--repo', 'x/y', '--repo', 'x/y']), /duplicate/);
  assert.throws(() => parseArguments(['--pr', '1e2']), /positive integer/);
  assert.throws(() => parseArguments(['--pr', '42\n']), /positive integer/);
  assert.throws(() => parseArguments([url, '--output']), /Invalid/);
});
test('CLI PR URL reaches gh through a read-only GET, and rejected input makes no request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-explainer-url-'));
  try {
    const calls = join(dir, 'calls.json'), fakeGh = join(dir, 'gh');
    writeFileSync(fakeGh, '#!' + process.execPath + '\n' +
      'require("node:fs").writeFileSync(process.env.PR_URL_TEST_CALLS, JSON.stringify(process.argv.slice(2)));\n' +
      'console.log(JSON.stringify({state: "closed"}));\n', {mode: 0o700});
    const env = {...process.env, PATH: dir + ':' + process.env.PATH, PR_URL_TEST_CALLS: calls};
    const result = spawnSync(process.execPath, ['bin/gh-pr-check-explainer.js', 'https://github.com/example/acme-widget/pull/42', '--format', 'html'], {encoding: 'utf8', env});
    assert.equal(result.status, 2);
    assert.match(result.stderr, /supports open pull requests/);
    assert.deepEqual(JSON.parse(readFileSync(calls)), ['api', '--hostname', 'github.com', '-X', 'GET', 'repos/example/acme-widget/pulls/42']);
    rmSync(calls);
    const invalid = spawnSync(process.execPath, ['bin/gh-pr-check-explainer.js', 'https://github.com.evil.test/example/acme-widget/pull/42'], {encoding: 'utf8', env});
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /standard https:\/\/github.com/);
    assert.throws(() => readFileSync(calls), {code: 'ENOENT'});
  } finally {rmSync(dir, {recursive: true});}
});

test('CLI refuses report/evidence aliases without changing the snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-explainer-test-'));
  try {
    const input = join(dir, 'input.json'), alias = join(dir, 'alias.html');
    const original = readFileSync(new URL('../examples/path-filter.json', import.meta.url));
    writeFileSync(input, original); symlinkSync(input, alias);
    const result = spawnSync(process.execPath, ['bin/gh-pr-check-explainer.js', '--snapshot', input, '--output', alias], {encoding: 'utf8'});
    assert.equal(result.status, 2); assert.match(result.stderr, /different files/); assert.deepEqual(readFileSync(input), original);
    const collision = spawnSync(process.execPath, ['bin/gh-pr-check-explainer.js', '--snapshot', input, '--output', join(dir, 'same.json'), '--save-snapshot', join(dir, 'same.json')], {encoding: 'utf8'});
    assert.equal(collision.status, 2); assert.match(collision.stderr, /different files/);
  } finally {rmSync(dir, {recursive: true});}
});
test('CLI exit codes reflect checks and evidence is retained when analysis fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-explainer-exits-'));
  try {
    const baseline = JSON.parse(readFileSync(new URL('../examples/path-filter.json', import.meta.url)));
    const invoke = snapshot => {const input = join(dir, 'input.json'); writeFileSync(input, JSON.stringify(snapshot)); return spawnSync(process.execPath, ['bin/gh-pr-check-explainer.js', '--snapshot', input, '--format', 'json'], {encoding: 'utf8'});};
    assert.equal(invoke(baseline).status, 1);
    const none = structuredClone(baseline); none.rulesets.checks = []; assert.equal(invoke(none).status, 0);
    const passing = structuredClone(baseline); passing.rulesets.checks[0].appId = 99;
    passing.headChecks.data = [{id: 1, name: 'build', appId: 99, suiteId: 1, sha: passing.pr.headSha, status: 'completed', conclusion: 'success'}];
    assert.equal(invoke(passing).status, 0);
    const unknown = structuredClone(passing); unknown.mergeChecks.available = false; assert.equal(invoke(unknown).status, 2);
    const invalid = structuredClone(baseline); invalid.rulesets.checks[0].context = '';
    const input = join(dir, 'input.json'), saved = join(dir, 'saved.json'); writeFileSync(input, JSON.stringify(invalid)); writeFileSync(saved, 'old', {mode: 0o644});
    const result = spawnSync(process.execPath, ['bin/gh-pr-check-explainer.js', '--snapshot', input, '--save-snapshot', saved], {encoding: 'utf8'});
    assert.equal(result.status, 2); assert.deepEqual(JSON.parse(readFileSync(saved)), invalid);
    if (process.platform !== 'win32') assert.equal(statSync(saved).mode & 0o777, 0o600);
  } finally {rmSync(dir, {recursive: true});}
});
