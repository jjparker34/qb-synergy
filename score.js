window.QBSynergyScore=(()=>{
  const components=[['Outcome','EPA / target','scoreEpa',23],['Outcome','Success rate','scoreSuccess',16],['Outcome','CPOE','scoreCpoe',6],['Outcome','First-down rate','scoreFirstDown',8],['Outcome','YAC over expected / rec','scoreYacoe',7],['Trust','Target share','target_share',14],['Trust','3rd/4th target share','money_down_target_share',7],['Trust','Red-zone target share','red_zone_target_share',4],['Duo lift','QB EPA lift','scoreQbLift',12],['Duo lift','Explosive rate','scoreExplosive',3]];
  const value=(row,key)=>{const result=Number(row[key]);return Number.isFinite(result)?result:0};
  const group=row=>row.position==='RB'?'RB':'WR_TE';
  function prepare(data){
    const rows=data.pairs.filter(row=>value(row,'targets')>0),byGroup=new Map(),raw=[['epa_per_target','scoreEpa'],['success_rate','scoreSuccess'],['cpoe','scoreCpoe'],['firstDownRate','scoreFirstDown'],['yac_over_expected_per_reception','scoreYacoe'],['qb_epa_lift','scoreQbLift'],['explosiveRate','scoreExplosive']];
    rows.forEach(row=>{row.firstDownRate=value(row,'first_downs')/value(row,'targets');row.explosiveRate=value(row,'explosives')/value(row,'targets');if(!byGroup.has(group(row)))byGroup.set(group(row),[]);byGroup.get(group(row)).push(row)});
    rows.forEach(row=>{const peers=byGroup.get(group(row)),blend=value(row,'targets')/(value(row,'targets')+40);raw.forEach(([source,target])=>{const baseline=peers.reduce((sum,peer)=>sum+value(peer,source),0)/peers.length;row[target]=blend*value(row,source)+(1-blend)*baseline})});
  }
  function calculate(data,row,withDetail=false){
    const minimum=data.thresholds?.score??15,sampleFor=key=>data.pairs.filter(peer=>value(peer,'targets')>=minimum&&group(peer)===group(row)).map(peer=>value(peer,key)).sort((a,b)=>a-b),percentile=key=>{const sample=sampleFor(key),current=value(row,key);return sample.length?Math.round(100*sample.filter(item=>item<=current).length/sample.length):0},lowerPercentile=key=>{const sample=sampleFor(key),current=value(row,key);return sample.length?100*sample.filter(item=>item<current).length/sample.length:0},detail=components.map(([section,label,key,weight])=>({group:section,label,weight,points:weight*percentile(key)/100})),turnoverPenalty=3*lowerPercentile('interception_rate')/100,moneyPenalty=2*lowerPercentile('money_down_failure_rate')/100,penalty=turnoverPenalty+moneyPenalty,total=Math.max(0,Math.round(detail.reduce((sum,item)=>sum+item.points,0)-penalty));
    return withDetail?{total,components:detail,penalty,turnoverPenalty,moneyPenalty}:total;
  }
  function apply(data){prepare(data);data.pairs.forEach(row=>row.synergyScore=calculate(data,row));return data}
  return {apply,calculate,components};
})();
