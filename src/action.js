import {appendFileSync, readFileSync} from 'node:fs';
import {analyze} from './analyze.js';
import {collect} from './github.js';
import {markdown, markdownText, markdownUrl} from './render.js';

const API = 'https://api.github.com/';
const MARKER = '<!-- gh-pr-check-explainer -->';
const DOCS = 'https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks';
// Causes that mean a required result will not arrive until something changes.
const STUCK = {
  workflow_filtered: {why: 'The workflow that reports it does not run for this PR.', fix: 'Remove the `paths` or `branches` filter from that workflow, or report this check name from a job that always runs.'},
  workflow_has_no_pr_event: {why: 'The workflow that reports it has no pull request event.', fix: 'Add a `pull_request` trigger to that workflow, or require a different check.'},
  job_removed_or_renamed: {why: 'This PR removes or renames the job that reports it.', fix: 'Keep the job name, or update the required check in the branch rule when this PR merges.'},
  wrong_reporting_app: {why: 'A check with this name comes from a different GitHub App than the rule requires.', fix: 'Change the app the rule expects, or report the check from the expected app.'},
  ineligible_workflow_event: {why: 'Its only result comes from an event that cannot satisfy a pull request requirement.', fix: 'Run the job on `pull_request` as well.'}
};

function headers(token, json) {
  return {accept: 'application/vnd.github+json', authorization: 'Bearer ' + token,
    'x-github-api-version': '2022-11-28', 'user-agent': 'gh-pr-check-explainer', ...(json ? {'content-type': 'application/json'} : {})};
}

// The collector's request interface over fetch: GET, or POST for the read-only
// GraphQL query. It never throws; failures come back as unavailable evidence.
export function fetchRequest(token, fetchImpl = fetch) {
  return async (endpoint, input) => {
    try {
      const response = await fetchImpl(API + endpoint, {method: input ? 'POST' : 'GET', headers: headers(token, Boolean(input)),
        body: input ? JSON.stringify(input) : undefined, signal: AbortSignal.timeout(30_000)});
      if (!response.ok) return {available: false, error: 'GitHub API returned HTTP ' + response.status + '.'};
      const data = await response.json();
      if (data?.errors?.length) return {available: false, error: 'GitHub GraphQL did not return a complete result.'};
      return {available: true, data};
    } catch {
      return {available: false, error: 'GitHub request failed.'};
    }
  };
}

function escapeCommand(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}
function cell(value) {
  return markdownText(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function stuckChecks(report) {
  return report.checks.filter(check => check.state === 'blocked' && Object.hasOwn(STUCK, check.cause));
}
// Whether the evidence was complete enough to say that no required check is stuck.
// Test-merge results count only once GitHub has a test-merge commit; it is often
// still computing mergeability when this runs.
function conclusive(snapshot, report) {
  return ['rulesets', 'classic', 'headChecks', 'headStatuses', 'files', 'runs', 'workflows', 'baseWorkflows'].every(field => snapshot[field]?.available) &&
    (!snapshot.pr.mergeSha || snapshot.mergeChecks?.available && snapshot.mergeStatuses?.available) &&
    !report.checks.some(check => check.state === 'unknown') &&
    // Workflow files that don't parse are listed by path.
    !report.limitations.some(note => /^(Base branch )?\.github\/workflows\//.test(note));
}

export function commentBody(report, stuck, complete = true) {
  if (!stuck.length) {
    return MARKER + '\n### Required checks\n\n' + (complete ? 'No required check is stuck on workflow or rule configuration as of ' + report.headSha + '.' :
      'Could not check the required checks for ' + report.headSha + ' because some evidence could not be read. The job summary for this run lists what is missing.') + '\n';
  }
  const rows = stuck.map(check => {
    const reasons = check.details.filter(detail => /filter excludes|no event|removes|renames|requires GitHub App|ran on /i.test(detail));
    const source = check.evidence.find(item => /\.ya?ml$/.test(item.label) || item.label.startsWith('Base branch producer'));
    const where = source?.url ? ' ([' + cell(source.label.replace('Base branch producer: ', '')) + '](' + markdownUrl(source.url) + '))' : '';
    return '| `' + cell(check.context) + '` | ' + cell(STUCK[check.cause].why + (reasons.length ? ' ' + reasons.join(' ') : '')) + where + ' | ' + cell(STUCK[check.cause].fix) + ' |';
  });
  return [MARKER, '### Required checks that will not report', '',
    'GitHub shows these as "Waiting for status to be reported". They will not arrive for ' + report.headSha + ' as the configuration stands.', '',
    '| Required check | Why | Fix |', '|---|---|---|', ...rows, '',
    '[GitHub troubleshooting guide](' + DOCS + ') · Read-only diagnosis by [PR Check Explainer](https://github.com/builtbysharath/gh-pr-check-explainer). This comment updates on each push.', ''].join('\n');
}

async function api(fetchImpl, token, method, endpoint, body) {
  const response = await fetchImpl(API + endpoint, {method, headers: headers(token, Boolean(body)),
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000)});
  if (!response.ok) throw new Error('GitHub API returned HTTP ' + response.status + ' for ' + method + ' ' + endpoint.replace(/\?.*/, '') + '.');
  return response.status === 204 ? null : response.json();
}

async function findComment(fetchImpl, token, repository, number) {
  // Anyone can post a comment that starts with the marker, so only the token's own comment counts.
  const viewer = await api(fetchImpl, token, 'POST', 'graphql', {query: '{ viewer { login } }'});
  if (typeof viewer?.data?.viewer?.login !== 'string') throw new Error('GitHub did not say which account the token belongs to.');
  const account = login => String(login).replace(/\[bot\]$/, '');
  for (let page = 1; page <= 20; page++) {
    const comments = await api(fetchImpl, token, 'GET', 'repos/' + repository + '/issues/' + number + '/comments?per_page=100&page=' + page);
    const match = comments.find(comment => typeof comment.body === 'string' && comment.body.startsWith(MARKER) &&
      account(comment.user?.login) === account(viewer.data.viewer.login));
    if (match) return match;
    if (comments.length < 100) return null;
  }
  return null;
}

// Posts a comment only when a check is stuck; afterwards keeps that one comment current.
async function updateComment(fetchImpl, token, repository, number, report, stuck, complete) {
  const existing = await findComment(fetchImpl, token, repository, number);
  const body = commentBody(report, stuck, complete);
  if (existing) {
    if (existing.body !== body) await api(fetchImpl, token, 'PATCH', 'repos/' + repository + '/issues/comments/' + existing.id, {body});
  } else if (stuck.length) {
    await api(fetchImpl, token, 'POST', 'repos/' + repository + '/issues/' + number + '/comments', {body});
  }
}

export async function run({env = process.env, fetchImpl = fetch, log = console.log} = {}) {
  const warning = message => log('::warning::' + escapeCommand(message));
  try {
    const token = env['INPUT_GITHUB-TOKEN'];
    if (!token) throw new Error('The github-token input is empty.');
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    const number = event.pull_request?.number;
    if (!Number.isSafeInteger(number)) {
      warning('PR Check Explainer runs on pull_request and pull_request_target events; ' + env.GITHUB_EVENT_NAME + ' has no pull request.');
      return 0;
    }
    const snapshot = await collect(env.GITHUB_REPOSITORY, number, fetchRequest(token, fetchImpl));
    const report = analyze(snapshot);
    const stuck = stuckChecks(report);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown(report));
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, 'verdict=' + report.overall + '\nstuck-checks=' + JSON.stringify(stuck.map(check => check.context)) + '\n');
    if (env.INPUT_COMMENT !== 'false') {
      try {
        await updateComment(fetchImpl, token, env.GITHUB_REPOSITORY, number, report, stuck, conclusive(snapshot, report));
      } catch (error) {
        warning('Could not update the PR comment: ' + error.message + ' Pull requests from forks get a read-only token on pull_request; the job summary has the report.');
      }
    }
    for (const check of stuck) warning('Required check "' + check.context + '" will not report: ' + STUCK[check.cause].why);
    if (stuck.length && env['INPUT_FAIL-ON-STUCK'] === 'true') {
      log('::error::' + escapeCommand(stuck.length + ' required check(s) will not report as configured.'));
      return 1;
    }
    return 0;
  } catch (error) {
    log('::error::' + escapeCommand('PR Check Explainer: ' + error.message));
    return 1;
  }
}
