# Contributing

Open a narrowly scoped issue with a reproducible example before proposing a large change. Include the Node version, expected result and actual result. Remove tokens, private workflow content, names and document excerpts before sharing reports. A minimal fictional fixture is preferred.

Run `npm ci` and `npm test`. PR Check Explainer also runs `npm run check`; Word Sharing Inspector runs `npm run build` and `npm start` for a browser smoke test. Preserve conservative unknown/coverage outcomes. Never execute captured workflows, open document links, upload documents or rewrite input files as part of inspection.

Add a focused regression when fixing a behavior defect. Use your own fictional data, or document the source and redistribution license. Downloaded third-party corpus files and live snapshots belong in the ignored `reports/` directory. Do not submit generated reports containing private data.
