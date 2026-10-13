# Changelog

## 0.3.0: GitHub Action and branch audit, 2026-10-13

- `--audit OWNER/REPO [--branch NAME]` compares a branch's required checks with its workflows before any pull request gets stuck. It flags `paths`, `branches` and `types` filters on the reporting workflow, push-only workflows, workflows with no pull request event, required names that no workflow reports, names that several workflows report, and merge queues that the reporting workflow doesn't run for. Tried on 11 public repositories, 7 of them with merge queues.
- GitHub Action: `uses: builtbysharath/gh-pr-check-explainer@v0` on `pull_request` writes the report to the job summary and posts one PR comment, kept up to date, when a required check can't report because of configuration. Outputs `verdict` and `stuck-checks`; `fail-on-stuck` can fail the job. Tested end to end on a repository with a classic-protection check and a ruleset check, both from path-filtered workflows.
- Read the classic rule from the branch summary for workflow and app tokens too, which get a GraphQL error instead of null.
- Expand matrix job names the way GitHub names their check runs (for example `build (macos-latest)`), including `include`, `exclude` and `${{ matrix.* }}` in job names. The rules were checked against the 34 check runs GitHub created for 19 matrix jobs. Required matrix checks can now be traced to their workflow.
- New cause `workflow_awaiting_approval`: the required check's workflow run is waiting for a maintainer to approve workflows from a fork (seen on cli/cli#14646).
- Diagnose classic branch protection without admin access. GitHub's GraphQL API hides the classic rule from read-only tokens, so contributors got an "unknown" verdict. The required checks now come from the base branch summary, which any reader can see. That summary does not say whether the branch must be up to date, so that part stays unknown.
- JSON reports give each required check a `cause` when configuration explains a missing or ineligible result (`workflow_filtered`, `workflow_has_no_pr_event`, `job_removed_or_renamed`, `wrong_reporting_app`, `ineligible_workflow_event`). It is set even when `code` reports an older passing commit first, as when a PR's changes become docs-only after CI passed (for example by reverting a source change), so a path filter now skips the workflow.

## 0.2.0: GitHub CLI extension, 2026-10-11

- Install with `gh extension install builtbysharath/gh-pr-check-explainer`, then run `gh pr-check-explainer <PR URL>`. The extension runs a committed single-file bundle that CI rebuilds and compares with the source.
- Pass a standard `https://github.com/OWNER/REPO/pull/NUMBER` URL instead of `--repo` and `--pr`.
- The example report links back to the overview and to trying the tool, shows fictional evidence without clickable links, and has Copy buttons for its Markdown and the install command.

## 0.1.0: initial prerelease, 2026-10-09

First public prerelease: reusable inspection/analysis library, read-only CLI, explicit coverage and unsupported-case reporting, fictional regression fixtures and documented validation. Published on GitHub; npm registry publication has not occurred.
