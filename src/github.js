import {execFileSync} from 'node:child_process';

const QUERY = 'query($owner:String!,$repo:String!,$number:Int!) { repository(owner:$owner,name:$repo) { pullRequest(number:$number) { baseRef { branchProtectionRule { requiresStatusChecks requiresStrictStatusChecks requiredStatusChecks { context app { databaseId slug } } } } } } }';
function endpointPart(value) { return encodeURIComponent(value); }
function errorMessage(error) {
  const text = String(error.stderr || error.message || 'GitHub request failed');
  const status = text.match(/\bHTTP (\d{3})\b/)?.[1];
  return status ? 'GitHub API returned HTTP ' + status + '.' : 'GitHub request failed. Check gh authentication and repository access.';
}

// All requests are GET, except the read-only GraphQL query. There are no
// repository changes, workflow dispatches, comments, or merge calls.
export function ghRequest(endpoint, input) {
  const args = ['api', '--hostname', 'github.com', '-X', input ? 'POST' : 'GET', endpoint];
  if (input) args.push('--input', '-');
  try {
    const result = JSON.parse(execFileSync('gh', args, {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      input: input ? JSON.stringify(input) : undefined, stdio: ['pipe', 'pipe', 'pipe']
    }));
    if (result.errors?.length) return {available: false, error: 'GitHub GraphQL did not return a complete result.'};
    return {available: true, data: result};
  } catch (error) {
    return {available: false, error: errorMessage(error)};
  }
}

function pages(request, endpoint, extract = data => data) {
  const items = [];
  for (let page = 1; page <= 20; page++) {
    const result = request(endpoint + (endpoint.includes('?') ? '&' : '?') + 'per_page=100&page=' + page);
    if (!result.available) return result;
    const values = extract(result.data);
    if (!Array.isArray(values)) return {available: false, error: 'Unexpected GitHub response shape.'};
    items.push(...values);
    if (values.length < 100) return {available: true, data: items};
  }
  return {available: false, error: 'Pagination limit reached; data was not treated as complete.'};
}

function normalizeChecks(result, sha) {
  return result.available ? {...result, data: result.data.map(run => ({
    id: run.id, name: run.name, status: run.status, conclusion: run.conclusion,
    sha: run.head_sha || sha, suiteId: run.check_suite?.id,
    appId: run.app?.id, appSlug: run.app?.slug, url: run.html_url
  }))} : result;
}
function normalizeStatuses(result) {
  if (!result.available) return result;
  const latest = new Map();
  // GitHub returns statuses newest-first.
  for (const status of result.data) if (!latest.has(status.context)) latest.set(status.context, {
    context: status.context, state: status.state, url: status.target_url
  });
  return {...result, data: [...latest.values()]};
}

function readWorkflows(request, root, ref) {
  const listing = request(root + '/contents/.github/workflows?ref=' + endpointPart(ref));
  if (!listing.available) {
    // A missing directory is only accepted when the git tree confirms it.
    const tree = request(root + '/git/trees/' + endpointPart(ref) + '?recursive=1');
    if (!tree.available || tree.data.truncated) return {available: false, error: listing.error};
    if (tree.data.tree.some(entry => entry.path.startsWith('.github/workflows/'))) return {available: false, error: listing.error};
    return {available: true, data: []};
  }
  if (!Array.isArray(listing.data)) return {available: false, error: 'Workflow directory response is not a list.'};
  const files = listing.data.filter(item => item.type === 'file' && /\.ya?ml$/.test(item.name));
  if (files.length > 100) return {available: false, error: 'More than 100 workflows; supported collection limit exceeded.'};
  const contents = [];
  for (const file of files) {
    const result = request(root + '/contents/' + file.path.split('/').map(endpointPart).join('/') + '?ref=' + endpointPart(ref));
    if (!result.available || result.data.encoding !== 'base64' || result.data.size > 1_000_000) {
      return {available: false, error: 'Could not read the complete workflow ' + file.path + '.'};
    }
    contents.push({path: file.path, repository: root.slice('repos/'.length), text: Buffer.from(result.data.content, 'base64').toString('utf8')});
  }
  return {available: true, data: contents};
}

export function collect(repository, number, request = ghRequest) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.startsWith('-') ||
      !Number.isSafeInteger(number) || number < 1) throw new Error('Use --repo OWNER/REPO and a positive --pr number.');
  const [owner, repo] = repository.split('/');
  const root = 'repos/' + repository;
  const pull = request(root + '/pulls/' + number);
  if (!pull.available) throw new Error(pull.error);
  const pr = pull.data;
  if (pr.state !== 'open') throw new Error('Live diagnosis supports open pull requests; use a captured snapshot for closed examples.');
  const classicResult = request('graphql', {query: QUERY, variables: {owner, repo, number}});
  let classic;
  const baseRef = classicResult.data?.data?.repository?.pullRequest?.baseRef;
  if (!classicResult.available || !baseRef) classic = {available: false, error: classicResult.error || 'Base branch policy was not returned.'};
  else {
    const rule = baseRef.branchProtectionRule;
    const branch = !rule ? request(root + '/branches/' + endpointPart(pr.base.ref)) : null;
    classic = !rule && (!Object.hasOwn(baseRef, 'branchProtectionRule') || !branch?.available || branch.data.protected !== false) ?
      {available: false, error: 'No classic rule was returned; the base branch is protected or its protection state could not be confirmed.'} :
      rule?.requiresStatusChecks && !Array.isArray(rule.requiredStatusChecks) ?
      {available: false, error: 'Required classic checks were not returned.'} :
      {available: true, strict: rule?.requiresStatusChecks ? rule.requiresStrictStatusChecks : false, checks: rule?.requiresStatusChecks ? rule.requiredStatusChecks.map(check => ({
      context: check.context, appId: check.app?.databaseId || null,
      source: 'classic branch protection', url: pr.base.repo.html_url + '/settings/branches'
    })) : []};
  }
  const rulesResult = pages(request, root + '/rules/branches/' + endpointPart(pr.base.ref));
  const malformedRule = rulesResult.available && rulesResult.data.some(rule =>
    rule.type === 'required_status_checks' && !Array.isArray(rule.parameters?.required_status_checks));
  const rulesets = malformedRule ? {available: false, error: 'A required-check rule did not return its checks.'} : rulesResult.available ? {available: true, checks: rulesResult.data
    .filter(rule => rule.type === 'required_status_checks')
    .flatMap(rule => (rule.parameters?.required_status_checks || []).map(check => ({
      context: check.context, appId: check.integration_id || null,
      source: (rule.ruleset_source || repository) + ' ruleset ' + rule.ruleset_id,
      sourceType: rule.ruleset_source_type || 'Repository',
      url: !rule.ruleset_source_type || rule.ruleset_source_type === 'Repository' ? 'https://github.com/' + (rule.ruleset_source || repository) + '/rules/' + rule.ruleset_id : null
    })))} : rulesResult;
  const statusRules = rulesResult.available ? rulesResult.data.filter(rule => rule.type === 'required_status_checks') : [];
  const strictUnknown = classic.available && classic.checks.length > 0 && typeof classic.strict !== 'boolean' || statusRules.some(rule => typeof rule.parameters?.strict_required_status_checks_policy !== 'boolean');
  const strict = classic.strict === true || statusRules.some(rule => rule.parameters?.strict_required_status_checks_policy === true);
  let branchFreshness = {required: strict, available: !strictUnknown, behindBy: 0};
  if (strictUnknown) branchFreshness = {required: strict, available: false, error: 'The strict up-to-date check policy was not fully returned.'};
  if (strict) {
    // The PR's saved base SHA can lag the actual base branch tip.
    const branch = request(root + '/branches/' + endpointPart(pr.base.ref));
    const baseTipSha = branch.available && branch.data?.commit?.sha;
    const compare = typeof baseTipSha === 'string' && baseTipSha ? request(root + '/compare/' + endpointPart(baseTipSha) + '...' + endpointPart(pr.head.sha)) : {available: false};
    branchFreshness = compare.available && Number.isSafeInteger(compare.data?.behind_by) && compare.data.behind_by >= 0 ?
      {required: true, available: !strictUnknown, baseTipSha, behindBy: compare.data.behind_by, ...(strictUnknown ? {error: 'Some strict-check policy fields were unavailable.'} : {})} :
      {required: true, available: false, error: 'The required branch up-to-date comparison could not be confirmed.'};
  }
  const checks = sha => normalizeChecks(pages(request, root + '/commits/' + endpointPart(sha) + '/check-runs?filter=latest', data => data.check_runs), sha);
  const statuses = sha => normalizeStatuses(pages(request, root + '/commits/' + endpointPart(sha) + '/statuses'));
  const headChecks = checks(pr.head.sha);
  const headStatuses = statuses(pr.head.sha);
  const mergeSha = pr.mergeable === true ? pr.merge_commit_sha || null : null;
  const mergeUnavailable = {available: false, error: 'A current test-merge commit could not be confirmed; GitHub mergeability is unknown or conflicting.'};
  const mergeChecks = mergeSha ? checks(mergeSha) : mergeUnavailable;
  const mergeStatuses = mergeSha ? statuses(mergeSha) : mergeUnavailable;
  const files = pages(request, root + '/pulls/' + number + '/files');
  if (files.available) {
    files.data = files.data.map(file => file.filename);
    files.truncated = files.data.length !== pr.changed_files;
  }
  const commits = pages(request, root + '/pulls/' + number + '/commits');
  const previousSha = commits.available && commits.data.length > 1 && commits.data.at(-1).sha === pr.head.sha ? commits.data.at(-2).sha : null;
  const previousChecks = previousSha ? checks(previousSha) : {available: true, data: []};
  const runsResult = pages(request, root + '/actions/runs?head_sha=' + endpointPart(pr.head.sha), data => data.workflow_runs);
  const runs = runsResult.available ? {...runsResult, data: runsResult.data.map(run => ({
    id: run.id, event: run.event, path: run.path, suiteId: run.check_suite_id, url: run.html_url
  }))} : runsResult;
  const headRoot = pr.head.repo?.full_name && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pr.head.repo.full_name) ?
    'repos/' + pr.head.repo.full_name : root;
  const workflows = readWorkflows(request, headRoot, pr.head.sha);
  const baseWorkflows = readWorkflows(request, root, pr.base.sha);
  return {schemaVersion: 1, repository, collectedAt: new Date().toISOString(),
    pr: {number, url: pr.html_url, draft: Boolean(pr.draft), mergeable: pr.mergeable, headSha: pr.head.sha, baseSha: pr.base.sha,
      headBranch: pr.head.ref, baseBranch: pr.base.ref, mergeSha,
      fork: pr.head.repo?.full_name !== pr.base.repo.full_name},
    classic, rulesets, branchFreshness, headChecks, headStatuses, mergeChecks, mergeStatuses, files,
    previousChecks, runs, workflows, baseWorkflows};
}
