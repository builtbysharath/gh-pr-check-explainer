# Required-check coverage and limitations

## What it explains

- A whole workflow excluded by a supported branch or path filter.
- A required static job removed or renamed between base and head.
- A passing result from the previous PR commit instead of the evaluated commit.
- A check reported by a different GitHub App than the policy requires.
- Failing, running, ambiguous, or missing check results and commit statuses.
- A GitHub Actions result from an event that cannot satisfy the PR requirement.
- Strict required-check policies that require an up-to-date branch, using a captured base/head comparison.
- Missing API access or incomplete collection, which produces an unknown verdict.

It reads active repository/organization rulesets and classic branch protection separately. When results exist on a confirmed current test-merge commit, that commit takes precedence. Unknown/conflicting mergeability produces incomplete merge coverage. A null classic rule on a protected or unreadable base branch remains unknown rather than assuming no classic requirements. A skipped **job** can pass; a filtered-out **workflow** can leave a required check missing.

Evidence links point to the observed run, ruleset, and workflow at its captured SHA. A filter diagnosis says the configuration can explain the missing result; the tool does not execute or simulate Actions.

## Branch audit

`--audit` reads a branch's required checks, whether it has a merge queue, and the workflows at the branch's latest commit. For each required check it finds the workflow jobs with that name. Workflows that run for ordinary pull requests into the branch come first. Copies limited to other branches only count when nothing else reports the name, and `workflow_call`-only workflows never count. Findings:

- `workflow_path_filtered`, `workflow_branch_filtered`, `workflow_types_filtered`: a `pull_request` or `pull_request_target` filter skips some pull requests into the branch. When an unfiltered `push` trigger also exists, the report says this mainly affects forks.
- `workflow_push_only`: only `push` runs the workflow, so pull requests from forks never get the check.
- `workflow_has_no_pr_event`: the reporting workflow only runs on events such as `schedule` or `workflow_dispatch`, or pushes to exact branch names.
- `no_producer`: no workflow job has the name, and the rule requires GitHub Actions (App 15368). Without that requirement, or with job names that could not be expanded, the check is unknown.
- `ambiguous_producers`: several workflows report the name.
- `merge_queue_not_triggered`: the branch has a merge queue, and the workflow has no `merge_group` trigger for it. A `push` trigger whose branch filter admits the queue's `gh-readonly-queue/BRANCH/...` branches also counts; GitHub runs push workflows on those branches.

The merge queue comes from GraphQL `mergeQueue(branch:)` or a ruleset `merge_queue` rule. Its settings are not visible to readers. When a rule accepts a check from any source, risks note that another app or commit status could still report it. Job `if:` conditions, workflow changes inside a pull request, and push `paths` filters on the queue branch are not evaluated.

## Scope and limits

The verdict covers required status checks, not reviews, merge conflicts, deployments, merge-queue readiness, or every other merge policy. Live collection supports open PRs on GitHub.com, using its existing `gh` credentials for that host. GitHub Enterprise Server is outside this release's scope. Matrix job names are expanded as GitHub names them, including `include` and `exclude`, checked against check runs GitHub created. A matrix job with an `if` condition can also report its plain job name, which GitHub uses when the condition skips the job. Matrices or names built from expressions other than `matrix.*`, and reusable workflows, are not expanded. Base-context `pull_request_target` producers are not assigned a head-workflow filter or rename explanation. Supported filters use `*`, whole-component `**` and ordered `!` patterns. `?`, embedded double stars and other complex syntax remain uncertain. Push path filters are not inferred from the PR diff. Incomplete changed-file lists, unavailable reporting identities, and ambiguous duplicate check names remain explicitly uncertain.

Live requests only read GitHub data. The tool does not check out a repository, execute workflow code, post comments, rerun checks, or change policy. Snapshots and reports may contain private workflow contents: inspect them before sharing. HTML reports contain a fixed clipboard helper allowed by a CSP hash, with manual text selection as a fallback. They load no remote assets and block network connections. The CLI refuses snapshot/report paths that alias one another.

Exit codes: `0` observed checks satisfied or no required checks; `1` blocker (with `--audit`, a risk); `2` incomplete evidence or error. `--help` lists all options. The snapshot format is illustrated in `examples/path-filter.json`; it is versioned but remains experimental. Earlier snapshots without branch-freshness evidence remain uncertain on that policy.


## Positioning

GitHub CLI, [gh-x](https://github.com/hemsoft-dev/gh-x), and [gh-monitor](https://github.com/elecnix/gh-monitor) already show check states and increasingly account for required checks. This prototype focuses on explaining **why** the expected result is missing, with explicit uncertainty and exportable evidence. [BENCHMARK.md](../BENCHMARK.md) records a real required failure and a draft with a missing required context: the explainer identifies the absent requirement not named in the captured competitor summaries. The root cause of that missing result remains unconfirmed. [VALIDATION.md](../VALIDATION.md) records the controls and remaining demand/coverage gaps.

GitHub's [required-check troubleshooting documentation](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks) and [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) are the behavior references.
