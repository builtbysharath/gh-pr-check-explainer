import {LineCounter, parseDocument} from 'yaml';
import picomatch from 'picomatch';

const PASS = new Set(['success', 'neutral', 'skipped']);
const PR_EVENTS = new Set(['push', 'pull_request', 'pull_request_review', 'pull_request_target', 'deployment', 'deployment_status']);
const DOCS = 'https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks';

const MAX_MATRIX_JOBS = 256;
function hasExpression(value) {
  return typeof value === 'string' ? value.includes('$' + '{{') : Array.isArray(value) ? value.some(hasExpression) :
    value !== null && typeof value === 'object' && Object.values(value).some(hasExpression);
}
function hasNull(value) {
  return value === null || value === undefined || (typeof value === 'object' && Object.values(value).some(hasNull));
}
// GitHub prints the leaf values of each matrix value, in order, in a job's name.
function leaves(value) {
  return value !== null && typeof value === 'object' ? Object.values(value).flatMap(leaves) : [String(value)];
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
// Matrix variable names are case-insensitive, so they are compared in lower case.
function lowerKeys(entry) {
  return Object.fromEntries(Object.entries(entry).map(([key, value]) => [key.toLowerCase(), value]));
}
// A property as an expression reads it: case-insensitive, and only the object's own keys.
function property(object, key) {
  if (object === null || typeof object !== 'object') return undefined;
  const own = Object.keys(object).find(name => name.toLowerCase() === key.toLowerCase());
  return own === undefined ? undefined : object[own];
}

// Expands jobs.<id>.strategy.matrix as GitHub does (checked against real check
// runs in test/matrix.test.js). Each combination keeps the values its job name
// shows: the matrix's own keys, or every value of an include entry that became
// a new combination. Returns null when the result can't be predicted.
function matrixCombinations(matrix) {
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix) || hasExpression(matrix) || hasNull(matrix)) return null;
  const {include: includes = [], exclude: excludes = [], ...variables} = matrix;
  const axes = lowerKeys(variables);
  const keys = Object.keys(axes);
  if (!Array.isArray(includes) || !Array.isArray(excludes) || keys.some(key => !Array.isArray(axes[key]) || !axes[key].length)) return null;
  if (keys.reduce((count, key) => count * axes[key].length, 1) > MAX_MATRIX_JOBS) return null;
  let combinations = keys.length ? [{}] : [];
  for (const key of keys) combinations = combinations.flatMap(combination => axes[key].map(value => ({...combination, [key]: value})));
  for (const entry of [...includes, ...excludes]) if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const include = includes.map(lowerKeys), exclude = excludes.map(lowerKeys);
  combinations = combinations.filter(combination => !exclude.some(entry => Object.entries(entry).every(([key, value]) => same(combination[key], value))));
  const results = combinations.map(values => ({values, shown: keys.map(key => values[key])}));
  const originals = results.length;
  for (const entry of include) {
    // An entry extends every original combination whose own values it doesn't change.
    let added = false;
    for (const result of results.slice(0, originals)) {
      if (Object.entries(entry).every(([key, value]) => !keys.includes(key) || same(result.values[key], value))) {
        Object.assign(result.values, entry);
        added = true;
      }
    }
    if (!added) results.push({values: {...entry}, shown: Object.values(entry)});
  }
  return results.length > MAX_MATRIX_JOBS || results.some(result => !result.shown.length) ? null : results;
}

// The check run names a job reports, or null when they depend on expressions
// other than the matrix, a dynamic matrix, or a reusable workflow.
export function jobCheckNames(id, job) {
  if (!job || typeof job !== 'object' || job.uses) return null;
  const name = job.name || id;
  if (typeof name !== 'string') return null;
  const matrix = job.strategy?.matrix;
  if (matrix === undefined) return hasExpression(name) ? null : [name];
  const combinations = matrixCombinations(matrix);
  if (!combinations) return null;
  // A name without expressions gets the matrix values appended. A job that its
  // if condition skips reports one check, named without them.
  if (!hasExpression(name)) return [...combinations.map(({shown}) => name + ' (' + shown.flatMap(leaves).join(', ') + ')'), ...(job.if === undefined ? [] : [name])];
  const parts = name.split(/(\$\{\{[\s\S]*?\}\})/);
  const paths = parts.map((part, index) => index % 2 ? part.match(/^\$\{\{\s*matrix((?:\.[A-Za-z_][\w-]*)+)\s*\}\}$/)?.[1].slice(1).split('.') : null);
  if (paths.some((path, index) => index % 2 && !path)) return null;
  const names = [];
  for (const {values} of combinations) {
    let text = '';
    for (let index = 0; index < parts.length; index++) {
      if (index % 2 === 0) {
        text += parts[index];
        continue;
      }
      const value = paths[index].reduce(property, values);
      if (value !== null && typeof value === 'object') return null;
      text += value === undefined ? '' : String(value);
    }
    names.push(text);
  }
  return names;
}

function workflowInfo(file, repository, sha) {
  const lines = new LineCounter();
  try {
    if (typeof file.text !== 'string' || file.text.length > 1_000_000) throw new Error('Workflow exceeds the supported size.');
    const doc = parseDocument(file.text, {lineCounter: lines, uniqueKeys: true});
    if (doc.errors.length) throw new Error(doc.errors[0].message);
    const value = doc.toJS({maxAliasCount: 100});
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Workflow must be a mapping.');
    const jobs = value.jobs && typeof value.jobs === 'object' ? value.jobs : {};
    const names = [];
    let dynamic = false;
    for (const [id, job] of Object.entries(jobs)) {
      if (!job || typeof job !== 'object') continue;
      const checkNames = jobCheckNames(id, job);
      if (!checkNames) {
        dynamic = true;
        continue;
      }
      const node = doc.get('jobs', true)?.get?.(id, true);
      const nameNode = node?.get?.('name', true) || node;
      const line = lines.linePos(nameNode?.range?.[0] || 0).line;
      names.push(...checkNames.map(name => ({name, line})));
    }
    const onNode = doc.contents?.items?.find(pair => pair.key?.value === 'on')?.key || doc.get('on', true);
    const line = lines.linePos(onNode?.range?.[0] || 0).line;
    const url = 'https://github.com/' + (file.repository || repository) + '/blob/' + sha + '/' + file.path;
    return {path: file.path, on: value.on, names, dynamic, line, url};
  } catch (error) {
    return {path: file.path, names: [], dynamic: true, error: error.message};
  }
}
function hasEvent(workflow, event) {
  return workflow.on === event || Array.isArray(workflow.on) && workflow.on.includes(event) ||
    workflow.on && typeof workflow.on === 'object' && Object.hasOwn(workflow.on, event);
}

// Conservative subset: * and whole-component ** plus ordered ! patterns.
// Other syntax remains unsupported instead of borrowing Bash semantics.
function matchPatterns(value, patterns) {
  if (!Array.isArray(patterns) || !patterns.length || patterns.some(p =>
    typeof p !== 'string' || p.length > 500 || /[\[\]{}()+?\\]/.test(p) || p.replace(/^!/, '').split('/').some(segment => segment.includes('**') && segment !== '**'))) return null;
  let included = false;
  for (const pattern of patterns) {
    const negative = pattern.startsWith('!');
    const body = negative ? pattern.slice(1) : pattern;
    if (!body) return null;
    try {
      if (picomatch.isMatch(value, body, {dot: true, nonegate: true, noext: true})) included = !negative;
    } catch {
      return null;
    }
  }
  return included;
}

// Whether an event's branches or branches-ignore filter admits a branch, or null when unknown.
function branchAllowed(config, branch) {
  if (config === null || config === undefined) return true;
  if (typeof config !== 'object' || Array.isArray(config) || config.branches && config['branches-ignore']) return null;
  const patterns = config.branches || config['branches-ignore'];
  if (!patterns) return true;
  const match = matchPatterns(branch, patterns);
  return match === null ? null : config.branches ? match : !match;
}

function eventFilter(event, config, snapshot) {
  if (config === null || config === undefined) return {state: 'eligible'};
  if (typeof config !== 'object' || Array.isArray(config)) return {state: 'unknown'};
  // The automatic PR action could be filtered by types; without its precise
  // triggering action we cannot infer whether the workflow should have run.
  if (config.types || config.tags || config['tags-ignore']) return {state: 'unknown'};
  const reasons = [];
  if (config.paths && config['paths-ignore']) return {state: 'unknown'};
  const branch = event === 'push' ? snapshot.pr.headBranch : snapshot.pr.baseBranch;
  if (config.branches || config['branches-ignore']) {
    const allowed = branch ? branchAllowed(config, branch) : null;
    if (allowed === null) return {state: 'unknown'};
    if (!allowed) reasons.push('The ' + event + ' branch filter excludes ' + branch + '.');
  }
  if (config.paths || config['paths-ignore']) {
    // A push compares its before/after commits, not the PR's three-dot diff.
    if (event === 'push') return {state: 'unknown'};
    // GitHub path evaluation uses a limited diff; never make a definitive
    // prediction from a large/truncated diff or an unobserved comparison.
    if (!snapshot.files?.available || snapshot.files.data.length > 300 || snapshot.files.truncated) return {state: 'unknown'};
    const results = snapshot.files.data.map(file => matchPatterns(file, config.paths || config['paths-ignore']));
    if (results.some(result => result === null)) return {state: 'unknown'};
    if (config.paths ? !results.some(Boolean) : results.every(Boolean)) {
      reasons.push('The ' + event + ' path filter excludes ' + (results.length === 1 ? 'the 1 changed file.' : 'all ' + results.length + ' changed files.'));
    }
  }
  return {state: reasons.length ? 'excluded' : 'eligible', reasons};
}

function workflowEvents(on) {
  if (typeof on === 'string') return {[on]: null};
  if (Array.isArray(on)) return Object.fromEntries(on.map(event => [event, null]));
  return on && typeof on === 'object' ? on : null;
}

function workflowFilter(workflow, snapshot) {
  const events = workflowEvents(workflow.on);
  if (!events) return {state: 'unknown'};
  const relevant = Object.entries(events).filter(([event]) => PR_EVENTS.has(event));
  if (!relevant.length) return {state: 'unsupported_event', reasons: ['This workflow has no event that can satisfy ordinary PR required checks.']};
  const results = relevant.map(([event, config]) => {
    if (event === 'push' && snapshot.pr.fork) return {state: 'unknown'};
    if (!['push', 'pull_request', 'pull_request_target'].includes(event)) return {state: 'unknown'};
    return eventFilter(event, config, snapshot);
  });
  if (results.some(result => result.state === 'eligible')) return {state: 'eligible'};
  if (results.some(result => result.state === 'unknown')) return {state: 'unknown'};
  return {state: 'excluded', reasons: results.flatMap(result => result.reasons || [])};
}

function latestRuns(runs) {
  const bySuite = new Map();
  for (const run of runs) {
    const key = [run.name, run.appId ?? 'unknown', run.suiteId ?? run.id].join(':');
    const prior = bySuite.get(key);
    if (!prior || (run.id || 0) > (prior.id || 0)) bySuite.set(key, run);
  }
  return [...bySuite.values()];
}

function evidenceForRun(run) {
  return {label: run.name + ' · ' + (run.conclusion || run.status), url: run.url || null,
    detail: 'commit ' + run.sha + '; app ' + (run.appSlug || run.appId || 'unreported')};
}

function policyChecks(snapshot) {
  const checks = [];
  for (const policy of ['rulesets', 'classic']) {
    if (!snapshot[policy]?.available) continue;
    for (const check of snapshot[policy].checks || []) {
      if (typeof check.context !== 'string' || !check.context) throw new Error('A required check has no context name.');
      const appId = check.appId && check.appId !== -1 ? check.appId : null;
      const existing = checks.find(item => item.context === check.context && item.appId === appId);
      if (existing) existing.sources.push(check.source || policy);
      else checks.push({...check, appId, sources: [check.source || policy]});
    }
  }
  return checks;
}

export function analyze(snapshot) {
  if (snapshot?.schemaVersion !== 1 || typeof snapshot.repository !== 'string' ||
      !snapshot.pr?.headSha || !Number.isInteger(snapshot.pr.number)) throw new Error('Not a version 1 PR snapshot.');
  const limitations = [];
  const freshness = snapshot.branchFreshness || {available: false, error: 'Strict up-to-date policy was not collected in this legacy snapshot.'};
  const freshnessUnknown = freshness && (!freshness.available || freshness.required && !Number.isSafeInteger(freshness.behindBy));
  const freshnessBlocked = freshness?.required && freshness.available && freshness.behindBy > 0;
  if (freshnessUnknown) limitations.push('branchFreshness: ' + (freshness.error || 'The strict up-to-date check policy could not be confirmed.'));
  if (freshnessBlocked) limitations.push('branchFreshness: The strict required-check policy requires an up-to-date branch; the head is ' + freshness.behindBy + ' commits behind the captured base-branch tip' + (freshness.baseTipSha ? ' ' + freshness.baseTipSha : '') + '.');
  if (snapshot.pr.draft) limitations.push('This PR is a draft. Results are compared with merge-time requirements; workflows may wait until the PR is ready. A missing result is not a failed job.');
  for (const field of ['rulesets', 'classic', 'headChecks', 'headStatuses']) {
    if (!snapshot[field]?.available) limitations.push(field + ': ' + (snapshot[field]?.error || 'not observed'));
  }
  if (!snapshot.mergeChecks?.available || !snapshot.mergeStatuses?.available) {
    limitations.push('Test-merge commit check coverage is incomplete.');
  }
  const mergeHasReports = snapshot.mergeChecks?.data?.length || snapshot.mergeStatuses?.data?.length;
  const evaluatedSha = mergeHasReports ? snapshot.pr.mergeSha : snapshot.pr.headSha;
  if (!evaluatedSha) throw new Error('Test-merge check data has no corresponding commit SHA.');
  const runSet = mergeHasReports ? snapshot.mergeChecks : snapshot.headChecks;
  const statusSet = mergeHasReports ? snapshot.mergeStatuses : snapshot.headStatuses;
  const runs = latestRuns(runSet?.data || []);
  const statuses = statusSet?.data || [];
  const workflows = (snapshot.workflows?.data || []).map(file => workflowInfo(file, snapshot.repository, snapshot.pr.headSha));
  const baseWorkflows = (snapshot.baseWorkflows?.data || []).map(file => workflowInfo(file, snapshot.repository, snapshot.pr.baseSha || snapshot.pr.baseBranch));
  for (const workflow of workflows.filter(item => item.error)) limitations.push(workflow.path + ': ' + workflow.error);
  for (const workflow of baseWorkflows.filter(item => item.error)) limitations.push('Base branch ' + workflow.path + ': ' + workflow.error);
  const checks = policyChecks(snapshot).map(required => {
    const matching = runs.filter(run => run.name === required.context);
    const correctSource = matching.filter(run => !required.appId || run.appId === required.appId);
    const matchingStatuses = statuses.filter(status => status.context === required.context);
    const details = [];
    const evidence = [{label: 'Required by ' + required.sources.join(', '),
      url: required.url || (required.sourceType && required.sourceType !== 'Repository' ? null : 'https://github.com/' + snapshot.repository + '/rules'), detail: required.context}];
    // cause names the configuration that explains a missing or ineligible result, even when code reports
    // something else first (such as an older passing commit).
    const row = {...required, state: 'unknown', code: 'insufficient_evidence', cause: null, evidence, details, docs: DOCS};
    if (!runSet?.available || !statusSet?.available) {
      details.push('Current check runs or commit statuses could not be read. No diagnosis is inferred from missing data.');
      return row;
    }
    if (correctSource.length) {
      evidence.push(...correctSource.map(evidenceForRun));
      if (correctSource.length > 1) {
        row.code = 'ambiguous_check_name';
        details.push('Multiple independent check suites use this name. Give required jobs unique names before treating one green result as sufficient.');
        return row;
      }
      const run = correctSource[0];
      if (run.sha !== evaluatedSha) {
        row.code = 'inconsistent_snapshot';
        details.push('A check returned for the evaluated commit identifies a different SHA.');
        return row;
      }
      if (run.appSlug === 'github-actions') {
        const workflowRun = run.suiteId != null && snapshot.runs?.data?.find(item => item.suiteId === run.suiteId);
        if (!workflowRun) {
          row.code = 'workflow_event_unobserved';
          details.push('The Actions trigger event was not observed, so its eligibility for this PR is not confirmed.');
          return row;
        }
        evidence.push({label: 'Actions event: ' + workflowRun.event, url: workflowRun.url, detail: workflowRun.path});
        if (!PR_EVENTS.has(workflowRun.event)) {
          row.state = 'blocked';
          row.code = row.cause = 'ineligible_workflow_event';
          details.push('This Actions check ran on ' + workflowRun.event + ', which does not satisfy an ordinary PR required check.');
          return row;
        }
      }
      row.state = run.status === 'completed' && PASS.has(run.conclusion) ? 'satisfied' : 'blocked';
      row.code = row.state === 'satisfied' ? 'check_passed' : run.status === 'completed' ? 'check_failed' : 'check_running';
      details.push(run.status === 'completed' ? 'Latest check conclusion: ' + run.conclusion + '.' : 'The check is ' + run.status + '.');
    } else if (matching.length && required.appId && !matchingStatuses.length) {
      row.state = 'blocked'; row.code = row.cause = 'wrong_reporting_app';
      evidence.push(...matching.map(evidenceForRun));
      details.push('The name matches, but the rule requires GitHub App ' + required.appId + '; observed apps: ' + [...new Set(matching.map(run => run.appId))].join(', ') + '.');
      return row;
    }
    // When a commit status and a check run share a required name, both must pass.
    if (matchingStatuses.length) {
      const status = matchingStatuses[0];
      evidence.push({label: 'Commit status: ' + status.state, url: status.url || null, detail: required.context});
      if (required.appId) {
        row.state = 'unknown'; row.code = 'status_source_unverifiable';
        details.push('This commit status has no verifiable GitHub App identity in the collected data.');
      } else if (status.state !== 'success') {
        row.state = 'blocked'; row.code = 'commit_status_not_passed';
        details.push('A commit status with the same required name must also succeed.');
      } else if (!correctSource.length) {
        row.state = 'satisfied'; row.code = 'status_passed';
        details.push('The latest commit status is successful.');
      }
      return row;
    }
    if (correctSource.length) return row;
    row.state = 'blocked'; row.code = 'required_check_missing';
    details.push('No result from the required source exists on evaluated commit ' + evaluatedSha + '.');
    const older = snapshot.previousChecks?.data?.filter(run => run.name === required.context &&
      (!required.appId || run.appId === required.appId) && PASS.has(run.conclusion)) || [];
    const headOnly = mergeHasReports ? (snapshot.headChecks?.data || []).filter(run =>
      run.name === required.context && PASS.has(run.conclusion) && (!required.appId || run.appId === required.appId)) : [];
    if (older.length || headOnly.length) {
      row.code = 'passed_on_other_commit';
      evidence.push(...[...older, ...headOnly].map(evidenceForRun));
      details.push('A passing result on another commit does not satisfy this evaluated SHA.');
    }
    if (required.appId && required.appId !== 15368) {
      details.push('The rule specifies another GitHub App, so GitHub Actions workflow configuration is not used to explain its missing result.');
      return row;
    }
    const baseTargetProducers = baseWorkflows.filter(file => hasEvent(file, 'pull_request_target') && file.names.some(job => job.name === required.context));
    if (baseTargetProducers.length || workflows.some(file => hasEvent(file, 'pull_request_target') && file.names.some(job => job.name === required.context))) {
      details.push('A pull_request_target producer exists. Its base-branch execution context is not modeled; no head-workflow filter or rename explanation is inferred.');
      return row;
    }
    const producers = workflows.filter(file => file.names.some(job => job.name === required.context));
    if (producers.length === 1) {
      const workflow = producers[0];
      // GitHub holds workflow runs from some fork PRs until a maintainer approves them.
      const waiting = (snapshot.runs?.data || []).find(run => run.path === workflow.path && run.conclusion === 'action_required');
      if (waiting) {
        row.cause = 'workflow_awaiting_approval';
        if (row.code !== 'passed_on_other_commit') row.code = row.cause;
        evidence.push({label: workflow.path + ' run · action_required', url: waiting.url || null, detail: 'Event ' + waiting.event});
        details.push('The run of ' + workflow.path + ' for this commit is waiting for a maintainer to approve workflows' + (snapshot.pr.fork ? ' from this fork' : '') + '.');
        return row;
      }
      const filter = workflowFilter(workflow, snapshot);
      evidence.push({label: workflow.path, url: workflow.url + '#L' + workflow.line, detail: 'Workflow event configuration'});
      if (filter.state === 'excluded' || filter.state === 'unsupported_event') {
        row.cause = filter.state === 'excluded' ? 'workflow_filtered' : 'workflow_has_no_pr_event';
        if (row.code !== 'passed_on_other_commit') row.code = row.cause;
        details.push(...filter.reasons);
        details.push('This configuration can explain the missing result; other workflow-run conditions have not been executed or simulated.');
      } else if (filter.state === 'unknown') {
        details.push('The workflow trigger cannot be fully evaluated from the available evidence.');
      }
    } else if (!producers.length && snapshot.workflows?.available && snapshot.baseWorkflows?.available) {
      const removed = baseWorkflows.filter(file => file.names.some(job => job.name === required.context));
      if (removed.length === 1 && !workflows.some(file => file.dynamic)) {
        row.code = row.cause = 'job_removed_or_renamed';
        evidence.push({label: 'Base branch producer: ' + removed[0].path, url: removed[0].url, detail: required.context});
        details.push('The base branch defines this job name, but the PR version no longer does. Review the job rename or deletion and the required-check rule together.');
      }
    }
    return row;
  });
  if (!snapshot.workflows?.available) limitations.push('Workflow explanations unavailable: ' + (snapshot.workflows?.error || 'not observed'));
  if (workflows.some(file => file.dynamic)) limitations.push('Dynamic matrix names and reusable workflows are not expanded; unmatched check names remain unexplained.');
  const mergeCoverageIncomplete = !snapshot.mergeChecks?.available || !snapshot.mergeStatuses?.available;
  const overall = mergeCoverageIncomplete ? 'unknown' : freshnessBlocked || checks.some(check => check.state === 'blocked') ? 'blocked' :
    freshnessUnknown || limitations.some(text => /^(rulesets|classic|headChecks|headStatuses|Test-merge)/.test(text)) || checks.some(check => check.state === 'unknown') ? 'unknown' :
    checks.length ? 'satisfied' : 'none';
  return {schemaVersion: 1, repository: snapshot.repository, number: snapshot.pr.number,
    url: snapshot.pr.url, draft: Boolean(snapshot.pr.draft), collectedAt: snapshot.collectedAt, headSha: snapshot.pr.headSha,
    evaluatedSha, evaluation: mergeHasReports ? 'test-merge commit' : 'PR head commit',
    overall, branchFreshness: freshness, scope: 'Required status checks and observed strict up-to-date check policy. Reviews, merge conflicts, deployments, and other merge policies are outside this verdict.',
    checks, limitations};
}

const ACTIONS_APP = 15368;
const PR_TRIGGERS = ['pull_request', 'pull_request_target'];
const AUDIT_ORDER = ['risk', 'unknown', 'ok', 'not_checked'];

// For pull requests into branch: 'all', or what filters them out, or 'unknown'.
function prReach(config, branch) {
  const allowed = branchAllowed(config, branch);
  if (allowed === null) return 'unknown';
  if (!allowed) return 'branch';
  const types = config?.types === undefined ? null : [config.types].flat();
  if (types && !['opened', 'synchronize'].every(type => types.includes(type))) return 'types';
  return config?.paths || config?.['paths-ignore'] ? 'paths' : 'all';
}
// Which pushed branches a push trigger runs for: 'most', 'some', 'none' or 'unknown'.
function pushReach(config) {
  if (config === null || config === undefined) return 'most';
  if (typeof config !== 'object' || Array.isArray(config) || config.branches && config['branches-ignore']) return 'unknown';
  // With only tag filters, branch pushes don't run the workflow.
  if (!config.branches && !config['branches-ignore']) return config.tags || config['tags-ignore'] ? 'none' : 'most';
  if (config['branches-ignore']) return 'most';
  // Exact names such as [main] run for pushes to those branches, not to PR branches.
  if (Array.isArray(config.branches) && config.branches.every(pattern => typeof pattern === 'string' && !/[*?[\]+!]/.test(pattern))) return 'none';
  return 'some';
}
function hasFilters(config) {
  return config !== null && config !== undefined && (typeof config !== 'object' || Array.isArray(config) ||
    ['branches', 'branches-ignore', 'tags', 'tags-ignore', 'paths', 'paths-ignore'].some(key => config[key] !== undefined));
}
// Whether a workflow runs for merge groups into branch: through merge_group, or
// through a push to the queue's gh-readonly-queue/ branch. Null when unknown.
function queueReach(events, branch) {
  const group = Object.hasOwn(events, 'merge_group') ? branchAllowed(events.merge_group, branch) : false;
  if (group || !Object.hasOwn(events, 'push')) return group;
  const reach = pushReach(events.push);
  if (reach === 'unknown' || events.push?.paths || events.push?.['paths-ignore']) return null;
  const pushed = reach !== 'none' && branchAllowed(events.push, 'gh-readonly-queue/' + branch + '/pr-1-' + '0'.repeat(40));
  return pushed || (group === null ? null : pushed);
}
// 'broad' when a workflow can run for ordinary pull requests into branch,
// 'narrow' when only for some PR branches, and 'none' otherwise.
function prTier(file, branch) {
  const events = workflowEvents(file.on);
  if (!events) return 'broad';
  let tier = 'none';
  for (const [event, config] of Object.entries(events)) {
    const reach = PR_TRIGGERS.includes(event) ? prReach(config, branch) : event === 'push' ? pushReach(config) : PR_EVENTS.has(event) ? 'unknown' : 'none';
    if (!['branch', 'some', 'none'].includes(reach)) return 'broad';
    if (reach !== 'none') tier = 'narrow';
  }
  return tier;
}

function auditCheck(required, workflows, snapshot) {
  const {branch} = snapshot;
  const codes = [], details = [];
  const evidence = [{label: 'Required by ' + required.sources.join(', '),
    url: required.url || (required.sourceType && required.sourceType !== 'Repository' ? null : 'https://github.com/' + snapshot.repository + '/rules'), detail: required.context}];
  const row = {...required, state: 'unknown', codes, details, evidence, docs: DOCS};
  const risk = (code, text) => {
    codes.push(code);
    details.push(text);
  };
  const finish = (unknown = false, ok = '') => {
    if (codes.length) {
      row.state = 'risk';
      if (!required.appId) details.push('The rule accepts this name from any app or commit status, so another service could still report it.');
    } else if (unknown) {
      row.state = 'unknown';
    } else {
      row.state = 'ok';
      details.unshift(ok);
    }
    return row;
  };
  if (required.appId && required.appId !== ACTIONS_APP) {
    row.state = 'not_checked';
    details.push('The rule requires GitHub App ' + required.appId + ', so GitHub Actions workflows are not compared with it.');
    return row;
  }
  if (!snapshot.workflows?.available) {
    details.push('The workflows on ' + branch + ' could not be read.');
    return row;
  }
  // Jobs of a workflow_call-only workflow report under their caller's job name.
  const producers = workflows.filter(file => {
    const events = workflowEvents(file.on);
    return file.names.some(job => job.name === required.context) && (!events || Object.keys(events).some(event => event !== 'workflow_call'));
  });
  if (!producers.length) {
    evidence.push({label: '.github/workflows', url: 'https://github.com/' + snapshot.repository + '/tree/' + snapshot.sha + '/.github/workflows', detail: 'Workflows on ' + branch});
    const dynamic = workflows.some(file => file.dynamic);
    if (required.appId === ACTIONS_APP && !dynamic) {
      risk('no_producer', 'No workflow on ' + branch + ' has a job that reports this name, so pull requests wait for it.');
      return finish();
    }
    const sources = [...(required.appId ? [] : ['another app or a commit status']), ...(dynamic ? ['a job name that could not be expanded'] : [])];
    details.push('No workflow job on ' + branch + ' reports this name. It may come from ' + sources.join(', or ') + '.');
    return row;
  }
  for (const file of producers) {
    evidence.push({label: file.path, url: file.url + '#L' + file.names.find(job => job.name === required.context).line, detail: 'Job that reports ' + required.context});
  }
  // A workflow limited to other branches, such as a release-branch copy, only
  // matters when no workflow runs for ordinary pull requests.
  const tiers = producers.map(file => prTier(file, branch));
  const broad = producers.filter((file, index) => tiers[index] === 'broad');
  const reporting = broad.length ? broad : producers.filter((file, index) => tiers[index] === 'narrow');
  if (reporting.length > 1) {
    risk('ambiguous_producers', 'Several workflows can report a check with this name: ' + reporting.map(file => file.path).join(', ') + '. GitHub does not document which of their runs a required check uses, so one workflow\'s result can stand in for another\'s. Unique job names make each a separate check.');
    return finish();
  }
  if (!reporting.length) {
    codes.push('workflow_has_no_pr_event');
    details.push(...producers.map(file => {
      const events = workflowEvents(file.on);
      const runs = file.path + ' runs only on ' + Object.keys(events).join(', ');
      if (events.push?.branches) return runs + '; its push trigger only runs for the branches ' + [events.push.branches].flat().join(', ') + ', so pull requests from any other branch never get a result for this check.';
      return runs + (events.push ? '; its push trigger only runs for tags' : '') + '. None of these give pull requests a result for this check.';
    }));
    return finish();
  }
  const file = reporting[0];
  const events = workflowEvents(file.on);
  if (!events) {
    details.push('The triggers of ' + file.path + ' could not be read.');
    return row;
  }
  evidence.push({label: file.path + ' triggers', url: file.url + '#L' + file.line, detail: Object.keys(events).join(', ')});
  const prEvents = PR_TRIGGERS.filter(event => Object.hasOwn(events, event));
  const reaches = prEvents.map(event => prReach(events[event], branch));
  const event = state => prEvents[reaches.indexOf(state)];
  const hasPush = Object.hasOwn(events, 'push');
  const forks = hasPush && !hasFilters(events.push) ? ' Its push trigger still reports the check for branches in this repository, so this mainly affects pull requests from forks.' : '';
  let unknown = false;
  if (reaches.includes('all')) {
    // Every pull request into the branch runs it.
  } else if (reaches.includes('unknown')) {
    unknown = true;
    details.push('The ' + event('unknown') + ' filters in ' + file.path + ' cannot be fully evaluated.');
  } else if (reaches.includes('paths')) {
    risk('workflow_path_filtered', 'The ' + event('paths') + ' path filter in ' + file.path + ' skips pull requests that change only other files, and they wait for this check.' + forks);
  } else if (reaches.includes('types')) {
    risk('workflow_types_filtered', 'The ' + event('types') + ' types filter in ' + file.path + ' leaves out opened or synchronize, so some pull requests or new commits never get this check.' + forks);
  } else if (reaches.length) {
    risk('workflow_branch_filtered', 'The ' + prEvents[0] + ' branch filter in ' + file.path + ' excludes ' + branch + ', so pull requests into ' + branch + ' never get this check.' + forks);
  } else if (hasPush && pushReach(events.push) !== 'unknown') {
    risk('workflow_push_only', file.path + ' runs on push but not on pull_request, so pull requests from forks never get this check' +
      (pushReach(events.push) === 'some' ? ', and branches outside its push filter don\'t either' : '') + '.' +
      (events.push?.paths || events.push?.['paths-ignore'] ? ' Its push path filter also skips pushes that change only other files.' : ''));
  } else {
    unknown = true;
    details.push('Whether the ' + Object.keys(events).join(', ') + ' triggers of ' + file.path + ' report on pull requests is not evaluated.');
  }
  const queue = snapshot.mergeQueue?.enabled === true;
  if (queue) {
    // Any workflow with the job name can report it in the queue, such as a separate merge_group workflow.
    const reaches = producers.map(item => workflowEvents(item.on) ? queueReach(workflowEvents(item.on), branch) : null);
    if (reaches.includes(true)) {
      // Some workflow runs for merge groups into the branch.
    } else if (reaches.includes(null)) {
      unknown = true;
      details.push('Whether ' + producers.filter((item, index) => reaches[index] === null).map(item => item.path).join(', ') + ' runs in the merge queue cannot be fully evaluated.');
    } else {
      const cause = producers.length > 1 ? 'none of ' + producers.map(item => item.path).join(', ') + ' runs for merge groups into it' :
        Object.hasOwn(events, 'merge_group') ? 'the merge_group branch filter in ' + file.path + ' excludes it' : file.path + ' has no merge_group trigger';
      risk('merge_queue_not_triggered', branch + ' uses a merge queue, but ' + cause + ', so this check is never reported for queued pull requests and they fail to merge.');
    }
  }
  return finish(unknown, 'Reported by ' + file.path + ' on pull requests' + (queue ? ' and in the merge queue' : '') + '.');
}

// Compares a branch's required checks with the workflows on that branch to
// find checks that pull requests would wait for indefinitely.
export function audit(snapshot) {
  if (snapshot?.schemaVersion !== 1 || snapshot.kind !== 'repository' || typeof snapshot.repository !== 'string' ||
      typeof snapshot.branch !== 'string' || typeof snapshot.sha !== 'string') throw new Error('Not a version 1 repository snapshot.');
  const limitations = [];
  for (const field of ['rulesets', 'classic', 'mergeQueue', 'workflows']) {
    if (!snapshot[field]?.available) limitations.push(field + ': ' + (snapshot[field]?.error || 'not observed'));
  }
  const workflows = (snapshot.workflows?.data || []).map(file => workflowInfo(file, snapshot.repository, snapshot.sha));
  for (const workflow of workflows.filter(item => item.error)) limitations.push(workflow.path + ': ' + workflow.error);
  if (workflows.some(file => file.dynamic)) limitations.push('Dynamic matrix names and reusable workflows are not expanded; checks they report may be listed as unknown.');
  const checks = policyChecks(snapshot).map(required => auditCheck(required, workflows, snapshot))
    .sort((a, b) => AUDIT_ORDER.indexOf(a.state) - AUDIT_ORDER.indexOf(b.state));
  const incomplete = limitations.some(text => /^(rulesets|classic|mergeQueue|workflows):/.test(text));
  const overall = checks.some(check => check.state === 'risk') ? 'risks' :
    incomplete || checks.some(check => check.state === 'unknown') ? 'unknown' : checks.length ? 'ok' : 'none';
  return {schemaVersion: 1, kind: 'audit', repository: snapshot.repository, branch: snapshot.branch, sha: snapshot.sha, collectedAt: snapshot.collectedAt,
    mergeQueue: snapshot.mergeQueue?.available ? snapshot.mergeQueue.enabled ? 'in use' : 'not in use' : 'unknown', overall,
    scope: 'Required status checks on ' + snapshot.branch + ' compared with the workflows on that branch. Job conditions, workflow changes inside a pull request, and other merge rules are not evaluated.',
    checks, limitations};
}
