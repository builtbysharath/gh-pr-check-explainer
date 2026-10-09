# Public PR benchmark — 9 October 2026

This compares captured public GitHub evidence, not current PR state or complete merge readiness. All commands were read-only. `gh` 2.93.0 and the verified official gh-x 0.19.4 binary were used.

| Case | PR Check Explainer | GitHub CLI `pr checks --required` JSON | gh-x `pr list` JSON |
|---|---|---|---|
| [Next.js #99728](https://github.com/vercel/next.js/pull/99728), ready PR | `thank you, next` failed; `thank you, build` passed; skipped release job satisfies its requirement | Same three reported outcomes | Overall `checks: fail` |
| [Next.js #99933](https://github.com/vercel/next.js/pull/99933), draft PR | Names missing required `thank you, next`; the other two required results satisfy policy | Lists the two reported results, omitting the missing required context | Overall `checks: pending` |

Both target `canary`. At capture, active ruleset 15507172 required three contexts from GitHub Actions App 15368. The missing context was confirmed by a complete check-run/status collection, rather than inferred from a partially fetched first page. Follow-up GETs confirmed that each PR still had the captured head SHA and recorded draft status.

Captured heads:

- #99728: `fb4f63510ce699111024a01a360dec4a13fa1990`.
- #99933: `1ea0528e5d5248b581a208f158ec0a3c0286d074`.

## What this demonstrates

The tool identifies a required context absent from the observed results and links it to policy, reporting App, workflow configuration and evaluated SHA. The competitors' captured summaries do not name that missing context. On the failed-check control, all tools agree.

The second PR is a draft. Missing results can be expected during a draft workflow; this is **not** evidence of an actual broken workflow, a failed job, or an improper repository configuration. The inspector does not claim to know why the workflow has not reported. The draft context is now retained by collection and displayed in the report.

This is a narrow, reproducible difference, not proof that these tools never expose the information elsewhere, that gh-x is unsuitable, or that there is substantial demand. Path-filter, renamed-job, wrong-App and older-commit explanations are still validated primarily with synthetic cases.

## Repeat locally

The compact public fixtures omit workflow source and unrelated jobs; the full captured evidence and competitor JSON remain in ignored local `reports/` files.

```sh
node bin/gh-pr-check-explainer.js --snapshot examples/live/next-99933.json --format markdown
node bin/gh-pr-check-explainer.js --repo vercel/next.js --pr 99933 --format html --output report.html
gh pr checks 99933 --repo vercel/next.js --required --json name,state,bucket,workflow,event,link
```

Live results may differ when commits, rules or runs change. An exit code of 1 is expected from the explainer on the captured blocked cases. GitHub CLI's JSON export exit code was not used as a merge-readiness verdict.

Local reports: `reports/live-next-99728.html` and `reports/live-next-99933.html`. Raw snapshots include collection timestamps. Comparator files are named `reports/competitor-gh-next-*` and `reports/competitor-gh-x-next-*`.

Other probed Next.js PRs #99912 and #99929 targeted intermediate stack branches without required checks. They correctly returned no status-check requirements and were excluded from the enforced-check benchmark. Repository search-level CI failure/pending classifications were not treated as proof of required-check failure.

Related primary sources: GitHub's [required-check behavior](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks) and the older [GitHub CLI issue about absent expected checks](https://github.com/cli/cli/issues/6448). That issue motivates the use case; this benchmark does not claim to reproduce its private repository or root cause.
