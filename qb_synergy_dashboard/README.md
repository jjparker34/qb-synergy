# QB Synergy

Static NFL quarterback-to-receiver connection dashboard for the 2025 season.

## Publish to GitHub Pages

Publish this folder's contents from the repository root (or a `/docs` folder), including `index.html`, `top-connections.html`, `methodology.html`, and all three `data*.json` files. Add an empty `.nojekyll` file to the publishing root.

Do not publish `.cache/`, raw nflverse downloads, or local verification screenshots.

## Refresh data

From the project root, run:

```powershell
python build_qb_synergy_data.py
```

Commit the regenerated `data.json`, `data-playoffs.json`, and `data-combined.json` files.

## Data source and method

Play-by-play and player metadata are from [nflverse](https://nflverse.nflverse.com/). The public methodology is available at `methodology.html` in the deployed site.

The Synergy Score weights outcome (60%), trust (25%), and QB-target duo lift (15%), with a maximum five-point negative-play penalty. WR/TE connections are compared together; RB connections are compared only against RB peers.
