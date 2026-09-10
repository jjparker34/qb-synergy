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
export but are not shipped in the new artifact. 2025 counts and core production totals are preserved;
additional one-target duos are available in raw views. Method 2026.2 retains the weights while correcting
missing-input handling and weekly comparison pools.

Scores require at least one target in every season, scope, and time window, including the 2025 archive.
Season-to-date and last-four-week scores are provisional below 30 targets (5 in playoffs). Rankings
default to provisional scores until qualified connections exist; All connections also includes rows
with unavailable scores. Weekly scores use their own peer pool and stabilization.

Method 2026.2 gives connections with zero receptions 0 of the 7 YAC component points, so no catches
alone do not prevent a score. Raw YAC per reception remains unavailable and those connections are
excluded from YAC comparison samples. Other missing model inputs still suppress the composite.

## Verification

```powershell
python -m unittest discover -s tests -p test_qb_synergy.py
node --test tests/score.test.cjs tests/search.test.cjs
python scripts/package_qb_synergy.py --check
python -m http.server 8765 --directory qb_synergy_dashboard
```

Check 2026 pending data, 2025 REG/POST/ALL, both time windows, provisional/raw filters, and existing duo links.
The browser uses one shared scorer. Historic score and rank changes are recalculated from corrected data.

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
