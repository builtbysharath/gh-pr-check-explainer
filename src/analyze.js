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

function eventFilter(event, config, snapshot) {
  if (config === null || config === undefined) return {state: 'eligible'};
  if (typeof config !== 'object' || Array.isArray(config)) return {state: 'unknown'};
  // The automatic PR action could be filtered by types; without its precise
  // triggering action we cannot infer whether the workflow should have run.
  if (config.types || config.tags || config['tags-ignore']) return {state: 'unknown'};
  const reasons = [];
  if (config.branches && config['branches-ignore']) return {state: 'unknown'};
  if (config.paths && config['paths-ignore']) return {state: 'unknown'};
  const branch = event === 'push' ? snapshot.pr.headBranch : snapshot.pr.baseBranch;
  if (config.branches || config['branches-ignore']) {
    if (!branch) return {state: 'unknown'};
    const match = matchPatterns(branch, config.branches || config['branches-ignore']);
    if (match === null) return {state: 'unknown'};
    if (config.branches ? !match : match) reasons.push('The ' + event + ' branch filter excludes ' + branch + '.');
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

function workflowFilter(workflow, snapshot) {
  let events;
  if (typeof workflow.on === 'string') events = {[workflow.on]: null};
  else if (Array.isArray(workflow.on)) events = Object.fromEntries(workflow.on.map(event => [event, null]));
  else if (workflow.on && typeof workflow.on === 'object') events = workflow.on;
  else return {state: 'unknown'};
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
