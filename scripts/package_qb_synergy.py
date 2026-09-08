"""Validate and stage only the maintained dashboard's public assets."""
import importlib.util
import shutil
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('builder',ROOT/'build_qb_synergy_data.py')
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
source=ROOT/'qb_synergy_dashboard'
manifest=builder.read_json(source/'data/manifest.json')
if manifest['activeSeason'] not in manifest['seasons']:
    raise ValueError('Active season missing from manifest')
for season in manifest['seasons']:
    for scope in builder.SCOPES:
        data=builder.read_json(source/f'data/{season}/{scope}.json');builder.validate(data)
        for week in data['snapshotWeeks']:
            builder.validate(builder.read_json(source/f'data/{season}/snapshots/{scope}-{week}.json'))
if '--check' not in sys.argv:
    destination=Path(sys.argv[1]).resolve()
    destination.mkdir(parents=True,exist_ok=True)
    for name in ['index.html','top-connections.html','methodology.html','404.html','favicon.svg',
                 'player-placeholder.svg','styles.css','app.js','teams.js','score.js','search.js']:
        shutil.copy2(source/name,destination/name)
    shutil.copytree(source/'data',destination/'data',dirs_exist_ok=True)
    (destination/'.nojekyll').touch()
print('All seasonal datasets and snapshots validated.')
