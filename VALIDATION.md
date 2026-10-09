# Validation: 9 October 2026

## Reproducible diagnosis

`npm test`: 45 tests passed on Node 22.23.3 and the development runtime (Node 23.10.0), including collector hardening, draft context and compact captured-public regression cases. Synthetic snapshots exercise filtered workflows, renamed jobs, wrong reporting Apps, older successful commits, incomplete permissions, and test-merge precedence. The synthetic report is `reports/path-filter.html`; it is not evidence of a live affected repository.

## Live read-only control

Ran this collector on [cli/cli PR 14629](https://github.com/cli/cli/pull/14629). The captured policy had no required status checks, so the report returned `none`. GitHub CLI's `gh pr checks --required` likewise reported no required checks. The captured report and snapshot are under `reports/live-cli-14629.*`.

Downloaded gh-x v0.19.4 from its official repository release and verified its SHA-256 against the GitHub asset digest before running its read-only `pr list` command on the same PR. Its JSON showed `checks: pass`; it also showed review/approval information outside this tool's scope. Output is `reports/competitor-gh-x-cli-14629.json`. SHA-256: `ba243cd9a2e801eb607aa906938c5df01c67498e7609643d44203a7fcd248d42`.

This initial control verifies live collection and basic agreement. gh-monitor was reviewed from its documentation, not executed. No repository, review, policy, workflow run, or comment was changed.

## Enforced-check public benchmark

[BENCHMARK.md](BENCHMARK.md) records Next.js #99728 (required failure) and #99933 (missing required result on a draft). The failure matches GitHub CLI and gh-x. In the draft case, the explainer names the missing required context omitted by the captured GitHub CLI result list; gh-x reports overall pending. This demonstrates a narrow information difference, not an inferred workflow bug or broad competitive superiority. Source heads were verified unchanged across comparison. Draft context is now visible in reports.

Live path-filter, renamed-job, wrong-App and stale-commit reproductions remain outstanding. Developer feedback remains outstanding. Separate static reviews were run using the installed Claude Code default model (`claude-opus-5-5`) with no tools or agents. Findings led to fixes for filter semantics, stale merge evidence, protection visibility, strict up-to-date checks, report writes and source identity. Review evidence and source manifests are in the sibling release folder; the review does not replace runtime testing.

## Decision

The explanation core is worth showing to developers who handle stuck required checks. The surrounding market is served by existing tools, so broad claims of uniqueness or demand would be premature. A reusable core and adapters for an existing project may be a better OSS contribution route than a separate dashboard.

A new local prototype alone does not demonstrate the community impact required for discretionary Claude for Open Source consideration.

## Final collector behavior

A fresh cli/cli #14629 capture on 9 October returned `unknown`: the API returned no classic rule while the base branch was protected, so the new guard could not confirm complete classic policy visibility. This supersedes the initial `none` control for the hardened collector. It is an intentional conservative outcome, not evidence of a required-check failure. The earlier Next.js captures still demonstrate the named required contexts, and their missing branch-freshness evidence is now explicitly identified as legacy coverage.

## Release checks

Clean packed-package installation, CLI help/demo and library import were verified. The published v0.1.0 commit passed all four GitHub CI jobs on Linux/macOS with Node 22/24 ([run 37958226566](https://github.com/builtbysharath/gh-pr-check-explainer/actions/runs/37958226566)). Source and package SHA-256 manifests accompany the release. These local validation runs preceded public GitHub publication. No OSS-program application was submitted.

Publication: the repository CI matrix checks Linux/macOS on Node 22/24. Its live status is shown by the README badge. Local source validation and captured benchmarks remain dated evidence, not a promise that every live case or Office producer is supported.
