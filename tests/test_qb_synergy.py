import importlib.util
import copy
import io
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
                       play_id=index+1, play_type='pass', two_point_attempt=0,
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

    def test_conversions_and_nullified_plays_do_not_enter_any_receiving_totals(self):
        players,pbp,_=fixtures()
        extra=pbp.iloc[:2].copy()
        extra['play_id']=[901,902]
        extra.loc[extra.index[0],'two_point_attempt']=1
        extra.loc[extra.index[1],'play_type']='no_play'
        extra['epa']=100
        extra['success']=1
        expected=builder.aggregate(builder.prepare(pbp,players),players)
        actual=builder.aggregate(builder.prepare(pd.concat([pbp,extra]),players),players)
        self.assertEqual(actual,expected)

    def test_fullbacks_share_rb_group_without_losing_the_listed_position(self):
        players,pbp,_=fixtures()
        players.loc[players.gsis_id.eq('r'),'position']='FB'
        receiver=next(r for r in builder.aggregate(builder.prepare(pbp,players),players) if r['receiverId']=='r')
        self.assertEqual((receiver['position'],receiver['listedPosition'],receiver['targets']),('RB','FB',45))

    def test_quarterback_denominators_and_lift_stay_with_the_team(self):
        players,pbp,_=fixtures()
        pbp.loc[pbp.week.eq(1),'posteam']='CLE'
        pbp.loc[pbp.week.eq(1),'epa']=2
        pairs=builder.aggregate(builder.prepare(pbp,players),players)
        builder.validate_rows(pairs)
        for row in pairs:
            local=[r for r in pairs if r['qbId']==row['qbId'] and r['team']==row['team']]
            self.assertEqual(row['qb_targets'],sum(r['targets'] for r in local))
            self.assertEqual(row['qb_money_down_targets'],sum(r['money_down_targets'] for r in local))
            self.assertEqual(row['qb_red_zone_targets'],sum(r['red_zone_targets'] for r in local))
            self.assertEqual(row['qb_epa_lift'],0)
        self.assertEqual({r['qb_targets'] for r in pairs},{20,40})

    def test_partial_model_coverage_and_missing_observed_yac_are_explicit(self):
        players,pbp,_=fixtures()
        pbp.loc[0,['cpoe','success','yards_after_catch']]=float('nan')
        r=next(r for r in builder.aggregate(builder.prepare(pbp,players),players) if r['receiverId']=='r')
        self.assertEqual((r['cpoe_targets'],r['success_targets'],r['modeled_receptions']),(44,44,44))
        self.assertEqual(r['success_rate'],1)
        self.assertIsNone(r['yac_per_reception'])
        self.assertIsNone(r['yac'])

    def test_red_zone_share_uses_all_team_quarterbacks_and_receiver_positions(self):
        players,pbp,_=fixtures()
        players=pd.concat([players,pd.DataFrame([
            dict(gsis_id='q2',position='QB',display_name='Second Quarterback'),
            dict(gsis_id='lineman',position='OT',display_name='Eligible Lineman')])],ignore_index=True)
        pbp.loc[pbp.week.eq(2),['passer_player_id','passer_player_name']]=['q2','Second.QB']
        pbp.loc[pbp.week.eq(4),'posteam']='TEN'
        unusual=pbp.iloc[:2].copy()
        unusual['play_id']=[901,902]
        unusual['receiver_player_id']='lineman'
        unusual['receiver_player_name']='Eligible.Lineman'
        unusual.loc[unusual.index[1],['week','game_id']]=[3,'g3']
        plays=builder.prepare(pd.concat([pbp,unusual]),players)
        totals=builder.team_red_zone_totals(plays)
        self.assertEqual(totals,{'JAX':42,'TEN':20})
        pairs=builder.aggregate(plays,players)
        builder.validate_rows(pairs,totals)
        self.assertFalse(any(r['receiverId']=='lineman' for r in pairs))
        for row in pairs:
            self.assertEqual(row['team_red_zone_targets'],totals[row['team']])
            self.assertEqual(row['qb_red_zone_targets'],20)
            self.assertAlmostEqual(row['red_zone_target_share'],row['red_zone_targets']/totals[row['team']],places=7)
        first=plays.loc[plays.week.eq(1)]
        self.assertEqual(builder.aggregate(first,players)[0]['team_red_zone_targets'],21)
        context_only=plays.loc[plays.week.eq(3)]
        self.assertEqual(builder.aggregate(context_only,players),[])
        self.assertEqual(builder.team_red_zone_totals(context_only),{'JAX':1})
        bad=copy.deepcopy(pairs)
        for row in bad:
            if row['team']=='JAX':
                row['team_red_zone_targets']=41
                row['red_zone_target_share']=row['red_zone_targets']/41
        with self.assertRaisesRegex(ValueError,'team red-zone denominator'):
            builder.validate_rows(bad,totals)

    def test_red_zone_boundaries_and_zero_team_opportunities(self):
        players,pbp,_=fixtures()
        pbp['yardline_100']=21
        pbp.loc[0,'yardline_100']=20
        plays=builder.prepare(pbp,players)
        pairs=builder.aggregate(plays,players)
        self.assertEqual(builder.team_red_zone_totals(plays),{'JAX':1})
        self.assertEqual(next(r for r in pairs if r['receiverId']=='r')['red_zone_target_share'],1)
        self.assertEqual(next(r for r in pairs if r['receiverId']=='00-0040718')['red_zone_target_share'],0)
        later=builder.aggregate(plays.loc[plays.week.gt(1)],players)
        self.assertTrue(all(r['team_red_zone_targets']==0 and r['red_zone_target_share'] is None for r in later))

    def test_bad_source_rows_stop_aggregation(self):
        players,pbp,_=fixtures()
        bad_sources=[pd.concat([pbp,pbp.iloc[:1]])]
        for column,value in [('complete_pass',float('nan')),('down',float('nan')),
                             ('receiving_yards',float('nan')),('two_point_attempt',float('nan')),
                             ('receiver_player_id','unlisted'),('success',0)]:
            bad=pbp.copy();bad.loc[0,column]=value;bad_sources.append(bad)
        for bad in bad_sources:
            with self.subTest(row=bad.iloc[0].to_dict()),self.assertRaises(ValueError):builder.prepare(bad,players)

    def test_validation_covers_recent_and_weekly_rows_and_all_component_inputs(self):
        players,pbp,_=fixtures()
        pairs=builder.aggregate(builder.prepare(pbp,players),players)
        for view in ['pairs','recent','weekly']:
            payload=dict(pairs=copy.deepcopy(pairs),recent=copy.deepcopy(pairs),weekly=[dict(week=1,pairs=copy.deepcopy(pairs))],gameIds=['g1'])
            target=payload[view][0]['pairs'] if view=='weekly' else payload[view]
            target[0]['money_down_target_share']=2
            with self.subTest(view=view),self.assertRaisesRegex(ValueError,'ratio'):builder.validate(payload)
        for field,value in [('explosives',1000),('modeled_receptions',1000),('qb_targets',1000),('qb_epa_lift',900)]:
            bad=copy.deepcopy(pairs);bad[0][field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):builder.validate_rows(bad)

    def test_no_receptions_keep_raw_yac_unavailable(self):
        players,pbp,_=fixtures()
        pbp['complete_pass']=0
        pbp['yards_after_catch']=float('nan')
        pbp['receiving_yards']=0
        for row in builder.aggregate(builder.prepare(pbp,players),players):
            self.assertGreater(row['targets'],0)
            self.assertEqual(row['receptions'],0)
            self.assertEqual(row['modeled_receptions'],0)
            self.assertIsNone(row['yac_over_expected_per_reception'])

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
            with patch.object(builder,'urlopen',return_value=io.BytesIO(b'fresh')):
                self.assertEqual(builder.fetch('https://example.test',path,True).read_text(),'fresh')

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
                self.assertEqual(scoped['thresholds'],dict(score=1,
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
