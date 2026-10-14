import { positionAt } from "./scene.js";
import { adaptLesson, clone, compilePlay, explanation, motionFor, newPlay, passReleaseProblem, retime, routeProgressTime, stepLength, stepsFor, uid, validatePlay } from "./coach-model.js";

export const ROUTES = {
  HITCH: "急停回身", SLANT: "短斜内切", OUT: "向外横切", IN: "向内横切",
  POST: "深斜内切", CORNER: "深斜外切", FLY: "直线深跑", OPTION: "内切回转向外",
  "STOP AND GO": "停后再冲", "POST CORNER": "内切再外切", CHAIR: "椅形路线",
};
export const boundPoint = point => [Math.max(0, Math.min(30, point[0])), Math.max(0, Math.min(70, point[1]))];
export const snapPoint = (point, snap = true) => boundPoint(point.map(v => Math.round(v * (snap ? 1 : 100)) / (snap ? 1 : 100)));

function projection(point, from, to) {
  const d = to.map((v, i) => v - from[i]), size = d[0] ** 2 + d[1] ** 2;
  const progress = size ? Math.max(0, Math.min(1, ((point[0]-from[0])*d[0] + (point[1]-from[1])*d[1]) / size)) : 0;
  const at = from.map((v,i) => v + d[i] * progress);
  return { progress, at, distance: Math.hypot(point[0]-at[0], point[1]-at[1]) };
}

/** Preserve turns, remove hand jitter, and cap a single stroke's data size. */
export function simplifyStroke(points, tolerance = .3) {
  if (points.length < 3) return points.map(boundPoint);
  const first = points[0], last = points.at(-1);
  let distance = tolerance, index = -1;
  for (let i=1; i<points.length-1; i++) {
    const next = projection(points[i], first, last).distance;
    if (next > distance) { distance = next; index = i; }
  }
  return index === -1 ? [boundPoint(first), boundPoint(last)] : [
    ...simplifyStroke(points.slice(0,index+1), tolerance).slice(0,-1),
    ...simplifyStroke(points.slice(index), tolerance),
  ];
}

/** Project onto elapsed distance, including curves with uniform arc speed. */
export function nearestRoutePoint(player, point) {
  let elapsed = 0, walked = 0, best = null;
  const motion = { ...player.motion, type: "path", startAt: 0 };
  const runner = { ...player, motion };
  let from = player.at;
  const lengths=(motion.steps||[]).map(s=>{const n=stepLength(from,s);if(s.to)from=s.to;return n;});
  const total=lengths.reduce((a,b)=>a+b,0);
  let index=0;
  for (const step of motion.steps || []) {
    if (step.type === "pause") { elapsed += step.seconds; index++; continue; }
    const count = step.type === "line" ? 1 : 80;
    let from = positionAt(runner, elapsed);
    for (let i=1; i<=count; i++) {
      const to = positionAt(runner, elapsed + step.seconds * i/count);
      const hit = projection(point, from, to);
      if (!best || hit.distance < best.distance) best = {
        ...hit, action: step.id, progress: (i-1+hit.progress)/count,
        fraction:total?(walked+lengths[index]*(i-1+hit.progress)/count)/total:0,
      };
      from = to;
    }
    elapsed += step.seconds;
    walked+=lengths[index++];
  }
  return best;
}

/** Reuse a stop within 0.25 yd along the same route or ball action, rather than stacking touch jitter. */
export function findNearbyStops(play, binding, scenarioId = play.defaultScenario) {
  if (!['route', 'ball'].includes(binding?.type) || !Number.isFinite(binding.progress)) return [];
  const compiled = compilePlay(play, scenarioId);
  let length = 0;
  if (binding.type === 'route') {
    const player = compiled.lesson.players.find(p => p.id === binding.player);
    if (!player) return [];
    let from = player.at;
    for (const step of player.motion.steps || []) { length += stepLength(from, step); if (step.to) from = step.to; }
  } else {
    if (binding.phase !== 'progress') return [];
    const event = compiled.scenario.events.find(e => e.id === binding.event);
    if (!event) return [];
    if (['snap', 'pass'].includes(event.type)) {
      const from = compiled.lesson.players.find(p => p.id === event.from), to = compiled.lesson.players.find(p => p.id === event.to);
      if (!from || !to || !Number.isFinite(event.endAt)) return [];
      const a = positionAt(from, event.at), b = positionAt(to, event.endAt);
      length = Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
  }
  return compiled.keyframes.filter(frame => {
    const other = frame.binding;
    return frame.valid && other.type === binding.type && Number.isFinite(other.progress)
      && (binding.type === 'route' ? other.player === binding.player : other.event === binding.event && other.phase === binding.phase)
      && (length>0 ? Math.abs(other.progress - binding.progress) * length <= .25 + 1e-9 : Math.abs(other.progress - binding.progress) <= 1e-9);
  }).sort((a, b) => Math.abs(a.binding.progress - binding.progress) - Math.abs(b.binding.progress - binding.progress));
}

export function replaceRoute(play, player, steps, term = "") {
  player.motion = { type: "path", start: { type: "delay", seconds: 0 }, steps };
  player.label.en = term;
  player.label.zh = ROUTES[term] || "";
  player.label.basis = "author";
  delete player.legacyReview;
  // A redraw replaces the meaning of the old stops; undo restores both together.
  play.bookmarks = play.bookmarks.filter(f => f.binding.player !== player.id);
  retime(player, player.motion);
  scheduleBall(play);
}
export function drawRoute(play, player, points, snap = true) {
  const reduced = simplifyStroke([player.at, ...points], snap ? .45 : .2);
  const clean = [player.at];
  for (const point of reduced.slice(1)) {
    const at = snapPoint(point, snap);
    if (Math.hypot(at[0]-clean.at(-1)[0], at[1]-clean.at(-1)[1]) >= .2) clean.push(at);
  }
  if (clean.length < 2) return false;
  replaceRoute(play, player, clean.slice(1).map(to => ({ id: uid("action"), type: "line", to, seconds: 1, timing: "auto" })));
  return true;
}
export function applyRouteTemplate(play, player, term, reference) {
  const p = player.at, inward = p[0]<15 ? 1 : -1;
  const pt = (dx,dy) => boundPoint([p[0]+dx,p[1]-dy]);
  const runner=reference?.players.find(p=>p.id==='X');
  if(runner?.motion.type==='path'&&term!=='HITCH') {
    const steps=clone(runner.motion.steps).map(step=>{
      step.id=uid('action');step.timing=step.type==='pause'?'fixed':'auto';
      if(step.type==='pause')step.seconds=1;
      delete step.facePlayer;delete step.faceFrom;
      for(const key of ['to','control','control1','control2'])if(step[key])step[key]=boundPoint([p[0]+inward*(step[key][0]-runner.at[0]),p[1]+step[key][1]-runner.at[1]]);
      return step;
    });
    replaceRoute(play,player,steps,term);return;
  }
  const qb=play.players.find(p=>['QB','Q'].includes(p.id)&&p.id!==player.id),turn=pt(0,7);
  const toward=qb?qb.at.map((v,i)=>v-turn[i]):[inward,1.7],size=Math.hypot(...toward)||1;
  const paths = {
    HITCH:[turn,boundPoint(turn.map((v,i)=>v+toward[i]/size*2))], SLANT:[pt(0,1),pt(inward*5,6)],
    OUT:[pt(0,5),pt(-inward*5,5)], IN:[pt(0,5),pt(inward*5,5)],
    POST:[pt(0,8),pt(inward*6,14)], CORNER:[pt(0,8),pt(-inward*5,14)],
    FLY:[pt(0,18)], OPTION:[pt(0,6),pt(inward*3,9),pt(-inward*3,12)],
    "STOP AND GO":[pt(0,5),null,pt(0,15)],
    "POST CORNER":[pt(0,7),pt(inward*3,10),pt(-inward*4,15)],
    CHAIR:[pt(0,5),pt(-inward*4,5),pt(-inward*4,14)],
  };
  if (!paths[term]) return;
  replaceRoute(play, player, paths[term].map((to,i) => to ? {
    id:uid("action"), type:"line",to,seconds:1,timing:"auto",
  } : {id:uid("action"),type:"pause",seconds:1,timing:"fixed"}), term);
}
export function moveObject(play, kind, id, to, key) {
  if (kind === "player") {
    const p = play.players.find(p=>p.id===id);
    const points=[p.at,...(p.motion.steps||[]).flatMap(s=>[s.to,s.control,s.control1,s.control2].filter(Boolean))];
    const delta=to.map((v,i)=>Math.max(-Math.min(...points.map(p=>p[i])),Math.min(v-p.at[i],[30,70][i]-Math.max(...points.map(p=>p[i])))));
    to=p.at.map((v,i)=>v+delta[i]);
    p.at = to;
    for (const step of p.motion.steps || []) for (const k of ["to","control","control1","control2"])
      if (step[k]) step[k] = step[k].map((v,i)=>v+delta[i]);
    delete p.legacyReview;
  } else if (kind === "zone") {
    const z=play.zones.find(z=>z.id===id);
    if (key?.startsWith("point:")) z.points[Number(key.slice(6))]=to;
    else if (key === "corner") {
      z.radiusX=Math.max(.5,Math.min(Math.abs(to[0]-z.center[0]),z.center[0],30-z.center[0]));
      z.radiusY=Math.max(.5,Math.min(Math.abs(to[1]-z.center[1]),z.center[1],70-z.center[1]));
    } else if (z.points) {
      const center=z.points.reduce((v,p)=>v.map((n,i)=>n+p[i]/z.points.length),[0,0]);
      const delta=to.map((v,i)=>Math.max(-Math.min(...z.points.map(p=>p[i])),Math.min(v-center[i],[30,70][i]-Math.max(...z.points.map(p=>p[i])))));z.points=z.points.map(p=>p.map((v,i)=>v+delta[i]));
    } else z.center=[Math.max(z.radiusX,Math.min(30-z.radiusX,to[0])),Math.max(z.radiusY,Math.min(70-z.radiusY,to[1]))];
  } else if (kind === "target") play.targets.find(t=>t.id===id).at=to;
  else if (kind === "duty") play.assignments.find(d=>d.id===id).end=to;
  scheduleBall(play);
}

function qbOf(play) {return play.players.find(p=>["QB","Q"].includes(p.id));}
export function simplePlay(type="offense") {return newPlay(type);}
export function routeRelease(play, playerId, progress) {
  const player = play.players.find(p => p.id === playerId);
  return { player: playerId, progress, actions: (player?.motion.steps || []).map(s => s.id) };
}
export function setPassRelease(play, scenarioId, eventId, progress) {
  const event = play.scenarios.find(s => s.id === scenarioId)?.events.find(e => e.id === eventId);
  if (event?.type !== 'pass') return;
  event.release = routeRelease(play, event.from, progress);
  scheduleBall(play);
  return event;
}
function withoutClock(text = "") {
  return text.split(/(?<=[。！？])\s*|(?<=[.!?])\s+|\n/u).filter(line => !/(?:\d[\d.]*\s*(?:秒|seconds?\b|secs?\b|s\b))/iu.test(line)).join(" ").trim();
}

function ensureSnap(play, scenario) {
  const qb=qbOf(play),center=play.players.find(p=>p.id==="C");
  if (play.initialOwner==="C"&&qb&&center&&scenario.events[0]?.type!=="snap") scenario.events.unshift({
    id:uid("ball"),type:"snap",from:"C",to:qb.id,label:"snap",cue:"",auto:true,
    start:{type:"time",seconds:0},end:{type:"time",seconds:.35},explanation:explanation(),
  });
}

/** Find an actual meeting in the simultaneous route animation; never move a player. */
export function meetingTime(a,b,from=0,duration=0) {
  let best={time:from,distance:Infinity};
  const end=Math.max(from,duration);
  for(let t=from;t<=end+.001;t+=.025) {
    const pa=positionAt(a,Math.min(t,end)),pb=positionAt(b,Math.min(t,end));
    const distance=Math.hypot(pa[0]-pb[0],pa[1]-pb[1]);
    if(distance<best.distance)best={time:Math.min(t,end),distance};
  }
  const pa=positionAt(a,end),pb=positionAt(b,end),distance=Math.hypot(pa[0]-pb[0],pa[1]-pb[1]);
  if(distance<best.distance)best={time:end,distance};
  return best;
}

function routeSamples(player, minimum = 0) {
  const points=[{at:player.at,time:player.motion.type === 'path' ? player.motion.startAt||0 : minimum}];
  let time=player.motion.startAt||0;
  for(const step of player.motion.steps||[]) {
    const count=['quadratic','cubic'].includes(step.type)?32:1;
    for(let i=1;i<=count;i++)points.push({at:positionAt(player,time+step.seconds*i/count),time:time+step.seconds*i/count});
    time+=step.seconds;
  }
  if(points.length===1)points.push({...points[0]});
  return points;
}
function spatialMeeting(a,b,minimumA,minimumB) {
  const pa=routeSamples(a,minimumA),pb=routeSamples(b,minimumB);let best;
  const consider=(aa,bb)=>{
    if(aa.time<minimumA-1e-6||bb.time<minimumB-1e-6)return;
    const distance=Math.hypot(aa.at[0]-bb.at[0],aa.at[1]-bb.at[1]);
    const at=Math.max(aa.time,bb.time,minimumA,minimumB);
    if(distance<=.45&&(!best||at<best.time))best={a:aa,b:bb,time:at};
  };
  for(let i=1;i<pa.length;i++)for(let j=1;j<pb.length;j++) {
    const p=pa[i-1],q=pa[i],r=pb[j-1],s=pb[j],u=q.at.map((v,k)=>v-p.at[k]),v=s.at.map((n,k)=>n-r.at[k]);
    const cross=(a,b)=>a[0]*b[1]-a[1]*b[0],den=cross(u,v),delta=r.at.map((n,k)=>n-p.at[k]);
    if(Math.abs(den)>1e-9){const ta=cross(delta,v)/den,tb=cross(delta,u)/den;if(ta>=0&&ta<=1&&tb>=0&&tb<=1)consider({at:p.at.map((n,k)=>n+u[k]*ta),time:p.time+(q.time-p.time)*ta},{at:r.at.map((n,k)=>n+v[k]*tb),time:r.time+(s.time-r.time)*tb});}
    for(const aa of [p,q]){const hit=projection(aa.at,r.at,s.at);consider(aa,{at:hit.at,time:r.time+(s.time-r.time)*hit.progress});}
    for(const bb of [r,s]){const hit=projection(bb.at,p.at,q.at);consider({at:hit.at,time:p.time+(q.time-p.time)*hit.progress},bb);}
  }
  return best;
}
function waitAt(player,arrival,wait,id) {
  if(wait<.001||player.motion.type!=='path')return;
  let time=player.motion.startAt,from=player.at;
  for(let i=0;i<player.motion.steps.length;i++) {
    const step=player.motion.steps[i];
    if(arrival<=time+step.seconds+1e-6){
      const pause={id:uid('wait'),type:'pause',seconds:wait,timing:'fixed',automaticMeeting:id};
      const ratio=Math.max(0,Math.min(1,(arrival-time)/step.seconds));
      if(ratio>.9999)player.motion.steps.splice(i+1,0,pause);
      else if(ratio<.0001)player.motion.steps.splice(i,0,pause);
      else if(step.type==='pause')player.motion.steps.splice(i,1,{...step,seconds:step.seconds+wait});
      else {
        // Sampling only affects the derived timing path. The editable curve remains unchanged.
        const steps=[],count=step.type==='line'?1:48;
        const fractions=[0,...Array.from({length:count},(_,n)=>(n+1)/count),ratio].sort((a,b)=>a-b);
        for(let k=1;k<fractions.length;k++)if(fractions[k]-fractions[k-1]>1e-7){const to=positionAt(player,time+step.seconds*fractions[k]);steps.push({id:uid('part'),type:'line',to,seconds:step.seconds*(fractions[k]-fractions[k-1]),timing:'fixed',automaticMeeting:id});if(Math.abs(fractions[k]-ratio)<1e-7)steps.push(pause);}
        player.motion.steps.splice(i,1,...steps);
      }
      return;
    }
    time+=step.seconds;if(step.to)from=step.to;
  }
}

/** Materialize default teaching times after every edit. No timing controls or shared chains. */
export function scheduleBall(play) {
  const opening = ["offense","run"].includes(play.type) && play.scenarios.some(s=>s.mode==="ball") ? .35 : 0;
  for(const p of play.players) if(p.motion.type==="path") {
    p.motion.start={type:"delay",seconds:opening};retime(p,p.motion);
  }
  const routePlay={...play,sharedEvents:[],bookmarks:[],referenceDuration:undefined,
    scenarios:play.scenarios.map(s=>({...s,mode:"routes",events:[]}))};
  const base=compilePlay({...routePlay,scenarios:routePlay.scenarios.map(s=>({...s,overrides:{}}))}).lesson;
  for(const s of play.scenarios) {
    s.overrides={};if(s.mode!=="ball")continue;
    const actors=clone(base.players),byId=new Map(actors.map(p=>[p.id,p])),committed=new Map();
    ensureSnap(play,s);
    let until=0;
    for(const e of s.events) {
      delete e.pending;
      let start=until,end;
      const target=byId.get(e.to),from=byId.get(e.from);
      if(e.type==="snap")end=start+.35;
      else if(e.type==="pass") {
        if(e.release) {
          const original=play.players.find(p=>p.id===e.from),valid=e.release.player===e.from&&Array.isArray(e.release.actions)&&JSON.stringify(e.release.actions)===JSON.stringify(original?.motion.steps?.map(s=>s.id));
          start=valid?routeProgressTime(from,e.release.progress):NaN;
          // An exchange wait may hold this exact position until the ball arrives.
          if(Number.isFinite(start)&&start<until&&Array.from({length:33},(_,i)=>positionAt(from,start+(until-start)*i/32)).every(p=>Math.hypot(...p.map((v,i)=>v-positionAt(from,start)[i]))<1e-7))start=until;
          if(!Number.isFinite(start)){start=null;end=null;e.pending='release';}else end=start+.65;
        } else {
          const finishes=target?.motion.type==="path" ? target.motion.startAt+target.motion.steps.reduce((v,a)=>v+a.seconds,0) : 0;
          end=Math.max(until+.7,finishes);start=Math.max(until,end-.65);
        }
      } else if(["handoff","fake-handoff"].includes(e.type)&&from&&target) {
        const duration=Math.max(until,...actors.map(p=>(p.motion.startAt||0)+(p.motion.steps||[]).reduce((a,b)=>a+b.seconds,0)));
        let meet=meetingTime(from,target,until,duration);
        if(meet.distance>.5){const spatial=spatialMeeting(from,target,Math.max(until,committed.get(e.from)||0),committed.get(e.to)||0);
          if(spatial){waitAt(from,spatial.a.time,spatial.time-spatial.a.time,e.id);waitAt(target,spatial.b.time,spatial.time-spatial.b.time,e.id);meet={time:spatial.time,distance:0};}}
        start=meet.distance<=.5?meet.time:null;
        if(start===null)e.pending="meeting";
        if(e.type==="fake-handoff")end=start===null?null:start+.4;
      } else if(e.type==="pump-fake") {start=until+.15;end=start+.35;}
      e.start={type:"time",seconds:start};
      if(end!==undefined)e.end={type:"time",seconds:end};else delete e.end;
      e.auto=true;
      until=Number.isFinite(end)?end:Number.isFinite(start)?start:until;
      if(Number.isFinite(start)){committed.set(e.from,until);if(e.to)committed.set(e.to,until);}
    }
    for(const actor of actors)if(actor.motion.type==='path'&&actor.motion.steps.some(a=>a.automaticMeeting)) {
      const m=clone(actor.motion);m.start={type:'delay',seconds:m.startAt||0};
      m.steps.forEach(a=>a.id=uid('timing'));
      Object.defineProperty(s.overrides,actor.id,{value:m,enumerable:true,configurable:true,writable:true});
    }
    const compiled=compilePlay(play,s.id);
    for(const event of compiled.scenario.events)if(event.release&&passReleaseProblem(play,compiled,event))s.events.find(e=>e.id===event.id).pending='release';
  }
}

function endOwner(play,scenario) {
  return scenario.events.filter(e=>["snap","pass","handoff"].includes(e.type)).at(-1)?.to || (play.initialOwner === "C" ? qbOf(play)?.id : play.initialOwner);
}
export function ballActors(play,scenario) {return new Set([qbOf(play)?.id,endOwner(play,scenario),...scenario.events.filter(e=>['snap','pass','handoff'].includes(e.type)).map(e=>e.to)]);}
export function addBallAction(play,scenarioId,type,from,to,release) {
  let scenario=play.scenarios.find(s=>s.id===scenarioId);
  if(!scenario||from===to)return scenario;
  // Selecting the QB again makes another ending, rather than an impossible second throw.
  const transfer=scenario.events.findLastIndex(e=>["pass","handoff"].includes(e.type)&&e.from===from);
  if(transfer>=0&&endOwner(play,scenario)!==from) {
    const prefix=scenario.events.slice(0,transfer);
    const existing=play.scenarios.find(s=>s.events.at(-1)?.type===type&&s.events.at(-1)?.from===from&&s.events.at(-1)?.to===to&&
      s.events.length===prefix.length+1&&s.events.slice(0,-1).every((e,i)=>e.type===prefix[i].type&&e.from===prefix[i].from&&e.to===prefix[i].to&&JSON.stringify(e.release)===JSON.stringify(prefix[i].release))&&JSON.stringify(s.events.at(-1)?.release)===JSON.stringify(release));
    if(existing)return existing;
    scenario={id:uid("plan"),title:{zh:"",en:""},mode:"ball",choices:{},overrides:{},events:prefix.map(e=>({...clone(e),id:uid("ball")})),explanation:explanation()};
    play.scenarios.push(scenario);
  }
  scenario.mode="ball";
  scenario.events.push({id:uid("ball"),type,from,to,start:{type:"time",seconds:0},...(release?{release:clone(release)}:{}),label:type,cue:"",auto:true,explanation:explanation()});
  scenario.title={zh:(type==="pass"?"传给 ":type==="handoff"?"交给 ":type==="fake-handoff"?"假交给 ":"假传给 ")+to,
    en:(type==="pass"?"Pass to ":type==="handoff"?"Handoff to ":type==="fake-handoff"?"Fake to ":"Pump fake to ")+to};
  scheduleBall(play);
  return scenario;
}

/** Built-ins stay intact. Copies adopt a common route set and the default teaching rhythm. */
export function copySimpleLesson(lesson) {
  const play=adaptLesson(lesson),defaultPlan=play.scenarios.find(s=>s.id===play.defaultScenario);
  const original=compilePlay(play,play.defaultScenario);
  for(const p of play.players) {
    const m=clone(motionFor(play,defaultPlan,p));
    if(m.type==="choice") {
      m.steps=clone(stepsFor(m,defaultPlan.choices[p.id]));m.type="path";delete m.options;
    }
    p.motion=m;
    if(m.type==="path") {m.start={type:"delay",seconds:0};m.steps.forEach(s=>s.timing=s.type==="pause"?"fixed":"auto");retime(p,m);}
    delete p.legacyReview;
  }
  for(const s of play.scenarios){s.overrides={};s.choices={};delete s.motions;}
  play.sharedEvents=[];delete play.referenceDuration;delete play.legacyRouteGuide;
  // Bind copied teaching captions to the same underlying action, not stale absolute seconds.
  play.bookmarks=play.bookmarks.filter(f=>f.binding.seconds===0||Number.isFinite(f.binding.seconds)).map(f=>{
    const at=f.binding.seconds;
    if(at===0)return f;
    const ball=original.scenario.events.find(e=>Math.abs(e.at-at)<.01||Math.abs((e.endAt??-1)-at)<.01);
    if(ball)return{...f,scenario:play.defaultScenario,binding:{type:"ball",event:ball.id,phase:Math.abs(ball.at-at)<.01?"start":"end"}};
    let best;
    for(const [id,action]of original.actions){const distance=Math.min(Math.abs(at-action.start),Math.abs(at-action.end));if(!best||distance<best.distance)best={id,action,distance};}
    if(!best)return null;
    const player=play.players.find(p=>p.id===best.action.player),progress=Math.max(0,Math.min(1,(at-best.action.start)/(best.action.end-best.action.start)));
    let from=player.at,walked=0,distance=0,total=0;for(const a of player.motion.steps||[]){const n=stepLength(from,a);if(a.id===best.id)distance=walked+n*progress;walked+=n;total+=n;if(a.to)from=a.to;}
    return{...f,binding:{type:"route",player:player.id,progress:total?distance/total:0}};
  }).filter(Boolean);
  scheduleBall(play);
  for(const item of [play,...play.players,...play.bookmarks]) {
    for(const text of Object.values(item.explanation || {})) text.text=withoutClock(text.text);
  }
  if(play.type==='route'){play.scenarios=play.scenarios.filter(s=>s.id===play.defaultScenario);}
  // Different original running variants can require incompatible route shapes.
  // Keep the selected common geometry and only the outcomes it can perform.
  const errors=validatePlay(play,{name:false}).errors;
  const unavailable=new Set(errors.filter(e=>e.scenario&&e.scenario!==play.defaultScenario).map(e=>e.scenario));
  if(unavailable.size){play.scenarios=play.scenarios.filter(s=>!unavailable.has(s.id));play.bookmarks=play.bookmarks.filter(f=>!f.scenario||!unavailable.has(f.scenario));play.origin.omittedOutcomes=unavailable.size;}
  return play;
}
