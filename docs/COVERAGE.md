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

## Scope and limits

The verdict covers required status checks, not reviews, merge conflicts, deployments, merge-queue readiness, or every other merge policy. Live collection supports open PRs on GitHub.com, using its existing `gh` credentials for that host. GitHub Enterprise Server is outside this release's scope. Matrix-expanded names and reusable workflows are not expanded. Base-context `pull_request_target` producers are not assigned a head-workflow filter or rename explanation. Supported filters use `*`, whole-component `**` and ordered `!` patterns. `?`, embedded double stars and other complex syntax remain uncertain. Push path filters are not inferred from the PR diff. Incomplete changed-file lists, unavailable reporting identities, and ambiguous duplicate check names remain explicitly uncertain.

Live requests only read GitHub data. The tool does not check out a repository, execute workflow code, post comments, rerun checks, or change policy. Snapshots and reports may contain private workflow contents: inspect them before sharing. HTML reports contain no scripts or remote assets. The CLI refuses snapshot/report paths that alias one another.

Exit codes: `0` observed checks satisfied or no required checks; `1` blocker; `2` incomplete evidence or error. `--help` lists all options. The snapshot format is illustrated in `examples/path-filter.json`; it is versioned but remains experimental. Earlier snapshots without branch-freshness evidence remain uncertain on that policy.


## Positioning

GitHub CLI, [gh-x](https://github.com/hemsoft-dev/gh-x), and [gh-monitor](https://github.com/elecnix/gh-monitor) already show check states and increasingly account for required checks. This prototype focuses on explaining **why** the expected result is missing, with explicit uncertainty and exportable evidence. [BENCHMARK.md](../BENCHMARK.md) records a real required failure and a draft with a missing required context: the explainer identifies the absent requirement not named in the captured competitor summaries. The root cause of that missing result remains unconfirmed. [VALIDATION.md](../VALIDATION.md) records the controls and remaining demand/coverage gaps.

GitHub's [required-check troubleshooting documentation](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks) and [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) are the behavior references.
