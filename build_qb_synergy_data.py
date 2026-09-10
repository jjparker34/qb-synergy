"""Build validated NFL season assets: --season 2026 --output-dir qb_synergy_dashboard --refresh."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
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
METHOD_VERSION = '2026.4'
RECEIVER_POSITION_OVERRIDES = {'00-0040718': 'WR'}  # Travis Hunter's receiving plays
GROUP = ['passer_player_id', 'receiver_player_id', 'posteam']
COLS = ['season', 'season_type', 'game_id', 'play_id', 'play_type', 'two_point_attempt', 'week', 'posteam', 'passer_player_id',
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
    positions = players.drop_duplicates(id_col).set_index(id_col).position.to_dict()
    positions.update(RECEIVER_POSITION_OVERRIDES)
    plays = pbp.loc[pbp.pass_attempt.eq(1) & pbp.passer_player_id.notna()
                    & pbp.receiver_player_id.notna() & pbp.posteam.notna()].copy()
    if not plays.two_point_attempt.isin([0, 1]).all():
        raise ValueError('Missing or invalid conversion indicator on receiver-tagged attempts')
    plays = plays.loc[plays.two_point_attempt.eq(0) & plays.play_type.ne('no_play')].copy()
    if not plays.play_type.eq('pass').all():
        raise ValueError('Unexpected play type on receiver-tagged pass attempts')
    if plays[['game_id', 'play_id']].isna().any().any() or plays.duplicated(['game_id', 'play_id']).any():
        raise ValueError('Missing or duplicate receiving play identity')
    plays['position'] = plays.receiver_player_id.map(positions)
    if plays.position.isna().any():
        raise ValueError('Receiver missing from player metadata; publication stopped')
    plays['listedPosition'] = plays.position
    plays['position'] = plays.position.replace({'FB': 'RB'})
    # Keep every receiver position until team opportunity totals have been counted.
    for field in ['complete_pass', 'pass_touchdown', 'interception', 'first_down_pass']:
        if not plays[field].isin([0, 1]).all():
            raise ValueError(f'Missing or invalid {field} on receiving plays')
    if not plays.down.isin([1, 2, 3, 4]).all() or not plays.yardline_100.between(0, 100).all():
        raise ValueError('Missing or invalid receiving-play opportunity context')
    if (plays.complete_pass.eq(1) & plays.receiving_yards.isna()).any():
        raise ValueError('Receiving yards unavailable for a completed pass')
    if not plays.success.dropna().isin([0, 1]).all():
        raise ValueError('Invalid success indicator')
    modeled = plays.success.notna() & plays.epa.notna()
    if plays.loc[modeled, 'success'].ne(plays.loc[modeled, 'epa'].gt(0).astype(int)).any():
        raise ValueError('Success indicator disagrees with positive EPA')
    for key in ['passer', 'receiver']:
        names = plays.groupby(f'{key}_player_id')[f'{key}_player_name'].agg(canonical_name)
        plays[f'{key}_player_name'] = plays[f'{key}_player_id'].map(names)
    for dest, src in {'receptions': 'complete_pass', 'yards': 'receiving_yards', 'td': 'pass_touchdown',
                      'interceptions': 'interception', 'first_downs': 'first_down_pass', 'yac': 'yards_after_catch'}.items():
        plays[dest] = plays[src].fillna(0)
    # A missing YAC measurement on a catch is not zero yards after catch.
    plays['yac'] = plays.yards_after_catch.where(plays.receptions.eq(1), 0)
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

def team_red_zone_totals(plays):
    return {team: int(total) for team, total in plays.groupby('posteam').red_zone_targets.sum().items()}

def aggregate(plays, players):
    if plays.empty:
        return []
    team_red_zone = team_red_zone_totals(plays)
    plays = plays.loc[plays.position.isin(['WR', 'TE', 'RB'])].copy()
    if plays.empty:
        return []
    sums = ['receptions', 'yards', 'td', 'interceptions', 'first_downs', 'yac', 'expected_yac',
            'epa', 'red_zone_targets', 'money_down_targets', 'money_down_failures', 'explosives']
    spec = {k: (k, 'sum') for k in sums}
    for k in ['epa', 'expected_yac', 'yac']:
        spec[k] = (k, lambda x: x.sum() if x.notna().all() else float('nan'))
    spec.update(targets=('pass_attempt', 'size'), games=('game_id', 'nunique'),
                qb=('passer_player_name', 'first'), receiver=('receiver_player_name', 'first'),
                position=('position', 'first'), listedPosition=('listedPosition', 'first'), cpoe=('cpoe', 'mean'),
                cpoe_targets=('cpoe', 'count'), success_targets=('success', 'count'), successful_targets=('success', 'sum'),
                air_yards=('air_yards', 'mean'), success_rate=('success', 'mean'))
    spec['modeled_receptions'] = ('modeled_receptions', 'sum')
    spec['yac_over_expected_per_reception'] = ('modeled_yac_over_expected', 'mean')
    pairs = plays.groupby(GROUP).agg(**spec).reset_index()
    qb_group = ['passer_player_id', 'posteam']
    qb = plays.groupby(qb_group).agg(qb_targets=('pass_attempt', 'size'),
         qb_epa=('epa', lambda x: x.sum() if x.notna().all() else float('nan')),
         qb_red_zone_targets=('red_zone_targets', 'sum'), qb_money_down_targets=('money_down_targets', 'sum'))
    pairs = pairs.join(qb, on=qb_group)
    pairs['team_red_zone_targets'] = pairs.posteam.map(team_red_zone)
    divisions = {'catch_rate': ('receptions', 'targets'), 'yards_per_target': ('yards', 'targets'),
        'yac_per_reception': ('yac', 'receptions'), 'epa_per_target': ('epa', 'targets'),
        'target_share': ('targets', 'qb_targets'), 'money_down_rate': ('money_down_targets', 'targets'),
        'interception_rate': ('interceptions', 'targets'),
        'money_down_failure_rate': ('money_down_failures', 'money_down_targets'),
        'money_down_target_share': ('money_down_targets', 'qb_money_down_targets'),
        'red_zone_target_share': ('red_zone_targets', 'team_red_zone_targets')}
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
                row[key] = round(float(value), 8)
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

def validate_rows(rows, team_red_zone=None):
    identities = set()
    quarterback_rows = {}
    team_rows = {}
    if team_red_zone is not None:
        if not isinstance(team_red_zone, dict) or any(not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 or v != int(v) for v in team_red_zone.values()):
            raise ValueError('Invalid team red-zone opportunity totals')
    count_limits = {'receptions': 'targets', 'td': 'receptions', 'interceptions': 'targets',
        'first_downs': 'receptions', 'explosives': 'receptions', 'money_down_targets': 'targets',
        'red_zone_targets': 'targets', 'money_down_failures': 'money_down_targets',
        'modeled_receptions': 'receptions', 'cpoe_targets': 'targets', 'success_targets': 'targets',
        'successful_targets': 'success_targets', 'games': 'targets'}
    ratios = {'catch_rate': ('receptions', 'targets'), 'yards_per_target': ('yards', 'targets'),
        'epa_per_target': ('epa', 'targets'), 'yac_per_reception': ('yac', 'receptions'),
        'success_rate': ('successful_targets', 'success_targets'), 'target_share': ('targets', 'qb_targets'),
        'money_down_rate': ('money_down_targets', 'targets'), 'interception_rate': ('interceptions', 'targets'),
        'money_down_failure_rate': ('money_down_failures', 'money_down_targets'),
        'money_down_target_share': ('money_down_targets', 'qb_money_down_targets'),
        'red_zone_target_share': ('red_zone_targets', 'team_red_zone_targets')}
    def matches(actual, expected):
        return actual is None if expected is None else isinstance(actual, (int, float)) and math.isclose(actual, expected, abs_tol=1e-7, rel_tol=1e-7)
    for row in rows:
        identity = (row['qbId'], row['receiverId'], row['team'])
        if identity in identities:
            raise ValueError(f'Duplicate connection: {identity}')
        identities.add(identity)
        if not (isinstance(row['targets'], (int, float)) and row['targets'] > 0
                and row['targets'] == int(row['targets']) and 0 <= row['receptions'] <= row['targets']):
            raise ValueError(f'Invalid targets/receptions: {identity}')
        if row['position'] not in ['WR', 'TE', 'RB']:
            raise ValueError('Unexpected receiver position')
        for key, upper in count_limits.items():
            value = row.get(key)
            if not isinstance(value, (int, float)) or value != int(value) or not 0 <= value <= row[upper]:
                raise ValueError(f'Invalid {key} count: {identity}')
        if row['interceptions'] + row['receptions'] > row['targets'] or row['games'] == 0:
            raise ValueError(f'Inconsistent receiving counts: {identity}')
        total = row.get('team_red_zone_targets')
        if not isinstance(total, (int, float)) or not math.isfinite(total) or total != int(total) or total < row['red_zone_targets']:
            raise ValueError(f'Invalid team red-zone opportunity count: {identity}')
        if team_red_zone is not None and (row['team'] not in team_red_zone or total != team_red_zone[row['team']]):
            raise ValueError(f'Incorrect team red-zone denominator: {identity}')
        for key, (numerator, denominator) in ratios.items():
            expected = row[numerator] / row[denominator] if row[numerator] is not None and row[denominator] > 0 else None
            if key not in row or not matches(row[key], expected):
                raise ValueError(f'Incorrect {key} ratio: {identity}')
        if row['cpoe_targets'] == 0 and row['cpoe'] is not None or row['modeled_receptions'] == 0 and row['yac_over_expected_per_reception'] is not None:
            raise ValueError(f'Model value without observations: {identity}')
        if row['cpoe_targets'] > 0 and row['cpoe'] is None or row['modeled_receptions'] > 0 and row['yac_over_expected_per_reception'] is None:
            raise ValueError(f'Observations without a model value: {identity}')
        quarterback_rows.setdefault((row['qbId'], row['team']), []).append(row)
        team_rows.setdefault(row['team'], []).append(row)
    for team, peers in team_rows.items():
        total = peers[0]['team_red_zone_targets']
        if any(r['team_red_zone_targets'] != total for r in peers) or sum(r['red_zone_targets'] for r in peers) > total:
            raise ValueError(f'Inconsistent team red-zone denominator: {team}')
    for identity, peers in quarterback_rows.items():
        sums = {'qb_targets': sum(r['targets'] for r in peers),
                'qb_money_down_targets': sum(r['money_down_targets'] for r in peers),
                'qb_red_zone_targets': sum(r['red_zone_targets'] for r in peers),
                'qb_epa': sum(r['epa'] for r in peers) if all(r['epa'] is not None for r in peers) else None}
        for row in peers:
            for key, expected in sums.items():
                if not matches(row[key], expected):
                    raise ValueError(f'Incorrect quarterback/team {key}: {identity}')
            other_targets = sums['qb_targets'] - row['targets']
            lift = row['epa'] / row['targets'] - (sums['qb_epa'] - row['epa']) / other_targets if other_targets > 0 and row['epa'] is not None and sums['qb_epa'] is not None else None
            if not matches(row['qb_epa_lift'], lift):
                raise ValueError(f'Incorrect quarterback/team EPA lift: {identity}')


def validate(payload, previous=None):
    json.dumps(payload, allow_nan=False)
    if payload.get('methodVersion') == METHOD_VERSION and ('teamRedZoneTargets' not in payload or 'recent' in payload and 'recentTeamRedZoneTargets' not in payload):
        raise ValueError('Missing team red-zone opportunity totals')
    validate_rows(payload['pairs'], payload.get('teamRedZoneTargets'))
    if 'recent' in payload:
        validate_rows(payload['recent'], payload.get('recentTeamRedZoneTargets'))
    for weekly in payload.get('weekly', []):
        if payload.get('methodVersion') == METHOD_VERSION and 'teamRedZoneTargets' not in weekly:
            raise ValueError('Missing weekly team red-zone opportunity totals')
        validate_rows(weekly['pairs'], weekly.get('teamRedZoneTargets'))
    if payload.get('methodVersion') is not None and payload['methodVersion'] != METHOD_VERSION:
        raise ValueError('Dataset requires a rebuild for the current scoring method')
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
        excluded_conversions = pbp.loc[pbp.game_id.isin(game_ids) & pbp.pass_attempt.eq(1)
            & pbp.receiver_player_id.notna() & pbp.two_point_attempt.eq(1)]
        meta = dict(season=season, seasonScope=scope, scope=label, methodVersion=METHOD_VERSION,
                    generatedAt=generated_at, sourceCheckedAt=checked_at, sourceFingerprint=fingerprint,
                    builderFingerprint=builder_fingerprint,
                    latestIncludedWeek=included, latestCompletedWeek=completed[-1] if completed else None,
                    firstWeek=first, gameIds=game_ids, thresholds=thresholds,
                    excludedTwoPointTargets=len(excluded_conversions))
        payload = dict(meta, pairs=aggregate(scoped, players), teamRedZoneTargets=team_red_zone_totals(scoped),
                       status='available' if len(scoped) else 'pending')
        recent = scoped.loc[scoped.week.ge(included - 3)] if included else scoped.iloc[:0]
        payload['recent'] = aggregate(recent, players)
        payload['recentTeamRedZoneTargets'] = team_red_zone_totals(recent)
        payload['recentStartWeek'] = max(first, included - 3) if included else None
        payload['weekly'] = [{'week': int(week), 'pairs': aggregate(rows, players),
                              'teamRedZoneTargets': team_red_zone_totals(rows)} for week, rows in scoped.groupby('week', sort=True)]
        payload['snapshotWeeks'] = completed
        validate(payload, previous)
        generated[f'{scope}.json'] = payload
        for week in completed:
            subset = scoped.loc[scoped.week.le(week)]
            recent_subset = subset.loc[subset.week.ge(week - 3)]
            snapshot = dict(meta, throughWeek=week, pairs=aggregate(subset, players),
                            recent=aggregate(recent_subset, players), teamRedZoneTargets=team_red_zone_totals(subset),
                            recentTeamRedZoneTargets=team_red_zone_totals(recent_subset))
            snapshot.update(latestIncludedWeek=week, latestCompletedWeek=week,
                            recentStartWeek=max(first, week - 3),
                            excludedTwoPointTargets=int(excluded_conversions.week.le(week).sum()))
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
                handle.write(f'- {scope}: {len(p["pairs"])} connections; {len(p["gameIds"])} games; completed week {p["latestCompletedWeek"]}; {p["excludedTwoPointTargets"]} conversion attempts excluded.\n')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--season', type=int, required=True)
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'qb_synergy_dashboard')
    parser.add_argument('--cache-dir', type=Path)
    parser.add_argument('--refresh', action='store_true')
    args = parser.parse_args()
    build(args.season, args.output_dir, args.refresh, args.cache_dir)
