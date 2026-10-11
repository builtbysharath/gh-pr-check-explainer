import {execFileSync} from 'node:child_process';

const QUERY = 'query($owner:String!,$repo:String!,$number:Int!) { repository(owner:$owner,name:$repo) { pullRequest(number:$number) { baseRef { branchProtectionRule { requiresStatusChecks requiresStrictStatusChecks requiredStatusChecks { context app { databaseId slug } } } } } } }';
// Any reader can see whether a branch has a merge queue; its settings stay hidden.
const MERGE_QUEUE_QUERY = 'query($owner:String!,$repo:String!,$branch:String!) { repository(owner:$owner,name:$repo) { mergeQueue(branch:$branch) { id } } }';
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
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

async function pages(request, endpoint, extract = data => data) {
  const items = [];
  for (let page = 1; page <= 20; page++) {
    const result = await request(endpoint + (endpoint.includes('?') ? '&' : '?') + 'per_page=100&page=' + page);
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

async function readWorkflows(request, root, ref) {
  const listing = await request(root + '/contents/.github/workflows?ref=' + endpointPart(ref));
  if (!listing.available) {
    // A missing directory is only accepted when the git tree confirms it.
    const tree = await request(root + '/git/trees/' + endpointPart(ref) + '?recursive=1');
    if (!tree.available || tree.data.truncated) return {available: false, error: listing.error};
    if (tree.data.tree.some(entry => entry.path.startsWith('.github/workflows/'))) return {available: false, error: listing.error};
    return {available: true, data: []};
  }
  if (!Array.isArray(listing.data)) return {available: false, error: 'Workflow directory response is not a list.'};
  const files = listing.data.filter(item => item.type === 'file' && /\.ya?ml$/.test(item.name));
  if (files.length > 100) return {available: false, error: 'More than 100 workflows; supported collection limit exceeded.'};
  const contents = [];
  for (const file of files) {
    const result = await request(root + '/contents/' + file.path.split('/').map(endpointPart).join('/') + '?ref=' + endpointPart(ref));
    if (!result.available || result.data.encoding !== 'base64' || result.data.size > 1_000_000) {
      return {available: false, error: 'Could not read the complete workflow ' + file.path + '.'};
    }
    contents.push({path: file.path, repository: root.slice('repos/'.length), text: Buffer.from(result.data.content, 'base64').toString('utf8')});
  }
  return {available: true, data: contents};
}

// The branch summary lists classic required checks to any reader, but not
// whether the branch must be up to date.
function summaryPolicy(branch, classicCheck) {
  const summary = branch.available && branch.data.protected === true ? branch.data.protection : null;
  const summaryChecks = summary?.required_status_checks;
  return branch.available && branch.data.protected === false ||
    summary?.enabled === false || summary?.enabled === true && summaryChecks?.enforcement_level === 'off' ? {available: true, strict: false, checks: []} :
    summary?.enabled === true && Array.isArray(summaryChecks?.checks) ?
    {available: true, strict: undefined, fromSummary: true, checks: summaryChecks.checks.map(check => classicCheck(check.context, check.app_id))} :
    {available: false, error: 'No classic rule was returned; the branch is protected or its protection state could not be confirmed.'};
}

async function rulesetPolicy(request, root, repository, branch) {
  const rulesResult = await pages(request, root + '/rules/branches/' + endpointPart(branch));
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
  return {rulesResult, rulesets};
}

// Reads a branch's required checks, merge queue and workflows, so they can be
// compared before any pull request gets stuck.
export async function collectRepository(repository, branch, request = ghRequest) {
  if (!REPOSITORY.test(repository) || repository.startsWith('-')) throw new Error('Use --audit OWNER/REPO.');
  if (branch !== undefined && (typeof branch !== 'string' || !branch || branch.length > 255 || /[\u0000-\u0020\u007f~^:?*[\\]/.test(branch))) throw new Error('Use a valid branch name with --branch.');
  const [owner, repo] = repository.split('/');
  const root = 'repos/' + repository;
  const info = await request(root);
  if (!info.available) throw new Error(info.error);
  const name = branch || info.data.default_branch;
  const tip = await request(root + '/branches/' + endpointPart(name));
  if (!tip.available) throw new Error('Could not read branch ' + name + ': ' + tip.error);
  const sha = tip.data.commit?.sha;
  if (typeof sha !== 'string' || !sha) throw new Error('GitHub did not return the commit of branch ' + name + '.');
  const classic = summaryPolicy(tip, (context, appId) => ({context, appId: appId || null, source: 'classic branch protection', url: info.data.html_url + '/settings/branches'}));
  const {rulesResult, rulesets} = await rulesetPolicy(request, root, repository, name);
  const queue = await request('graphql', {query: MERGE_QUEUE_QUERY, variables: {owner, repo, branch: name}});
  const queueRepository = queue.available ? queue.data?.data?.repository : undefined;
  const mergeQueue = rulesResult.available && rulesResult.data.some(rule => rule.type === 'merge_queue') ? {available: true, enabled: true} :
    queueRepository && typeof queueRepository === 'object' ? {available: true, enabled: queueRepository.mergeQueue != null} :
    {available: false, error: queue.error || 'GitHub did not say whether the branch uses a merge queue.'};
  const workflows = await readWorkflows(request, root, sha);
  return {schemaVersion: 1, kind: 'repository', repository, branch: name, sha, url: info.data.html_url, collectedAt: new Date().toISOString(),
    classic, rulesets, mergeQueue, workflows};
}

export async function collect(repository, number, request = ghRequest) {
  if (!REPOSITORY.test(repository) || repository.startsWith('-') ||
      !Number.isSafeInteger(number) || number < 1) throw new Error('Use --repo OWNER/REPO and a positive --pr number.');
  const [owner, repo] = repository.split('/');
  const root = 'repos/' + repository;
  const pull = await request(root + '/pulls/' + number);
  if (!pull.available) throw new Error(pull.error);
  const pr = pull.data;
  if (pr.state !== 'open') throw new Error('Live diagnosis supports open pull requests; use a captured snapshot for closed examples.');
  const classicResult = await request('graphql', {query: QUERY, variables: {owner, repo, number}});
  const rule = classicResult.available ? classicResult.data?.data?.repository?.pullRequest?.baseRef?.branchProtectionRule : null;
  const classicCheck = (context, appId) => ({context, appId: appId || null, source: 'classic branch protection', url: pr.base.repo.html_url + '/settings/branches'});
  let classic;
  if (rule) {
    classic = rule.requiresStatusChecks && !Array.isArray(rule.requiredStatusChecks) ? {available: false, error: 'Required classic checks were not returned.'} :
      {available: true, strict: rule.requiresStatusChecks ? rule.requiresStrictStatusChecks : false,
        checks: rule.requiresStatusChecks ? rule.requiredStatusChecks.map(check => classicCheck(check.context, check.app?.databaseId)) : []};
  } else {
    // GraphQL hides the classic rule from tokens without admin access: people
    // get null, and app and workflow tokens get a FORBIDDEN error. The branch
    // summary still lists its required checks, though not its strict policy.
    classic = summaryPolicy(await request(root + '/branches/' + endpointPart(pr.base.ref)), classicCheck);
  }
  const {rulesResult, rulesets} = await rulesetPolicy(request, root, repository, pr.base.ref);
  const statusRules = rulesResult.available ? rulesResult.data.filter(rule => rule.type === 'required_status_checks') : [];
  const strictUnknown = classic.available && classic.checks.length > 0 && typeof classic.strict !== 'boolean' || statusRules.some(rule => typeof rule.parameters?.strict_required_status_checks_policy !== 'boolean');
  const strict = classic.strict === true || statusRules.some(rule => rule.parameters?.strict_required_status_checks_policy === true);
  let branchFreshness = {required: strict, available: !strictUnknown, behindBy: 0};
  if (strictUnknown) branchFreshness = {required: strict, available: false, error: classic.fromSummary ?
    'Without admin access, GitHub does not show whether classic branch protection requires an up-to-date branch.' :
    'The strict up-to-date check policy was not fully returned.'};
  if (strict) {
    // The PR's saved base SHA can lag the actual base branch tip.
    const branch = await request(root + '/branches/' + endpointPart(pr.base.ref));
    const baseTipSha = branch.available && branch.data?.commit?.sha;
    const compare = typeof baseTipSha === 'string' && baseTipSha ? await request(root + '/compare/' + endpointPart(baseTipSha) + '...' + endpointPart(pr.head.sha)) : {available: false};
    branchFreshness = compare.available && Number.isSafeInteger(compare.data?.behind_by) && compare.data.behind_by >= 0 ?
      {required: true, available: !strictUnknown, baseTipSha, behindBy: compare.data.behind_by, ...(strictUnknown ? {error: 'Some strict-check policy fields were unavailable.'} : {})} :
      {required: true, available: false, error: 'The required branch up-to-date comparison could not be confirmed.'};
  }
  const checks = async sha => normalizeChecks(await pages(request, root + '/commits/' + endpointPart(sha) + '/check-runs?filter=latest', data => data.check_runs), sha);
  const statuses = async sha => normalizeStatuses(await pages(request, root + '/commits/' + endpointPart(sha) + '/statuses'));
  const headChecks = await checks(pr.head.sha);
  const headStatuses = await statuses(pr.head.sha);
  const mergeSha = pr.mergeable === true ? pr.merge_commit_sha || null : null;
  const mergeUnavailable = {available: false, error: 'A current test-merge commit could not be confirmed; GitHub mergeability is unknown or conflicting.'};
  const mergeChecks = mergeSha ? await checks(mergeSha) : mergeUnavailable;
  const mergeStatuses = mergeSha ? await statuses(mergeSha) : mergeUnavailable;
  const files = await pages(request, root + '/pulls/' + number + '/files');
  if (files.available) {
    files.data = files.data.map(file => file.filename);
    files.truncated = files.data.length !== pr.changed_files;
  }
  const commits = await pages(request, root + '/pulls/' + number + '/commits');
  const previousSha = commits.available && commits.data.length > 1 && commits.data.at(-1).sha === pr.head.sha ? commits.data.at(-2).sha : null;
  const previousChecks = previousSha ? await checks(previousSha) : {available: true, data: []};
  const runsResult = await pages(request, root + '/actions/runs?head_sha=' + endpointPart(pr.head.sha), data => data.workflow_runs);
  const runs = runsResult.available ? {...runsResult, data: runsResult.data.map(run => ({
    id: run.id, event: run.event, path: run.path, suiteId: run.check_suite_id, url: run.html_url,
    status: run.status, conclusion: run.conclusion
  }))} : runsResult;
  const headRoot = pr.head.repo?.full_name && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pr.head.repo.full_name) ?
    'repos/' + pr.head.repo.full_name : root;
  const workflows = await readWorkflows(request, headRoot, pr.head.sha);
  const baseWorkflows = await readWorkflows(request, root, pr.base.sha);
  return {schemaVersion: 1, repository, collectedAt: new Date().toISOString(),
    pr: {number, url: pr.html_url, draft: Boolean(pr.draft), mergeable: pr.mergeable, headSha: pr.head.sha, baseSha: pr.base.sha,
      headBranch: pr.head.ref, baseBranch: pr.base.ref, mergeSha,
      fork: pr.head.repo?.full_name !== pr.base.repo.full_name},
    classic, rulesets, branchFreshness, headChecks, headStatuses, mergeChecks, mergeStatuses, files,
    previousChecks, runs, workflows, baseWorkflows};
}
