import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

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
