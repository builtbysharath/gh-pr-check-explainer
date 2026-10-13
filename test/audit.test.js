import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {audit} from '../src/analyze.js';
import {collectRepository} from '../src/github.js';
import {parseArguments} from '../src/cli-options.js';

const SHA = 'a'.repeat(40);
// YAML accepts JSON, so each `on:` is written as JSON.
const workflow = (on, jobs = ['build']) => 'on: ' + JSON.stringify(on) + '\njobs:\n' +
  jobs.map(id => '  ' + id + ':\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n').join('');
function repo(workflows, {checks = [{context: 'build', appId: 15368}], mergeQueue = false} = {}) {
  return {schemaVersion: 1, kind: 'repository', repository: 'x/y', branch: 'main', sha: SHA, collectedAt: '2026-10-12T00:00:00Z',
    classic: {available: true, checks: []},
    rulesets: {available: true, checks: checks.map(check => ({source: 'x/y ruleset 7', url: 'https://github.com/x/y/rules/7', ...check}))},
    mergeQueue: {available: true, enabled: mergeQueue},
    workflows: {available: true, data: Object.entries(workflows).map(([name, text]) => ({path: '.github/workflows/' + name, text}))}};
}
const check = (report, context = 'build') => report.checks.find(item => item.context === context);
const one = (on, options) => check(audit(repo({'ci.yml': workflow(on)}, options)));

test('a path-filtered required workflow is a risk, and an unfiltered push leaves only forks affected', () => {
  const report = audit(repo({'build.yml': workflow({pull_request: {paths: ['src/**']}})}));
  assert.equal(report.overall, 'risks');
  assert.deepEqual(check(report).codes, ['workflow_path_filtered']);
  assert.match(check(report).details[0], /^The pull_request path filter in \.github\/workflows\/build\.yml skips pull requests that change only other files/);
  assert.ok(check(report).evidence.some(item => item.url === 'https://github.com/x/y/blob/' + SHA + '/.github/workflows/build.yml#L1'));
  assert.match(one({pull_request: {paths: ['src/**']}, push: null}).details[0], /mainly affects pull requests from forks/);
  assert.doesNotMatch(one({pull_request: {paths: ['src/**']}, push: {branches: ['main']}}).details[0], /forks/);
});

test('an unfiltered pull_request trigger is fine, and branch filters are compared with the audited branch', () => {
  for (const on of ['pull_request', ['push', 'pull_request'], {pull_request: null}, {pull_request_target: null},
    {pull_request: {branches: ['main', 'release/**']}}, {pull_request: {'branches-ignore': ['dev']}},
    {pull_request: {types: ['opened', 'synchronize', 'reopened', 'labeled']}}]) {
    const report = audit(repo({'ci.yml': workflow(on)}));
    assert.equal(report.overall, 'ok', JSON.stringify(on));
    assert.deepEqual(check(report).codes, []);
    assert.match(check(report).details[0], /^Reported by \.github\/workflows\/ci\.yml on pull requests\.$/);
  }
  const filtered = one({pull_request: {branches: ['develop']}});
  assert.deepEqual(filtered.codes, ['workflow_branch_filtered']);
  assert.match(filtered.details[0], /excludes main, so pull requests into main never get this check/);
  assert.deepEqual(one({pull_request: {types: ['opened']}}).codes, ['workflow_types_filtered']);
  assert.equal(one({pull_request: {branches: ['ma?n']}}).state, 'unknown');
  // An unknown trigger could cover what a filtered one skips.
  assert.equal(one({pull_request: {paths: ['src/**']}, pull_request_target: {branches: ['[m]ain']}}).state, 'unknown');
});

test('push-only workflows miss fork PRs, and other events never satisfy PR checks', () => {
  assert.deepEqual(one({push: null}).codes, ['workflow_push_only']);
  assert.match(one({push: {branches: ['feature/**']}}).details[0], /pull requests from forks never get this check, and branches outside its push filter don't either/);
  for (const on of [{push: {tags: ['v*']}}, {schedule: [{cron: '0 0 * * *'}]}, 'workflow_dispatch']) {
    const row = one(on);
    assert.deepEqual(row.codes, ['workflow_has_no_pr_event'], JSON.stringify(on));
    assert.match(row.details[0], /^\.github\/workflows\/ci\.yml runs only on .*\. None of these give pull requests a result for this check\.$/);
  }
  // A develop -> main pull request still gets the result of a push to develop.
  const named = one({push: {branches: ['develop']}});
  assert.deepEqual(named.codes, ['workflow_has_no_pr_event']);
  assert.match(named.details[0], /^\.github\/workflows\/ci\.yml runs only on push; its push trigger only runs for the branches develop, so pull requests from any other branch never get a result for this check\.$/);
});

test('workflows that report the same name are ambiguous; reusable and workflow_run copies are not', () => {
  // mastodon/mastodon: format-check.yml and lint-css.yml both have a job named lint.
  const both = audit(repo({'format.yml': workflow('pull_request', ['lint']), 'css.yml': workflow({pull_request: {paths: ['**/*.css']}}, ['lint'])},
    {checks: [{context: 'lint'}]}));
  assert.deepEqual(check(both, 'lint').codes, ['ambiguous_producers']);
  assert.match(check(both, 'lint').details[0], /^Several workflows can report a check with this name: \.github\/workflows\/format\.yml, \.github\/workflows\/css\.yml\. GitHub does not document which/);
  // zed-industries/zed: a workflow_call-only file reports its jobs under the caller's name.
  const reusable = audit(repo({'run.yml': workflow({pull_request: {branches: ['**']}}, ['tests_pass']), 'ext.yml': workflow('workflow_call', ['tests_pass'])},
    {checks: [{context: 'tests_pass', appId: 15368}]}));
  assert.equal(check(reusable, 'tests_pass').state, 'ok');
  const uncalled = audit(repo({'ext.yml': workflow('workflow_call', ['tests_pass'])}, {checks: [{context: 'tests_pass', appId: 15368}]}));
  assert.deepEqual(check(uncalled, 'tests_pass').codes, ['no_producer']);
  // bevyengine/bevy: a workflow_run job named msrv runs on the default branch, not on PR commits.
  const later = audit(repo({'ci.yml': workflow('pull_request', ['msrv']), 'comment.yml': workflow({workflow_run: {workflows: ['CI']}}, ['msrv'])},
    {checks: [{context: 'msrv', appId: 15368}]}));
  assert.equal(check(later, 'msrv').state, 'ok');
  // cilium/cilium: release-branch copies and pushes to listed branches don't run for ordinary PRs into main.
  const copies = audit(repo({'ci.yml': workflow({pull_request_target: {'branches-ignore': ['v1.18']}}), 'ci-v1.18.yml': workflow({pull_request_target: {branches: ['v1.18']}}),
    'preflight.yml': workflow({push: {branches: ['main', 'ft/main/**']}})}));
  assert.equal(check(copies).state, 'ok');
  assert.match(check(copies).details[0], /^Reported by \.github\/workflows\/ci\.yml/);
  assert.deepEqual(check(audit(repo({'a.yml': workflow({push: {branches: ['ft/**']}}), 'b.yml': workflow({push: {branches: ['feature/**']}})}))).codes, ['ambiguous_producers']);
});

test('a merge queue needs merge_group, or a push trigger that covers the queue branch', () => {
  const queued = on => one(on, {mergeQueue: true});
  assert.deepEqual(queued('pull_request').codes, ['merge_queue_not_triggered']);
  assert.match(queued('pull_request').details[0], /^main uses a merge queue, but \.github\/workflows\/ci\.yml has no merge_group trigger, so this check is never reported for queued pull requests and they fail to merge\.$/);
  // GitHub runs push workflows on gh-readonly-queue/ branches (seen on mastodon/mastodon).
  for (const on of [['pull_request', 'merge_group'], {pull_request: null, merge_group: {types: ['checks_requested']}}, {pull_request: null, merge_group: {branches: ['main']}},
    {pull_request: null, push: null}, {pull_request: null, push: {'branches-ignore': ['renovate/*']}}, {pull_request: null, push: {branches: ['**']}}]) {
    assert.equal(queued(on).state, 'ok', JSON.stringify(on));
    assert.match(queued(on).details[0], /on pull requests and in the merge queue\.$/);
  }
  for (const on of [{pull_request: null, push: {branches: ['main']}}, {pull_request: null, push: {branches: ['*']}}, {pull_request: null, push: {tags: ['v*']}}]) {
    assert.deepEqual(queued(on).codes, ['merge_queue_not_triggered'], JSON.stringify(on));
  }
  assert.match(queued({pull_request: null, merge_group: {branches: ['develop']}}).details[0], /the merge_group branch filter in \.github\/workflows\/ci\.yml excludes it/);
  assert.equal(queued({pull_request: null, push: null, merge_group: {branches: ['develop']}}).state, 'ok');
  // A separate merge_group workflow can report the check that ci.yml reports on pull requests.
  const split = files => check(audit(repo(files, {mergeQueue: true})));
  assert.equal(split({'ci.yml': workflow('pull_request'), 'queue.yml': workflow('merge_group')}).state, 'ok');
  const neither = split({'ci.yml': workflow('pull_request'), 'release.yml': workflow({push: {branches: ['release']}})});
  assert.deepEqual(neither.codes, ['merge_queue_not_triggered']);
  assert.match(neither.details[0], /^main uses a merge queue, but none of \.github\/workflows\/ci\.yml, \.github\/workflows\/release\.yml runs for merge groups into it, so/);
  assert.equal(queued({pull_request: null, push: {paths: ['src/**']}}).state, 'unknown');
  assert.deepEqual(queued({pull_request: {paths: ['src/**']}}).codes, ['workflow_path_filtered', 'merge_queue_not_triggered']);
});

test('a missing producer is a risk only when the check must come from GitHub Actions', () => {
  const missing = (checks, workflows = {'other.yml': workflow('pull_request', ['test'])}) => check(audit(repo(workflows, {checks})));
  assert.deepEqual(missing([{context: 'build', appId: 15368}]).codes, ['no_producer']);
  assert.match(missing([{context: 'build', appId: 15368}]).details[0], /^No workflow on main has a job that reports this name/);
  const external = missing([{context: 'build'}]);
  assert.equal(external.state, 'unknown');
  assert.match(external.details[0], /It may come from another app or a commit status\.$/);
  const dynamic = {'other.yml': 'on: pull_request\njobs:\n  build:\n    strategy:\n      matrix: ${{ fromJSON(inputs.m) }}\n    runs-on: x\n    steps: [{run: a}]\n'};
  assert.equal(missing([{context: 'build', appId: 15368}], dynamic).state, 'unknown');
  assert.match(missing([{context: 'build', appId: 15368}], dynamic).details[0], /a job name that could not be expanded/);
});

test('checks from other apps are not compared, and unpinned risks say another service could report them', () => {
  const report = audit(repo({'ci.yml': workflow({pull_request: {paths: ['src/**']}})}, {checks: [{context: 'Vercel', appId: 8329}, {context: 'build'}]}));
  assert.equal(check(report, 'Vercel').state, 'not_checked');
  assert.deepEqual(report.checks.map(item => item.context), ['build', 'Vercel']);
  assert.match(check(report).details.at(-1), /accepts this name from any app or commit status/);
  assert.equal(audit(repo({'ci.yml': workflow('pull_request')}, {checks: [{context: 'Vercel', appId: 8329}, {context: 'build'}]})).overall, 'ok');
});

test('unreadable policies, workflows or merge queue state make the audit incomplete', () => {
  const queue = repo({'ci.yml': workflow('pull_request')});
  queue.mergeQueue = {available: false, error: 'GitHub GraphQL did not return a complete result.'};
  assert.equal(audit(queue).overall, 'unknown');
  assert.ok(audit(queue).limitations.includes('mergeQueue: GitHub GraphQL did not return a complete result.'));
  const workflows = repo({});
  workflows.workflows = {available: false, error: 'GitHub API returned HTTP 403.'};
  assert.equal(check(audit(workflows)).state, 'unknown');
  assert.equal(audit(repo({}, {checks: []})).overall, 'none');
  const policy = repo({}, {checks: []});
  policy.classic = {available: false, error: 'No classic rule was returned.'};
  assert.equal(audit(policy).overall, 'unknown');
  assert.throws(() => audit({schemaVersion: 1, repository: 'x/y', pr: {number: 1}}), /repository snapshot/);
});

function api({rules = [], queue = {data: {repository: {mergeQueue: null}}}} = {}) {
  const text = workflow({pull_request: {paths: ['src/**']}});
  const routes = {
    'repos/x/y': {default_branch: 'main', html_url: 'https://github.com/x/y'},
    'repos/x/y/branches/main': {protected: true, commit: {sha: SHA}, protection: {enabled: true,
      required_status_checks: {enforcement_level: 'everyone', contexts: ['build'], checks: [{context: 'build', app_id: 15368}]}}},
    'repos/x/y/rules/branches/main?per_page=100&page=1': rules,
    ['repos/x/y/contents/.github/workflows?ref=' + SHA]: [{type: 'file', name: 'build.yml', path: '.github/workflows/build.yml'}],
    ['repos/x/y/contents/.github/workflows/build.yml?ref=' + SHA]: {encoding: 'base64', size: text.length, content: Buffer.from(text).toString('base64')}
  };
  const calls = [];
  const request = async (endpoint, input) => {
    calls.push({endpoint, method: input ? 'POST' : 'GET'});
    if (endpoint === 'graphql') return queue ? {available: true, data: queue} : {available: false, error: 'GitHub GraphQL did not return a complete result.'};
    return Object.hasOwn(routes, endpoint) ? {available: true, data: routes[endpoint]} : {available: false, error: 'GitHub API returned HTTP 404.'};
  };
  return {request, calls};
}

test('the collector reads the default branch rules, merge queue and workflows without writing anything', async () => {
  const {request, calls} = api({rules: [{type: 'merge_queue', ruleset_id: 3, parameters: {}},
    {type: 'required_status_checks', ruleset_id: 3, parameters: {required_status_checks: [{context: 'lint'}]}}]});
  const snapshot = await collectRepository('x/y', undefined, request);
  assert.equal(snapshot.branch, 'main'); assert.equal(snapshot.sha, SHA);
  assert.deepEqual(snapshot.mergeQueue, {available: true, enabled: true});
  const report = audit(snapshot);
  assert.deepEqual(check(report).codes, ['workflow_path_filtered', 'merge_queue_not_triggered']);
  assert.equal(check(report).url, 'https://github.com/x/y/settings/branches');
  assert.equal(check(report, 'lint').state, 'unknown');
  assert.deepEqual(calls.filter(call => call.method !== 'GET').map(call => call.endpoint), ['graphql']);
  // Classic protection's merge queue only shows up in GraphQL.
  assert.deepEqual((await collectRepository('x/y', 'main', api({queue: {data: {repository: {mergeQueue: {id: 'MQ_1'}}}}}).request)).mergeQueue, {available: true, enabled: true});
  assert.deepEqual((await collectRepository('x/y', 'main', api().request)).mergeQueue, {available: true, enabled: false});
  assert.equal((await collectRepository('x/y', 'main', api({queue: null}).request)).mergeQueue.available, false);
});

test('invalid audit targets make no request', async () => {
  let requests = 0;
  const count = () => {requests++;};
  await assert.rejects(() => collectRepository('x/y;echo bad', undefined, count), /--audit OWNER\/REPO/);
  for (const branch of ['', 'a b', 'a\nb', 'a~b', 'x'.repeat(256)]) {
    await assert.rejects(() => collectRepository('x/y', branch, count), /valid branch name/, JSON.stringify(branch));
  }
  assert.equal(requests, 0);
  await assert.rejects(() => collectRepository('x/y', 'nope', api().request), /Could not read branch nope: GitHub API returned HTTP 404/);
});

test('audit options exclude PR targets, and audit snapshots run through the CLI', () => {
  assert.deepEqual(parseArguments(['--audit', 'x/y', '--branch', 'release/1.x']), {'--audit': 'x/y', '--branch': 'release/1.x'});
  for (const args of [['--audit', 'x/y', '--pr', '1'], ['--audit', 'x/y', '--repo', 'x/y'], ['--audit', 'x/y', 'https://github.com/x/y/pull/1'], ['--audit', 'x/y', '--snapshot', 'f.json']]) {
    assert.throws(() => parseArguments(args), /--audit cannot be combined/, args.join(' '));
  }
  assert.throws(() => parseArguments(['--branch', 'main']), /--branch needs --audit/);
  const dir = mkdtempSync(join(tmpdir(), 'pr-explainer-audit-'));
  try {
    const input = join(dir, 'audit.json');
    writeFileSync(input, JSON.stringify(repo({'ci.yml': workflow({pull_request: {paths: ['src/**']}})})));
    const cli = (...args) => spawnSync(process.execPath, ['bin/gh-pr-check-explainer.js', ...args], {encoding: 'utf8', env: {PATH: dir}});
    const text = cli('--snapshot', input);
    assert.equal(text.status, 1, text.stderr);
    assert.match(text.stdout, /^# PR Check Explainer audit\n\nx\/y · main at a{40}\n\nSome required checks can get stuck\n/);
    assert.match(text.stdout, /\n## build: risk\n\n- The pull_request path filter/);
    assert.equal(JSON.parse(cli('--snapshot', input, '--format', 'json').stdout).checks[0].codes[0], 'workflow_path_filtered');
    // HTML is refused before any request; PATH has no gh.
    for (const args of [['--snapshot', input, '--format', 'html'], ['--audit', 'x/y', '--format', 'html']]) {
      const result = cli(...args);
      assert.equal(result.status, 2); assert.match(result.stderr, /Audit reports support text, markdown and json/);
    }
  } finally {rmSync(dir, {recursive: true});}
});
