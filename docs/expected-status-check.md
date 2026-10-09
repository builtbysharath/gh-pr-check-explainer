# GitHub required check stuck on “Expected — Waiting for status to be reported”

A missing required check is different from a failed test. The branch policy expects a named result, but GitHub has not received an eligible result for the evaluated commit.

Start with three questions:

1. **What exact check name does the policy require?** Compare the requirement with the reported job/check names. A renamed job can leave an old name required.
2. **Did the workflow run for this change?** Branch/path filters can prevent an entire workflow from running. A skipped job inside a running workflow has different behavior.
3. **Which commit, event and reporting App supplied the result?** An older success or a result from the wrong App may not satisfy the requirement. Some Actions events do not produce eligible PR checks.

GitHub documents these distinctions in [Troubleshooting required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks). Confirm the actual policy and workflow before changing either.

## Inspect the evidence

[PR Check Explainer](../README.md) reads required-check policy, results and supported workflow configuration. It shows where evidence is incomplete. It does not edit policy or rerun workflows.

```sh
node bin/gh-pr-check-explainer.js --repo OWNER/REPO --pr NUMBER
```

For a fictional path-filter example, use `--snapshot examples/path-filter.json`. The [example HTML report](path-filter-report.html) and README screenshot show the result. This synthetic example does not establish a root cause on a live repository.

The tool covers required checks, not all merge conditions. [Coverage](COVERAGE.md) lists unsupported cases. If it helped with a real public PR, an issue describing what you verified is more useful than an unverified claim that it fixed the PR.
