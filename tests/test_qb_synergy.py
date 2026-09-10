import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('builder', ROOT / 'build_qb_synergy_data.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def fixtures():
    players = pd.DataFrame([{'gsis_id':'q', 'position':'QB','display_name':'Quarterback'},
        {'gsis_id':'r','position':'WR','display_name':'Receiver'},
        {'gsis_id':'00-0040718','position':'CB','display_name':'Travis Hunter'}])
    rows = []
    for week in [1, 2, 4]:
        for index in range(20):
            row = dict.fromkeys(builder.COLS, 0)
            row.update(season=2026, season_type='REG', game_id=f'g{week}', week=week, posteam='JAX',
                       passer_player_id='q', passer_player_name='Q.Name',
                       receiver_player_id='r' if index<15 else '00-0040718',
                       receiver_player_name='R.Name' if index<15 else 'T.Hunter',
                       pass_attempt=1,complete_pass=1,receiving_yards=10,yards_after_catch=4,
                       xyac_mean_yardage=3,epa=.5,success=1,cpoe=2,air_yards=6,
                       yardline_100=10,down=3,first_down_pass=1)
            rows.append(row)
    pbp = pd.DataFrame(rows)
    schedule = pd.DataFrame([dict(game_id=f'g{w}',season=2026,game_type='REG',week=w,
        gameday=f'2026-09-{w+1:02}',home_score=20,away_score=10) for w in [1,2,4]])
    return players, pbp, schedule


class BuilderTests(unittest.TestCase):
    def test_aggregation_and_hunter_override(self):
        players,pbp,_=fixtures()
        pairs=builder.aggregate(builder.prepare(pbp,players),players)
        receiver=next(r for r in pairs if r['receiverId']=='r')
        hunter=next(r for r in pairs if r['receiverId']=='00-0040718')
        self.assertEqual(receiver['targets'],45)
        self.assertEqual(receiver['yards'],450)
        self.assertEqual(receiver['games'],3)
        self.assertEqual(receiver['target_share'],.75)
        self.assertEqual(hunter['position'],'WR')
        self.assertEqual(receiver['epa_per_target'],.5)

    def test_missing_model_data_stays_missing(self):
        players,pbp,_=fixtures()
        pbp.loc[0,'epa']=float('nan')
        receiver=next(r for r in builder.aggregate(builder.prepare(pbp,players),players) if r['receiverId']=='r')
        self.assertIsNone(receiver['epa_per_target'])
        self.assertEqual(builder.aggregate(pbp.iloc[:0],players),[])

    def test_partial_expected_yac_uses_only_modeled_receptions(self):
        players,pbp,_=fixtures()
        pbp.loc[0,'xyac_mean_yardage']=float('nan')
        pbp.loc[0,'yards_after_catch']=90
        receiver=next(r for r in builder.aggregate(builder.prepare(pbp,players),players) if r['receiverId']=='r')
        self.assertEqual(receiver['modeled_receptions'],44)
        self.assertEqual(receiver['yac_over_expected_per_reception'],1)
        pbp['xyac_mean_yardage']=float('nan')
        self.assertTrue(all(r['yac_over_expected_per_reception'] is None for r in builder.aggregate(builder.prepare(pbp,players),players)))

    def test_pending_season_is_distinct_from_a_failed_download(self):
        players,_,schedule=fixtures()
        schedule['home_score']=float('nan');schedule['away_score']=float('nan');schedule['gameday']='2099-09-01'
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);players.to_csv(base/'players.csv',index=False);schedule.to_csv(base/'games.csv',index=False)
            def source(url,path,*args,**kwargs):
                return None if 'play_by_play' in url else base/Path(path).name
            with patch.object(builder,'fetch',side_effect=source):builder.build(2026,base/'site',cache_dir=base)
            payload=builder.read_json(base/'site/data/2026/REG.json')
            self.assertEqual(payload['status'],'pending');self.assertEqual(payload['pairs'],[])
            stable=(base/'site/data/2026/REG.json').read_bytes()
            with patch.object(builder,'fetch',side_effect=OSError('network down')):
                with self.assertRaises(OSError):builder.build(2026,base/'site',True,base)
            self.assertEqual((base/'site/data/2026/REG.json').read_bytes(),stable)

    def test_coverage_requires_every_scheduled_game(self):
        _,pbp,schedule=fixtures()
        schedule=pd.concat([schedule,pd.DataFrame([dict(game_id='extra',season=2026,game_type='REG',week=2,home_score=None,away_score=None)])])
        _,completed,included=builder.coverage(pbp,schedule,'REG')
        self.assertEqual(completed,[1])
        self.assertEqual(included,4)
        self.assertEqual(builder.coverage(pbp,schedule,'POST')[1],[])

    def test_validation_rejects_loss_and_bad_totals(self):
        with self.assertRaisesRegex(ValueError,'disappeared'):
            builder.validate({'pairs':[],'gameIds':['one']},{'pairs':[],'gameIds':['one','two']})
        with self.assertRaisesRegex(ValueError,'targets'):
            builder.validate({'pairs':[dict(qbId='q',receiverId='r',team='T',targets=1,receptions=2)],'gameIds':[]})

    def test_cache_refresh(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'cache.csv';path.write_text('cached')
            with patch.object(builder,'urlopen') as network:
                self.assertEqual(builder.fetch('https://example.test',path).read_text(),'cached')
                network.assert_not_called()
                network.side_effect=OSError('network down')
                with self.assertRaises(OSError):builder.fetch('https://example.test',path,True)
                network.assert_called_once()
                self.assertEqual(path.read_text(),'cached')

    def test_build_snapshots_corrections_and_failure_preservation(self):
        players,pbp,schedule=fixtures()
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);cache=base/'cache';cache.mkdir();out=base/'site'
            players.to_csv(cache/'players.csv',index=False);schedule.to_csv(cache/'games.csv',index=False)
            pbp.to_csv(cache/'play_by_play_2026.csv.gz',index=False,compression='gzip')
            builder.build(2026,out,cache_dir=cache)
            path=out/'data/2026/REG.json';payload=builder.read_json(path)
            self.assertEqual(payload['snapshotWeeks'],[1,2,4])
            self.assertEqual(payload['recentStartWeek'],1)
            self.assertEqual(builder.read_json(out/'data/2026/POST.json')['pairs'],[])
            for scope in builder.SCOPES:
                scoped=builder.read_json(out/f'data/2026/{scope}.json')
                self.assertEqual(scoped['thresholds'],dict(score=5 if scope=='POST' else 15,
                    qualified=5 if scope=='POST' else 30,weekly=1))
                for week in scoped['snapshotWeeks']:
                    self.assertEqual(builder.read_json(out/f'data/2026/snapshots/{scope}-{week}.json')['thresholds'],scoped['thresholds'])
            snapshot=out/'data/2026/snapshots/REG-1.json';original=snapshot.read_bytes()
            pbp.loc[0,'receiving_yards']=20;pbp.to_csv(cache/'play_by_play_2026.csv.gz',index=False,compression='gzip')
            builder.build(2026,out,cache_dir=cache)
            self.assertNotEqual(snapshot.read_bytes(),original)
            stable=path.read_bytes()
            pbp[pbp.week.ne(2)].to_csv(cache/'play_by_play_2026.csv.gz',index=False,compression='gzip')
            with self.assertRaisesRegex(ValueError,'missing'):builder.build(2026,out,cache_dir=cache)
            self.assertEqual(path.read_bytes(),stable)


if __name__=='__main__':unittest.main()
