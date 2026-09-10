# QB Synergy

This folder is the maintained website source, deployed at https://jjparker34.github.io/qb-synergy/.
The repository-root HTML and `outputs/` copies are historical and are not published by the workflow.

## Refresh

From the repository root:

```powershell
python -m pip install -r requirements-qb-synergy.txt
python build_qb_synergy_data.py --season 2026 --output-dir qb_synergy_dashboard --refresh
```

The builder refreshes play-by-play, players, and schedules. Omit `--refresh` for a cached rebuild;
`--cache-dir` overrides the private download cache. Active season is configured in `qb-synergy-config.json`,
not inferred from the calendar year. Keep it at 2026 through the playoffs in 2027.

`data/manifest.json` lists seasons. Each season has REG/POST/ALL datasets, recent-window aggregates,
weekly rows, and corrected cumulative snapshots. Root `data*.json` files retain the corrected legacy 2025
export but are not shipped in the new artifact. The maintained 2025 archive is rebuilt with corrected
ordinary-target counts, fullbacks in the RB group, and quarterback/team denominators. Method 2026.4
retains the weights and one-target eligibility while correcting zero-event credit, ties, observation
counts, missing-input handling, and rounding across every season and view.

Scores require at least one target in every season, scope, and time window, including the 2025 archive.
Season-to-date and last-four-week scores are provisional below 30 targets (5 in playoffs). Rankings
default to provisional scores until qualified connections exist; All connections also includes rows
with unavailable scores. Weekly scores use their own peer pool and stabilization.

Method 2026.4 awards YAC points only when modeled receptions are available. Zero receptions or missing
YAC model coverage receive 0 of the 7 YAC points; the rest of the score is calculated normally. Missing
YAC model coverage is labeled beside the score and in its explanation. Raw YAC per reception remains
unavailable and is excluded from YAC comparison samples. Other missing model inputs still suppress the composite.

Zero usage, successful targets, first downs, or explosive plays earn zero for their component. Other
percentiles use midpoint ties. Missing opportunity shares remain null and earn no credit. Zero-event
penalties are zero; positive penalty ties use midpoint ranks. Component and penalty hundredths are
summed as integers before final half-up rounding. Modeled receptions determine YAC stabilization;
CPOE/success use covered targets, and QB lift uses the smaller of duo and other-receiver target counts.
The UI exposes sample and coverage flags and uses component points for its profile bars.

Method 2026.4 changes red-zone share to the selected connection's red-zone targets divided by all
team red-zone targets in the same scope/window. Team totals include every passer and receiver position,
while the leaderboard still compares WR/TE and RB/FB connections. `teamRedZoneTargets` and
`recentTeamRedZoneTargets` preserve team context independently of published receiver rows; weekly entries
also contain `teamRedZoneTargets`, including targets to positions outside the scored groups. The raw
share is ranked among peers for the existing four-point component. Zero targets earn zero credit.

## Verification

```powershell
python -m unittest discover -s tests -p test_qb_synergy.py
node --test tests/score.test.cjs tests/search.test.cjs
node scripts/audit_qb_synergy.cjs --output qb_synergy_dashboard/output/audit/score-validation-2026-4.json
python scripts/package_qb_synergy.py --check
python -m http.server 8765 --directory qb_synergy_dashboard
```

Check 2026 pending data, 2025 REG/POST/ALL, both time windows, provisional/raw filters, and existing duo links.
The browser uses one shared scorer. Historic score and rank changes are recalculated from corrected data.
Packaging runs the complete score audit after any fresh download and before committing or deploying data.
It checks every category in WR, TE, RB, and FB, exact component/penalty arithmetic, and weekly aggregation
against season, recent, and cumulative snapshots. The workflow summary reports validation counts.

## Deployment

`.github/workflows/qb-synergy.yml` refreshes every day at 13:23 UTC (8:23 a.m. Central during daylight time,
7:23 a.m. during standard time), incorporating the previous day's games as nflverse publishes them.
It also supports a manual refresh through Actions > Refresh and deploy QB Synergy > Run workflow. Website pushes deploy existing
validated assets without downloading new data. Pages uses GitHub Actions as its publishing source.
Only the staged website assets are published; caches, source scripts, tests, screenshots, and other projects
in the repository are excluded. The refresh commits only `qb_synergy_dashboard/data`, then deploys in the
same run. Do not rely on a bot commit to trigger a separate deployment.

Failures leave the prior Pages deployment available. Check the workflow summary for source fingerprint,
game counts, and completed weeks. Retry a delayed upstream release manually. Public-repository schedules
may be disabled by GitHub after 60 days without repository activity; verify Actions is enabled before
resuming after the offseason. To roll back a UI change, revert its specific commit and let the push workflow
deploy the prior implementation. Restore a known-good data commit if a data rollback is necessary.
