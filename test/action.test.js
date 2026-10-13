import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fetchRequest, run} from '../src/action.js';

const WORKFLOW = "name: Build\non:\n  pull_request:\n    paths:\n      - 'src/**'\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n";

// A fake GitHub API for a docs-only PR whose required `build` check comes from a workflow filtered to src/**.
function github({files = ['README.md', 'docs/setup.md'], comments = [], commentStatus = 201, classic = false, workflow = 'build.yml', forbid = null, text = WORKFLOW, baseText = text} = {}) {
  const calls = [];
  const routes = {
    'repos/x/y/pulls/42': {state: 'open', mergeable: true, merge_commit_sha: 'merge', changed_files: files.length, html_url: 'https://github.com/x/y/pull/42',
      head: {sha: 'head', ref: 'topic', repo: {full_name: 'x/y'}}, base: {sha: 'base', ref: 'main', repo: {full_name: 'x/y', html_url: 'https://github.com/x/y'}}},
    // What GITHUB_TOKEN gets: the classic rule is hidden behind a FORBIDDEN error.
    'graphql': {data: {repository: {pullRequest: {baseRef: {branchProtectionRule: null}}}}, errors: [{type: 'FORBIDDEN', message: 'Resource not accessible by integration'}]},
    'repos/x/y/branches/main': {protected: true, commit: {sha: 'base'}, protection: classic ?
      {enabled: true, required_status_checks: {enforcement_level: 'non_admins', contexts: ['build'], checks: [{context: 'build', app_id: null}]}} :
      {enabled: false, required_status_checks: {enforcement_level: 'off', contexts: [], checks: []}}},
    'repos/x/y/rules/branches/main': classic ? [] : [{type: 'required_status_checks', ruleset_id: 7, parameters: {strict_required_status_checks_policy: false, required_status_checks: [{context: 'build'}]}}],
    'repos/x/y/pulls/42/files': files.map(filename => ({filename})),
    'repos/x/y/pulls/42/commits': [{sha: 'head'}],
    'repos/x/y/contents/.github/workflows': [{type: 'file', name: workflow, path: '.github/workflows/' + workflow}],
    ['repos/x/y/contents/.github/workflows/' + workflow]: {encoding: 'base64', size: text.length, content: Buffer.from(text).toString('base64')},
    'repos/x/y/issues/42/comments': comments
  };
  const fetchImpl = async (url, init) => {
    const {pathname, searchParams} = new URL(url);
    const endpoint = decodeURIComponent(pathname.slice(1));
    if (searchParams.get('ref') === 'base' && endpoint.endsWith('.yml')) {
      return Response.json({encoding: 'base64', size: baseText.length, content: Buffer.from(baseText).toString('base64')});
    }
    calls.push({method: init.method, endpoint, body: init.body && JSON.parse(init.body), authorization: init.headers.authorization});
    if (forbid && endpoint.includes(forbid)) return new Response('{}', {status: 403});
    if (endpoint === 'graphql' && init.body.includes('viewer')) return Response.json({data: {viewer: {login: 'github-actions[bot]'}}});
    if (init.method === 'POST' && endpoint !== 'graphql' || init.method === 'PATCH') {
      return new Response(JSON.stringify({id: 1}), {status: commentStatus});
    }
    if (endpoint.endsWith('/check-runs')) return Response.json({check_runs: []});
    if (endpoint === 'repos/x/y/actions/runs') return Response.json({workflow_runs: []});
    if (endpoint.endsWith('/statuses')) return Response.json([]);
    return Object.hasOwn(routes, endpoint) ? Response.json(routes[endpoint]) : new Response('{}', {status: 404});
  };
  return {fetchImpl, calls};
}

function workspace(event = {pull_request: {number: 42}}, inputs = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-check-action-'));
  const paths = {event: join(dir, 'event.json'), summary: join(dir, 'summary.md'), output: join(dir, 'output.txt')};
  writeFileSync(paths.event, JSON.stringify(event));
  writeFileSync(paths.summary, ''); writeFileSync(paths.output, '');
  const env = {'INPUT_GITHUB-TOKEN': 'test-token', INPUT_COMMENT: 'true', 'INPUT_FAIL-ON-STUCK': 'false', GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: paths.event, GITHUB_REPOSITORY: 'x/y', GITHUB_STEP_SUMMARY: paths.summary, GITHUB_OUTPUT: paths.output, ...inputs};
  return {env, paths, read: name => readFileSync(paths[name], 'utf8'), cleanup: () => rmSync(dir, {recursive: true, force: true})};
}

test('fetch requests match the collector interface and never throw', async () => {
  const seen = [];
  const request = fetchRequest('t', async (url, init) => {
    seen.push([url, init.method, init.headers.authorization]);
    if (url.endsWith('/missing')) return new Response('{}', {status: 403});
    if (url.endsWith('/graphql')) return Response.json({errors: [{message: 'bad'}]});
    if (url.endsWith('/offline')) throw new TypeError('fetch failed');
    return Response.json({ok: true});
  });
  assert.deepEqual(await request('repos/x/y'), {available: true, data: {ok: true}});
  assert.deepEqual(await request('repos/x/y/missing'), {available: false, error: 'GitHub API returned HTTP 403.'});
  assert.equal((await request('graphql', {query: 'query{}'})).available, false);
  assert.deepEqual(await request('repos/x/y/offline'), {available: false, error: 'GitHub request failed.'});
  assert.deepEqual(seen[0], ['https://api.github.com/repos/x/y', 'GET', 'Bearer t']);
  assert.equal(seen[2][1], 'POST');
});

test('a required check skipped by a path filter gets a summary, outputs and one PR comment', async () => {
  const api = github(), w = workspace(), lines = [];
  assert.equal(await run({env: w.env, fetchImpl: api.fetchImpl, log: line => lines.push(line)}), 0);
  assert.match(w.read('summary'), /# PR Check Explainer/);
  assert.match(w.read('output'), /^verdict=blocked\nstuck-checks=\["build"\]\n$/);
  const posts = api.calls.filter(call => call.method === 'POST' && call.endpoint !== 'graphql');
  assert.equal(posts.length, 1); assert.equal(posts[0].endpoint, 'repos/x/y/issues/42/comments');
  assert.match(posts[0].body.body, /^<!-- gh-pr-check-explainer -->/);
  assert.match(posts[0].body.body, /\| `build` \| The workflow that reports it does not run for this PR\. The pull_request path filter excludes all 2 changed files\./);
  assert.match(posts[0].body.body, /\[\.github\/workflows\/build\.yml\]\(https:\/\/github\.com\/x\/y\/blob\/head\/\.github\/workflows\/build\.yml#L2\)/);
  assert.ok(lines.some(line => line.startsWith('::warning::Required check "build" will not report')));
  assert.ok(api.calls.every(call => call.authorization === 'Bearer test-token'));
  // Only the comment is written; everything else is a read.
  assert.deepEqual([...new Set(api.calls.map(call => call.method))].sort(), ['GET', 'POST']);
  w.cleanup();
});

test('a check required only by classic branch protection is found with the workflow token', async () => {
  const api = github({classic: true}), w = workspace();
  await run({env: w.env, fetchImpl: api.fetchImpl, log: () => {}});
  assert.match(w.read('output'), /stuck-checks=\["build"\]/);
  assert.ok(api.calls.some(call => call.endpoint === 'repos/x/y/branches/main'));
  w.cleanup();
});
test('the existing comment is updated in place, and marked resolved once nothing is stuck', async () => {
  const existing = {id: 9, user: {login: 'github-actions[bot]'}, body: '<!-- gh-pr-check-explainer -->\nold'};
  // Anyone can post a comment that starts with the marker; only the token's own comment is updated.
  const copy = {id: 5, user: {login: 'someone'}, body: '<!-- gh-pr-check-explainer -->\ncopy'};
  let api = github({comments: [{id: 3, user: {login: 'someone'}, body: 'someone else'}, copy, existing]}), w = workspace();
  await run({env: w.env, fetchImpl: api.fetchImpl, log: () => {}});
  assert.deepEqual(api.calls.filter(call => call.method !== 'GET' && call.endpoint !== 'graphql').map(call => [call.method, call.endpoint]),
    [['PATCH', 'repos/x/y/issues/comments/9']]);
  w.cleanup();
  api = github({files: ['src/index.ts'], comments: [existing]}); w = workspace();
  await run({env: w.env, fetchImpl: api.fetchImpl, log: () => {}});
  const patch = api.calls.find(call => call.method === 'PATCH');
  assert.match(patch.body.body, /No required check is stuck/);
  assert.match(w.read('output'), /stuck-checks=\[\]/);
  w.cleanup();
  api = github({files: ['src/index.ts'], comments: [existing], classic: true}); w = workspace();
  await run({env: w.env, fetchImpl: api.fetchImpl, log: () => {}});
  assert.match(api.calls.find(call => call.method === 'PATCH').body.body, /No required check is stuck/);
  w.cleanup();
});

test('evidence that could not be read never marks an earlier diagnosis resolved', async () => {
  const existing = {id: 9, user: {login: 'github-actions[bot]'}, body: '<!-- gh-pr-check-explainer -->\nold'};
  // A confirmed test-merge commit whose checks can't be read counts; one GitHub hasn't computed yet doesn't.
  for (const [forbid, text, baseText] of [['/check-runs'], ['commits/merge/check-runs'], ['rules/branches'], ['contents/.github'], ['pulls/42/files'],
    ['actions/runs'], [null, 'on: ['], [null, WORKFLOW, 'on: [']]) {
    const api = github({files: ['src/index.ts'], comments: [existing], forbid, text, baseText}), w = workspace();
    await run({env: w.env, fetchImpl: api.fetchImpl, log: () => {}});
    const body = api.calls.find(call => call.method === 'PATCH').body.body;
    assert.match(body, /^<!-- gh-pr-check-explainer -->\n### Required checks\n\nCould not check the required checks for head because some evidence could not be read\./, forbid || text + baseText);
    w.cleanup();
  }
});

test('workflow and file names from the pull request cannot add links to the comment or summary', async () => {
  const api = github({workflow: '[build](http:evil.example)<img>.yml'}), w = workspace();
  await run({env: w.env, fetchImpl: api.fetchImpl, log: () => {}});
  const body = api.calls.find(call => call.method === 'POST' && call.endpoint !== 'graphql').body.body;
  assert.ok(body.includes('[.github/workflows/\\[build\\](http:evil.example)\\<img\\>.yml](https://github.com/x/y/blob/head/.github/workflows/%5Bbuild%5D%28http:evil.example%29%3Cimg%3E.yml#L2)'), body);
  assert.ok(!/[^\\]\[build\]|[^\\]<img>/.test(w.read('summary')));
  w.cleanup();
});

test('nothing is posted when no check is stuck and there is no earlier comment', async () => {
  const api = github({files: ['src/index.ts']}), w = workspace();
  assert.equal(await run({env: w.env, fetchImpl: api.fetchImpl, log: () => {}}), 0);
  assert.ok(api.calls.every(call => call.method === 'GET' || call.endpoint === 'graphql'));
  w.cleanup();
});

test('a read-only fork token warns instead of failing, and comments can be turned off', async () => {
  let api = github({commentStatus: 403}), w = workspace(), lines = [];
  assert.equal(await run({env: w.env, fetchImpl: api.fetchImpl, log: line => lines.push(line)}), 0);
  assert.ok(lines.some(line => line.startsWith('::warning::Could not update the PR comment: GitHub API returned HTTP 403')));
  assert.match(w.read('summary'), /# PR Check Explainer/);
  w.cleanup();
  api = github(); w = workspace(undefined, {INPUT_COMMENT: 'false'});
  await run({env: w.env, fetchImpl: api.fetchImpl, log: () => {}});
  assert.ok(!api.calls.some(call => call.endpoint.includes('/comments')));
  w.cleanup();
});

test('fail-on-stuck fails the job, and events without a pull request make no requests', async () => {
  let api = github(), w = workspace(undefined, {'INPUT_FAIL-ON-STUCK': 'true'}), lines = [];
  assert.equal(await run({env: w.env, fetchImpl: api.fetchImpl, log: line => lines.push(line)}), 1);
  assert.ok(lines.some(line => line.startsWith('::error::1 required check(s) will not report')));
  w.cleanup();
  api = github(); w = workspace({ref: 'refs/heads/main'}, {GITHUB_EVENT_NAME: 'push'}); lines = [];
  assert.equal(await run({env: w.env, fetchImpl: api.fetchImpl, log: line => lines.push(line)}), 0);
  assert.equal(api.calls.length, 0); assert.match(lines[0], /^::warning::.*push has no pull request/);
  w.cleanup();
});

test('the committed Action bundle runs the same code', () => {
  const w = workspace({ref: 'refs/heads/main'}, {GITHUB_EVENT_NAME: 'push'});
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/action.mjs', import.meta.url))], {env: {...w.env, PATH: process.env.PATH}, encoding: 'utf8'});
  assert.equal(result.status, 0); assert.match(result.stdout, /^::warning::PR Check Explainer runs on pull_request/);
  w.cleanup();
});
