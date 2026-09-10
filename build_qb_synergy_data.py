"""Build validated NFL season assets: --season 2026 --output-dir qb_synergy_dashboard --refresh."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import pandas as pd

ROOT = Path(__file__).resolve().parent
PLAYERS_URL = 'https://github.com/nflverse/nflverse-data/releases/download/players/players.csv'
SCHEDULE_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv'
SCOPES = {'REG': 'Regular season', 'POST': 'Playoffs', 'ALL': 'Regular season + playoffs'}
RECEIVER_POSITION_OVERRIDES = {'00-0040718': 'WR'}  # Travis Hunter's receiving plays
GROUP = ['passer_player_id', 'receiver_player_id', 'posteam']
COLS = ['season', 'season_type', 'game_id', 'week', 'posteam', 'passer_player_id',
        'passer_player_name', 'receiver_player_id', 'receiver_player_name', 'pass_attempt',
        'complete_pass', 'pass_touchdown', 'interception', 'first_down_pass', 'receiving_yards',
        'yards_after_catch', 'air_yards', 'epa', 'success', 'cpoe', 'xyac_mean_yardage', 'yardline_100', 'down']

def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))

def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, separators=(',', ':'), allow_nan=False), encoding='utf-8')

def fetch(url, path, refresh=False, optional=False):
    """Cache complete downloads only; keep the good cache on network errors."""
    path = Path(path)
    if path.exists() and not refresh:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = None
    try:
        with urlopen(Request(url, headers={'User-Agent': 'QB-Synergy'}), timeout=90) as response:
            with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as target:
                temp = Path(target.name)
                while chunk := response.read(1024 * 1024):
                    target.write(chunk)
        os.replace(temp, path)
    except HTTPError as error:
        if error.code == 404 and optional:
            return None
        raise
    finally:
        if temp:
            temp.unlink(missing_ok=True)
    return path

def canonical_name(names):
    values = [str(n) for n in names.dropna() if str(n).strip()]
    return max(values, key=lambda n: (len(n), n)) if values else 'Unknown'

def prepare(pbp, players):
    if not set(COLS).issubset(pbp.columns):
        raise ValueError(f'Missing play-by-play columns: {set(COLS) - set(pbp.columns)}')
    id_col = 'gsis_id' if 'gsis_id' in players else 'nfl_id'
    if not {id_col, 'position', 'display_name'}.issubset(players.columns):
        raise ValueError('Player metadata is missing required columns')
    positions = players.set_index(id_col).position.to_dict()
    positions.update(RECEIVER_POSITION_OVERRIDES)
    plays = pbp.loc[pbp.pass_attempt.eq(1) & pbp.passer_player_id.notna()
                    & pbp.receiver_player_id.notna() & pbp.posteam.notna()].copy()
    plays['position'] = plays.receiver_player_id.map(positions)
    plays = plays.loc[plays.position.isin(['WR', 'TE', 'RB'])].copy()
    for key in ['passer', 'receiver']:
        names = plays.groupby(f'{key}_player_id')[f'{key}_player_name'].agg(canonical_name)
        plays[f'{key}_player_name'] = plays[f'{key}_player_id'].map(names)
    for dest, src in {'receptions': 'complete_pass', 'yards': 'receiving_yards', 'td': 'pass_touchdown',
                      'interceptions': 'interception', 'first_downs': 'first_down_pass', 'yac': 'yards_after_catch'}.items():
        plays[dest] = plays[src].fillna(0)
    plays['expected_yac'] = plays.xyac_mean_yardage.where(plays.receptions.eq(1), 0)
    covered = plays.receptions.eq(1) & plays.xyac_mean_yardage.notna() & plays.yards_after_catch.notna()
    plays['modeled_receptions'] = covered.astype(int)
    plays['modeled_yac_over_expected'] = (plays.yards_after_catch - plays.xyac_mean_yardage).where(covered)
    plays['red_zone_targets'] = plays.yardline_100.le(20).astype(int)
    plays['money_down_targets'] = plays.down.isin([3, 4]).astype(int)
    plays['money_down_failures'] = (plays.money_down_targets.eq(1) & plays.first_downs.eq(0) & plays.td.eq(0)).astype(int)
    plays['explosives'] = plays.yards.ge(20).astype(int)
    return plays

def ratio(a, b):
    return a / b.replace(0, float('nan'))

def aggregate(plays, players):
    if plays.empty:
        return []
    sums = ['receptions', 'yards', 'td', 'interceptions', 'first_downs', 'yac', 'expected_yac',
            'epa', 'red_zone_targets', 'money_down_targets', 'money_down_failures', 'explosives']
    spec = {k: (k, 'sum') for k in sums}
    for k in ['epa', 'expected_yac']:
        spec[k] = (k, lambda x: x.sum() if x.notna().all() else float('nan'))
    spec.update(targets=('pass_attempt', 'size'), games=('game_id', 'nunique'),
                qb=('passer_player_name', 'first'), receiver=('receiver_player_name', 'first'),
                position=('position', 'first'), cpoe=('cpoe', 'mean'),
                air_yards=('air_yards', 'mean'), success_rate=('success', 'mean'))
    spec['modeled_receptions'] = ('modeled_receptions', 'sum')
    spec['yac_over_expected_per_reception'] = ('modeled_yac_over_expected', 'mean')
    pairs = plays.groupby(GROUP).agg(**spec).reset_index()
    qb = plays.groupby('passer_player_id').agg(qb_targets=('pass_attempt', 'size'),
         qb_epa=('epa', lambda x: x.sum() if x.notna().all() else float('nan')),
         qb_red_zone_targets=('red_zone_targets', 'sum'), qb_money_down_targets=('money_down_targets', 'sum'))
    pairs = pairs.join(qb, on='passer_player_id')
    divisions = {'catch_rate': ('receptions', 'targets'), 'yards_per_target': ('yards', 'targets'),
        'yac_per_reception': ('yac', 'receptions'), 'epa_per_target': ('epa', 'targets'),
        'target_share': ('targets', 'qb_targets'), 'money_down_rate': ('money_down_targets', 'targets'),
        'interception_rate': ('interceptions', 'targets'),
        'money_down_failure_rate': ('money_down_failures', 'money_down_targets'),
        'money_down_target_share': ('money_down_targets', 'qb_money_down_targets'),
        'red_zone_target_share': ('red_zone_targets', 'qb_red_zone_targets')}
    for name, (a, b) in divisions.items():
        pairs[name] = ratio(pairs[a], pairs[b])
    pairs['qb_epa_lift'] = pairs.epa_per_target - ratio(pairs.qb_epa - pairs.epa, pairs.qb_targets - pairs.targets)
    a = ((pairs.receptions / pairs.targets - .3) * 5).clip(0, 2.375)
    b = ((pairs.yards / pairs.targets - 3) * .25).clip(0, 2.375)
    c = (pairs.td / pairs.targets * 20).clip(0, 2.375)
    d = (2.375 - pairs.interceptions / pairs.targets * 25).clip(0, 2.375)
    pairs['passer_rating'] = (a + b + c + d) / 6 * 100
    id_col = 'gsis_id' if 'gsis_id' in players else 'nfl_id'
    if '_qb_metadata' not in players.attrs:
        players.attrs['_qb_metadata'] = players.drop_duplicates(id_col).set_index(id_col).to_dict('index')
    metadata = players.attrs['_qb_metadata']
    result = []
    for row in pairs.to_dict('records'):
        row['qbId'] = row.pop('passer_player_id')
        row['receiverId'] = row.pop('receiver_player_id')
        row['team'] = row.pop('posteam')
        for role in ['qb', 'receiver']:
            meta = metadata.get(row[f'{role}Id'], {})
            row[f'{role}FullName'] = meta.get('display_name') or row[role]
            row[f'{role}Photo'] = meta.get('headshot_url', meta.get('headshot', ''))
        for key, value in row.items():
            if pd.isna(value):
                row[key] = None
            elif isinstance(value, (float, int)):
                row[key] = round(float(value), 4)
        result.append(row)
    return sorted(result, key=lambda r: (r['qbId'], r['receiverId'], r['team']))

def scope_schedule(schedule, scope):
    if scope == 'ALL':
        return schedule
    return schedule.loc[schedule.game_type.eq('REG') if scope == 'REG' else ~schedule.game_type.eq('REG')]

def coverage(pbp, schedule, scope):
    scheduled = scope_schedule(schedule, scope)
    scoped = pbp if scope == 'ALL' else pbp.loc[pbp.season_type.eq(scope)]
    ids = set(scoped.game_id.dropna())
    completed = []
    for week, games in scheduled.groupby('week', sort=True):
        if games.home_score.notna().all() and games.away_score.notna().all() and set(games.game_id).issubset(ids):
            completed.append(int(week))
        else:
            break
    included = int(scoped.week.max()) if len(scoped) else None
    return sorted(ids), completed, included

def validate(payload, previous=None):
    json.dumps(payload, allow_nan=False)
    identities = set()
    for row in payload['pairs']:
        identity = (row['qbId'], row['receiverId'], row['team'])
        if identity in identities:
            raise ValueError(f'Duplicate connection: {identity}')
        identities.add(identity)
        if not (row['targets'] > 0 and 0 <= row['receptions'] <= row['targets']):
            raise ValueError(f'Invalid targets/receptions: {identity}')
        if row['position'] not in ['WR', 'TE', 'RB']:
            raise ValueError('Unexpected receiver position')
    if previous and not set(previous.get('gameIds', [])).issubset(payload['gameIds']):
        raise ValueError('Previously included games disappeared; publication stopped')
    if previous and previous.get('pairs') and not payload['pairs']:
        raise ValueError('Previously available connections disappeared')

def build(season, output_dir, refresh=False, cache_dir=None):
    output = Path(output_dir).resolve()
    cache = Path(cache_dir) if cache_dir else ROOT / '.cache' / 'qb-synergy'
    now = datetime.now(timezone.utc).isoformat(timespec='seconds')
    schedule_file = fetch(SCHEDULE_URL, cache / 'games.csv', refresh)
    players_file = fetch(PLAYERS_URL, cache / 'players.csv', refresh)
    schedule = pd.read_csv(schedule_file)
    schedule = schedule.loc[schedule.season.eq(season) & schedule.game_type.ne('PRE')].copy()
    if schedule.empty:
        raise ValueError(f'No schedule available for {season}')
    pbp_file = fetch(f'https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{season}.csv.gz',
                     cache / f'play_by_play_{season}.csv.gz', refresh, optional=True)
    if pbp_file is None:
        if schedule.home_score.notna().any() or schedule.gameday.min() < now[:10]:
            raise ValueError('Play-by-play unavailable after season start; keeping published data')
        pbp = pd.DataFrame(columns=COLS)
    else:
        pbp = pd.read_csv(pbp_file, usecols=COLS, low_memory=False)
        if pbp.empty or not pbp.season.eq(season).all():
            raise ValueError('Empty or incorrect-season play-by-play file')
        pbp = pbp.loc[pbp.season_type.isin(['REG', 'POST'])].copy()
    completed_ids = set(schedule.loc[schedule.home_score.notna() & schedule.away_score.notna(), 'game_id'])
    pbp_ids = set(pbp.game_id.dropna())
    if completed_ids - pbp_ids:
        raise ValueError(f'Play-by-play missing {len(completed_ids - pbp_ids)} completed games')
    if pbp_ids - set(schedule.game_id):
        raise ValueError('Play-by-play contains games absent from the season schedule')
    players = pd.read_csv(players_file, low_memory=False)
    plays = prepare(pbp, players)
    fingerprint = hashlib.sha256(((hashlib.sha256(pbp_file.read_bytes()).hexdigest() if pbp_file else 'unavailable')
        + hashlib.sha256(players_file.read_bytes()).hexdigest() + schedule.to_csv(index=False)).encode()).hexdigest()
    builder_fingerprint = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    checked_at = now if refresh else datetime.fromtimestamp(min(p.stat().st_mtime for p in
        [schedule_file, players_file, *([pbp_file] if pbp_file else [])]), timezone.utc).isoformat(timespec='seconds')
    destination = output / 'data' / str(season)
    generated = {}
    for scope, label in SCOPES.items():
        scoped = plays if scope == 'ALL' else plays.loc[plays.season_type.eq(scope)]
        game_ids, completed, included = coverage(pbp, schedule, scope)
        first = int(scoped.week.min()) if len(scoped) else None
        thresholds = {'score': 1, 'qualified': 5 if scope == 'POST' else 30,
                      'weekly': 1}
        previous_path = destination / f'{scope}.json'
        previous = read_json(previous_path) if previous_path.exists() else None
        unchanged = previous and previous.get('sourceFingerprint') == fingerprint and previous.get('builderFingerprint') == builder_fingerprint
        generated_at = previous['generatedAt'] if unchanged else now
        meta = dict(season=season, seasonScope=scope, scope=label, methodVersion='2026.1',
                    generatedAt=generated_at, sourceCheckedAt=checked_at, sourceFingerprint=fingerprint,
                    builderFingerprint=builder_fingerprint,
                    latestIncludedWeek=included, latestCompletedWeek=completed[-1] if completed else None,
                    firstWeek=first, gameIds=game_ids, thresholds=thresholds)
        payload = dict(meta, pairs=aggregate(scoped, players), status='available' if len(scoped) else 'pending')
        payload['recent'] = aggregate(scoped.loc[scoped.week.ge(included - 3)], players) if included else []
        payload['recentStartWeek'] = max(first, included - 3) if included else None
        payload['weekly'] = [{'week': int(week), 'pairs': aggregate(rows, players)} for week, rows in scoped.groupby('week', sort=True)]
        payload['snapshotWeeks'] = completed
        validate(payload, previous)
        generated[f'{scope}.json'] = payload
        for week in completed:
            subset = scoped.loc[scoped.week.le(week)]
            snapshot = dict(meta, throughWeek=week, pairs=aggregate(subset, players),
                            recent=aggregate(subset.loc[subset.week.ge(week - 3)], players))
            snapshot.update(latestIncludedWeek=week, latestCompletedWeek=week,
                            recentStartWeek=max(first, week - 3))
            snapshot['gameIds'] = sorted(set(pbp.loc[pbp.week.le(week) & pbp.game_id.isin(game_ids), 'game_id']))
            validate(snapshot)
            generated[f'snapshots/{scope}-{week}.json'] = snapshot
        print(f'{season} {scope}: {len(payload["pairs"])} connections, {len(game_ids)} games; completed week {meta["latestCompletedWeek"]}')
    # Validate every scope and snapshot before replacing public assets.
    with tempfile.TemporaryDirectory(prefix='qb-synergy-') as folder:
        stage = Path(folder)
        for name, payload in generated.items():
            write_json(stage / name, payload)
        for name in generated:
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            temp = target.with_suffix('.tmp')
            temp.write_bytes((stage / name).read_bytes())
            os.replace(temp, target)
    manifest_path = output / 'data' / 'manifest.json'
    manifest = read_json(manifest_path) if manifest_path.exists() else {'activeSeason': 2026, 'seasons': []}
    manifest['seasons'] = sorted(set(manifest['seasons']) | {season}, reverse=True)
    write_json(manifest_path, manifest)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as handle:
            handle.write(f'### {season} refresh validated\n\nChecked {now}. Source `{fingerprint[:12]}`.\n\n')
            for scope in SCOPES:
                p = generated[f'{scope}.json']
                handle.write(f'- {scope}: {len(p["pairs"])} connections; {len(p["gameIds"])} games; completed week {p["latestCompletedWeek"]}.\n')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--season', type=int, required=True)
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'qb_synergy_dashboard')
    parser.add_argument('--cache-dir', type=Path)
    parser.add_argument('--refresh', action='store_true')
    args = parser.parse_args()
    build(args.season, args.output_dir, args.refresh, args.cache_dir)
