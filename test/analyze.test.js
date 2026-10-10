import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {analyze} from '../src/analyze.js';
import {html} from '../src/render.js';
import {collect} from '../src/github.js';

const fixture = JSON.parse(readFileSync(new URL('../examples/path-filter.json', import.meta.url), 'utf8'));
const fresh = () => structuredClone(fixture);
function passing(snapshot, overrides = {}) {
  snapshot.headChecks.data = [{id: 1, name: 'build', status: 'completed', conclusion: 'success',
    sha: snapshot.pr.headSha, suiteId: 10, appId: 15368, appSlug: 'github-actions',
    url: 'https://github.com/example/acme-widget/actions/runs/1', ...overrides}];
  snapshot.runs.data = [{suiteId: 10, event: 'pull_request', path: '.github/workflows/build.yml'}];
}

test('explains the documented docs-only PR blocked by a src path filter', () => {
  const report = analyze(fresh());
  assert.equal(report.overall, 'blocked');
  assert.equal(report.checks[0].code, 'workflow_filtered');
  assert.ok(report.checks[0].details.some(detail => detail.includes('excludes all 2 changed files')));
  assert.ok(report.checks[0].evidence.some(item => item.url?.endsWith('#L2')));
});
test('a matching path does not get diagnosed as filtered', () => {
  const s = fresh(); s.files.data = ['src/index.ts'];
  assert.equal(analyze(s).checks[0].code, 'required_check_missing');
});
test('GitHub question-mark and embedded double-star filters remain unsupported', () => {
  for (const pattern of ['docs?/**', '**.js']) {
    const s = fresh(); s.workflows.data[0].text = s.workflows.data[0].text.replace('src/**', pattern);
    assert.equal(analyze(s).checks[0].code, 'required_check_missing');
    assert.ok(analyze(s).checks[0].details.some(detail => detail.includes('cannot be fully evaluated')));
  }
});
test('push path filters are not evaluated from the PR diff', () => {
  const s = fresh(); s.workflows.data[0].text = s.workflows.data[0].text.replace('pull_request:', 'push:');
  assert.equal(analyze(s).checks[0].code, 'required_check_missing');
});
test('an absent suite identity cannot borrow another Actions event', () => {
  const s = fresh(); passing(s); delete s.headChecks.data[0].suiteId; delete s.runs.data[0].suiteId;
  assert.equal(analyze(s).checks[0].code, 'workflow_event_unobserved');
});
test('ordered negative patterns can be re-included', () => {
  const s = fresh(); s.files.data = ['src/docs/guide.md'];
  s.workflows.data[0].text = s.workflows.data[0].text.replace("- 'src/**'", "- 'src/**'\n      - '!src/docs/**'\n      - 'src/docs/guide.md'");
  assert.equal(analyze(s).checks[0].code, 'required_check_missing');
});
test('an eligible push event prevents a false filtered-workflow diagnosis', () => {
  const s = fresh(); s.workflows.data[0].text = s.workflows.data[0].text.replace('on:', 'on:\n  push:');
  assert.equal(analyze(s).checks[0].code, 'required_check_missing');
});
test('an unsupported filter is reported as unobserved, not guessed', () => {
  const s = fresh(); s.workflows.data[0].text = s.workflows.data[0].text.replace('src/**', 'src/{a,b}/**');
  const row = analyze(s).checks[0];
  assert.equal(row.code, 'required_check_missing');
  assert.ok(row.details.some(detail => detail.includes('cannot be fully evaluated')));
});
test('large or truncated diffs cannot establish a filter explanation', () => {
  const s = fresh(); s.files.truncated = true;
  assert.equal(analyze(s).checks[0].code, 'required_check_missing');
});
test('a skipped job is a successful required check', () => {
  const s = fresh(); passing(s, {conclusion: 'skipped'});
  assert.equal(analyze(s).overall, 'satisfied');
});
test('a completed failed check is a blocker', () => {
  const s = fresh(); passing(s, {conclusion: 'failure'});
  assert.equal(analyze(s).checks[0].code, 'check_failed');
});
test('a green workflow_dispatch job cannot satisfy an ordinary PR requirement', () => {
  const s = fresh(); passing(s); s.runs.data[0].event = 'workflow_dispatch';
  assert.equal(analyze(s).checks[0].code, 'ineligible_workflow_event');
});
test('unknown Actions event does not produce a passing verdict', () => {
  const s = fresh(); passing(s); s.runs.data = [];
  assert.equal(analyze(s).overall, 'unknown');
});
test('same name from the wrong GitHub App explains a blocked check', () => {
  const s = fresh(); passing(s, {appId: 999, appSlug: 'other-ci'});
  assert.equal(analyze(s).checks[0].code, 'wrong_reporting_app');
});
test('a commit status has an unknown source when the rule requires an App', () => {
  const s = fresh(); s.headStatuses.data = [{context: 'build', state: 'success'}];
  assert.equal(analyze(s).overall, 'unknown');
});
test('a matching commit status without an App constraint can satisfy the rule', () => {
  const s = fresh(); s.rulesets.checks[0].appId = null;
  s.headStatuses.data = [{context: 'build', state: 'success'}];
  assert.equal(analyze(s).overall, 'satisfied');
});
test('a pending commit status still blocks a same-named passing check', () => {
  const s = fresh(); s.rulesets.checks[0].appId = null; passing(s, {appSlug: 'other-ci'});
  s.headStatuses.data = [{context: 'build', state: 'pending'}];
  assert.equal(analyze(s).checks[0].code, 'commit_status_not_passed');
});
test('a passing check on the previous commit does not satisfy the current commit', () => {
  const s = fresh(); s.previousChecks.data = [{name: 'build', sha: 'old', appId: 15368, conclusion: 'success'}];
  assert.equal(analyze(s).checks[0].code, 'passed_on_other_commit');
});
test('test-merge results take precedence over head results', () => {
  const s = fresh(); passing(s); s.pr.mergeSha = 'merge';
  s.mergeChecks.data = [{id: 5, name: 'other-job', sha: 'merge', appId: 15368, status: 'completed', conclusion: 'success'}];
  const report = analyze(s);
  assert.equal(report.evaluatedSha, 'merge');
  assert.equal(report.checks[0].code, 'passed_on_other_commit');
});
test('unreadable test-merge results cannot be substituted with a confident head verdict', () => {
  const s = fresh(); s.mergeChecks = {available: false, error: 'HTTP 403'};
  assert.equal(analyze(s).overall, 'unknown');
});
test('missing policy access cannot become a no-requirements verdict', () => {
  const s = fresh(); s.rulesets = {available: false, error: 'HTTP 403'};
  assert.equal(analyze(s).overall, 'unknown');
});
test('a job rename is connected to the base branch producer', () => {
  const s = fresh(); s.baseWorkflows = structuredClone(s.workflows);
  s.workflows.data[0].text = s.workflows.data[0].text.replace('  build:', '  verify:');
  assert.equal(analyze(s).checks[0].code, 'job_removed_or_renamed');
});
test('a dynamic producer prevents a confident rename diagnosis', () => {
  const s = fresh(); s.baseWorkflows = structuredClone(s.workflows);
  s.workflows.data[0].text = s.workflows.data[0].text.replace('  build:', "  verify:\n    name: '$" + "{{ matrix.label }}'");
  assert.equal(analyze(s).checks[0].code, 'required_check_missing');
});
test('independent suites with duplicate names remain ambiguous', () => {
  const s = fresh(); passing(s);
  s.headChecks.data.push({...s.headChecks.data[0], id: 2, suiteId: 20});
  assert.equal(analyze(s).checks[0].code, 'ambiguous_check_name');
});
test('a newer run in the same suite supersedes its older failed run', () => {
  const s = fresh(); passing(s);
  s.headChecks.data.push({...s.headChecks.data[0], id: 0, conclusion: 'failure'});
  assert.equal(analyze(s).overall, 'satisfied');
});
test('malformed workflow YAML is surfaced as incomplete explanation coverage', () => {
  const s = fresh(); s.workflows.data[0].text = 'jobs: [invalid';
  assert.ok(analyze(s).limitations.some(item => item.includes('.github/workflows/build.yml')));
});
test('HTML output escapes repository, context, evidence and unsafe links', () => {
  const report = analyze(fresh()); report.repository = '<script>alert(1)</script>';
  report.checks[0].context = '</h2><img src=x onerror=alert(1)>';
  report.checks[0].evidence.push({label: '<svg onload=alert(1)>', url: 'javascript:alert(1)'});
  const output = html(report);
  assert.ok(output.includes('&lt;script&gt;'));
  assert.ok(!output.includes('<script>alert(1)</script>'));
  assert.ok(!output.includes('href="javascript:'));
});
test('invalid repository input causes no request', () => {
  let requests = 0;
  assert.throws(() => collect('x/y;echo bad', 1, () => {requests++;}), /OWNER\/REPO/);
  assert.equal(requests, 0);
});
test('collector handles API failures without ever making mutation calls', () => {
  const calls = [];
  const request = (endpoint, input) => {
    calls.push({endpoint, input});
    if (endpoint.endsWith('/pulls/42')) return {available: true, data: {
      state: 'open', head: {sha: 'head', ref: 'topic', repo: {full_name: 'example/acme-widget'}},
      base: {sha: 'base', ref: 'main', repo: {full_name: 'example/acme-widget', html_url: 'https://github.com/example/acme-widget'}},
      changed_files: 0, merge_commit_sha: null
    }};
    return {available: false, error: 'HTTP 403'};
  };
  const report = analyze(collect('example/acme-widget', 42, request));
  assert.equal(report.overall, 'unknown');
  assert.ok(calls.every(call => !call.input || call.endpoint === 'graphql' && call.input.query.startsWith('query(')));
});
test('an external App requirement is not explained by an Actions filter', () => {
  const s = fresh(); s.rulesets.checks[0].appId = 99;
  assert.equal(analyze(s).checks[0].code, 'required_check_missing');
});
test('base-context pull_request_target jobs do not produce a head rename diagnosis', () => {
  const s = fresh(); s.baseWorkflows = structuredClone(s.workflows);
  s.baseWorkflows.data[0].text = s.baseWorkflows.data[0].text.replace('pull_request:', 'pull_request_target:');
  s.workflows.data = [];
  assert.equal(analyze(s).checks[0].code, 'required_check_missing');
});
test('fork workflow evidence links identify its source repository', () => {
  const s = fresh(); s.workflows.data[0].repository = 'fork/example';
  assert.ok(analyze(s).checks[0].evidence.some(item => item.url?.includes('github.com/fork/example/blob/')));
});
test('draft context is visible without treating a missing result as a failed job or a pass', () => {
  const s = fresh(); s.pr.draft = true;
  const report = analyze(s);
  assert.equal(report.overall, 'blocked'); assert.equal(report.draft, true);
  assert.ok(report.limitations.some(note => note.includes('not a failed job')));
  assert.ok(html(report).includes('<strong>Draft PR</strong>'));
});
test('missing required classic-check parameters remain unknown', () => {
  const request = endpoint => {
    if (endpoint.endsWith('/pulls/42')) return {available: true, data: {state: 'open', head: {sha: 'head', ref: 'topic', repo: {full_name: 'x/y'}}, base: {sha: 'base', ref: 'main', repo: {full_name: 'x/y', html_url: 'https://github.com/x/y'}}, changed_files: 0}};
    if (endpoint === 'graphql') return {available: true, data: {data: {repository: {pullRequest: {baseRef: {branchProtectionRule: {requiresStatusChecks: true}}}}}}};
    return {available: false, error: 'Unavailable'};
  };
  assert.equal(collect('x/y', 42, request).classic.available, false);
});
test('missing ruleset-check parameters remain unknown', () => {
  const request = endpoint => {
    if (endpoint.endsWith('/pulls/42')) return {available: true, data: {state: 'open', head: {sha: 'head', ref: 'topic', repo: {full_name: 'x/y'}}, base: {sha: 'base', ref: 'main', repo: {full_name: 'x/y', html_url: 'https://github.com/x/y'}}, changed_files: 0}};
    if (endpoint.includes('/rules/branches/')) return {available: true, data: [{type: 'required_status_checks'}]};
    return {available: false, error: 'Unavailable'};
  };
  assert.equal(collect('x/y', 42, request).rulesets.available, false);
});
function collectorFixture(overrides = {}) {
  return endpoint => {
    if (endpoint.endsWith('/pulls/42')) return {available: true, data: {state: 'open', mergeable: true, merge_commit_sha: 'merge', head: {sha: 'head', ref: 'topic', repo: {full_name: 'x/y'}}, base: {sha: 'base', ref: 'main', repo: {full_name: 'x/y', html_url: 'https://github.com/x/y'}}, changed_files: 0, ...overrides}};
    if (endpoint === 'graphql') return {available: true, data: {data: {repository: {pullRequest: {baseRef: {branchProtectionRule: null}}}}}};
    if (endpoint.endsWith('/branches/main')) return {available: true, data: {protected: overrides.protected ?? true, commit: {sha: 'current-base-tip'}}};
    if (endpoint.includes('/check-runs')) return {available: true, data: {check_runs: []}};
    if (endpoint.includes('/actions/runs')) return {available: true, data: {workflow_runs: []}};
    if (endpoint.includes('/contents/')) return {available: true, data: []};
    return {available: true, data: []};
  };
}
test('a null classic rule on a protected branch cannot become a confident no-requirements verdict', () => {
  const s = collect('x/y', 42, collectorFixture()); assert.equal(s.classic.available, false); assert.equal(analyze(s).overall, 'unknown');
  const unprotected = collect('x/y', 42, collectorFixture({protected: false})); assert.equal(unprotected.classic.available, true); assert.equal(analyze(unprotected).overall, 'none');
});
test('an unknown or conflicting mergeability cannot use a stale merge SHA', () => {
  for (const mergeable of [null, false]) {
    const s = collect('x/y', 42, collectorFixture({mergeable, protected: false}));
    assert.equal(s.pr.mergeSha, null); assert.equal(s.mergeChecks.available, false); assert.equal(analyze(s).overall, 'unknown');
  }
});
test('strict up-to-date requirements block a behind branch and remain unknown if unreadable', () => {
  const s = fresh(); passing(s); s.branchFreshness = {required: true, available: true, behindBy: 2};
  assert.equal(analyze(s).overall, 'blocked'); assert.ok(analyze(s).limitations.some(text => text.includes('2 commits behind')));
  s.branchFreshness.behindBy = 0; assert.equal(analyze(s).overall, 'satisfied');
  s.branchFreshness.available = false; assert.equal(analyze(s).overall, 'unknown');
});
test('collector preserves strict up-to-date check policies from both sources', () => {
  for (const source of ['classic', 'rulesets']) {
    const base = collectorFixture({protected: false});
    const comparisons = [];
    const request = endpoint => {
      if (source === 'classic' && endpoint === 'graphql') return {available: true, data: {data: {repository: {pullRequest: {baseRef: {branchProtectionRule: {requiresStatusChecks: true, requiresStrictStatusChecks: true, requiredStatusChecks: [{context: 'build'}]}}}}}}};
      if (source === 'rulesets' && endpoint.includes('/rules/branches/')) return {available: true, data: [{type: 'required_status_checks', ruleset_id: 1, parameters: {strict_required_status_checks_policy: true, required_status_checks: [{context: 'build'}]}}]};
      if (endpoint.includes('/compare/')) {comparisons.push(endpoint); return {available: true, data: {behind_by: 3}};}
      return base(endpoint);
    };
    const s = collect('x/y', 42, request); assert.deepEqual(s.branchFreshness, {required: true, available: true, baseTipSha: 'current-base-tip', behindBy: 3});
    assert.deepEqual(comparisons, ['repos/x/y/compare/current-base-tip...head']);
  }
});
test('an unreadable current base tip cannot produce a strict-policy pass', () => {
  const base = collectorFixture({protected: false});
  const comparisons = [];
  const request = endpoint => {
    if (endpoint === 'graphql') return {available: true, data: {data: {repository: {pullRequest: {baseRef: {branchProtectionRule: {requiresStatusChecks: false, requiresStrictStatusChecks: false, requiredStatusChecks: []}}}}}}};
    if (endpoint.includes('/rules/branches/')) return {available: true, data: [{type: 'required_status_checks', ruleset_id: 1, parameters: {strict_required_status_checks_policy: true, required_status_checks: []}}]};
    if (endpoint.endsWith('/branches/main')) return {available: false, error: 'Unavailable'};
    if (endpoint.includes('/compare/')) {comparisons.push(endpoint); return {available: true, data: {behind_by: 0}};}
    return base(endpoint);
  };
  const s = collect('x/y', 42, request); assert.equal(s.branchFreshness.available, false); assert.equal(analyze(s).overall, 'unknown');
  assert.equal(s.classic.available, true); assert.deepEqual(comparisons, []);
});
test('organization rulesets do not invent a repository-specific rule URL', () => {
  const base = collectorFixture();
  const s = collect('x/y', 42, endpoint => endpoint.includes('/rules/branches/') ? {available: true, data: [{type: 'required_status_checks', ruleset_source_type: 'Organization', ruleset_source: 'x', ruleset_id: 99, parameters: {required_status_checks: [{context: 'build'}]}}]} : base(endpoint));
  assert.equal(s.rulesets.checks[0].url, null); assert.equal(analyze(s).checks[0].evidence[0].url, null);
});
test('captured Next.js required-check failure agrees with the live comparator evidence', () => {
  const snapshot = JSON.parse(readFileSync(new URL('../examples/live/next-99728.json', import.meta.url), 'utf8'));
  const report = analyze(snapshot);
  assert.equal(report.overall, 'blocked');
  assert.equal(report.checks.find(check => check.context === 'thank you, next').code, 'check_failed');
  assert.equal(report.checks.find(check => check.context === 'Potentially publish release').state, 'satisfied');
});
test('captured Next.js draft identifies the required context that has not reported', () => {
  const snapshot = JSON.parse(readFileSync(new URL('../examples/live/next-99933.json', import.meta.url), 'utf8'));
  const report = analyze(snapshot);
  assert.equal(report.overall, 'blocked'); assert.equal(report.draft, true);
  assert.equal(report.checks.find(check => check.context === 'thank you, next').code, 'required_check_missing');
  assert.equal(report.checks.filter(check => check.state === 'satisfied').length, 2);
});
