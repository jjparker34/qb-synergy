# QB Synergy

The maintained website source is [`qb_synergy_dashboard/`](qb_synergy_dashboard/README.md).
Live site: https://jjparker34.github.io/qb-synergy/

2026 data refreshes automatically Tuesday and Thursday at 13:23 UTC through GitHub Actions.
The corrected 2025 archive is available in the season selector. Use the dashboard README for
manual refresh, tests, deployment, and rollback instructions.

The root HTML/data copies and `outputs/` directory are historical; the Actions deployment
packages only the maintained dashboard source. Active season is set explicitly in
`qb-synergy-config.json`, including postseason games in the following calendar year.
