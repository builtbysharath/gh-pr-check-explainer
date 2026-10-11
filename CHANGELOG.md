# Changelog

## Unreleased

- Diagnose classic branch protection without admin access. GitHub's GraphQL API hides the classic rule from read-only tokens, so contributors got an "unknown" verdict. The required checks now come from the base branch summary, which any reader can see. That summary does not say whether the branch must be up to date, so that part stays unknown.

## 0.2.0: GitHub CLI extension, 2026-10-11

- Install with `gh extension install builtbysharath/gh-pr-check-explainer`, then run `gh pr-check-explainer <PR URL>`. The extension runs a committed single-file bundle that CI rebuilds and compares with the source.
- Pass a standard `https://github.com/OWNER/REPO/pull/NUMBER` URL instead of `--repo` and `--pr`.
- The example report links back to the overview and to trying the tool, shows fictional evidence without clickable links, and has Copy buttons for its Markdown and the install command.

## 0.1.0: initial prerelease, 2026-10-09

First public prerelease: reusable inspection/analysis library, read-only CLI, explicit coverage and unsupported-case reporting, fictional regression fixtures and documented validation. Published on GitHub; npm registry publication has not occurred.
