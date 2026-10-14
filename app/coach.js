import { getLanguage } from './i18n.js';
import { getScene, positionAt, pathToSvg } from './scene.js';
import { getBallState } from './ball.js';
import { clone, compilePlay, explanation, stepLength, teachingText, uid, validatePlay, zoneCenter } from './coach-model.js';
import { simplePlay, copySimpleLesson, ROUTES, addBallAction, applyRouteTemplate, ballActors, boundPoint, drawRoute, findNearbyStops, moveObject, nearestRoutePoint, scheduleBall, simplifyStroke, snapPoint } from './coach-drawing.js';
import { CoachStore, backup, copyRecord, equivalent, makeRecord, parseBackup, teachingRecord } from './coach-storage.js';

const palette=['#83d4ed','#f3cb7e','#c7df91','#d1c5ec','#efa9a0'];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tr=(zh,en)=>getLanguage()==='en'?en:zh;
const titleOf=p=>p?.title?.[getLanguage()]||p?.title?.zh||p?.title?.en||p?.name||p?.label||tr('未命名战术','Untitled tactic');
const colorOf=(p,i)=>/^#[0-9a-f]{6}$/i.test(p.color||'')?p.color:palette[i%5];
const icons={back:'<path d="m14 5-7 7 7 7"/>',undo:'<path d="M8 6H3v5m0-5c5-5 15-1 15 6 0 4-3 7-7 7"/>',redo:'<path d="M16 6h5v5m0-5C16 1 6 5 6 12c0 4 3 7 7 7"/>',more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',fit:'<path d="M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5"/>',play:'<path d="m7 4 13 8-13 8Z"/>',pause:'<path d="M8 4v16M16 4v16"/>',close:'<path d="m6 6 12 12M18 6 6 18"/>'};
const icon=key=>`<svg viewBox="0 0 24 24" aria-hidden="true">${icons[key]}</svg>`;
const button=(action,label,attrs='')=>`<button type="button" data-do="${action}" ${attrs}>${esc(label)}</button>`;
const iconButton=(action,key,label,attrs='')=>`<button type="button" class="coach-icon ${action==='fit'?'coach-fit':''}" data-do="${action}" aria-label="${esc(label)}" ${attrs}>${icon(key)}</button>`;
const types=()=>[['offense',tr('进攻战术','Passing play')],['run',tr('跑球战术','Running play')],['route',tr('基础路线','Basic route')],['formation',tr('阵型','Formation')],['defense',tr('防守','Defense')]];
const eventName=(type)=>({pass:tr('传球','Pass'),handoff:tr('交递','Handoff'),'fake-handoff':tr('假交递','Fake handoff'),'pump-fake':tr('假传','Pump fake'),snap:tr('开球','Snap')})[type];
const safeURL=value=>{try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}};

export function initCoach({getCurrentLesson,pauseTeaching,routeLessons=[]}) {
  const store=new CoachStore({temporary:location.protocol==='file:'});
  const root=document.createElement('section');root.className='coach';root.hidden=true;root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-label','Flagventures Coach');document.body.append(root);
  const dialog=document.createElement('dialog');dialog.className='coach-modal';document.body.append(dialog);
  let records=[],record,play,screen='library',viewOnly=false,selection=null,scenarioId,mode=null,menu=null,sheet=null;
  let camera={x:-2,y:20,w:34,h:44},snap=true,time=0,speed=2,playing=false,playbackFinished=false,frameId=null;
  let undo=[],redo=[],generation=0,retained=0,manual=0,saveError='',loading=true,saveTimer,queue=Promise.resolve(),cache;
  let pointers=new Map(),gesture=null,stroke=[],longTimer,animation,lastTick,undoDeletion,undoTimer,toastTimer,previousFocus,channel;
  const ready=store.open().then(()=>store.list()).then(all=>{records=all;loading=false;}).catch(e=>{saveError=e.message;loading=false;});
  const plan=()=>play?.scenarios.find(s=>s.id===scenarioId);
  const object=(kind,id)=>kind==='play'?play:({player:play?.players,zone:play?.zones,target:play?.targets,duty:play?.assignments,frame:play?.bookmarks,event:plan()?.events})[kind]?.find(o=>o.id===id);
  const compiled=()=>{if(!cache||cache.play!==play||cache.generation!==generation||cache.id!==scenarioId)cache={play,generation,id:scenarioId,result:compilePlay(play,scenarioId)};return cache.result;};
  const atFinish=()=>playbackFinished||(!playing&&!frameId&&time>0&&time>=compiled().lesson.timeline.duration);
  const checks=(name=true)=>validatePlay(play,{name});
  const localMessage=message=>message.split(' / ')[getLanguage()==='en'?1:0]||message;
  function stop(finished=false){playing=false;playbackFinished=finished;lastTick=undefined;if(animation)cancelAnimationFrame(animation);animation=undefined;}
  function notify(message){let node=root.querySelector('.coach-toast');if(!node){node=document.createElement('p');node.className='coach-toast';node.setAttribute('role','status');root.append(node);}node.textContent=message;clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.remove(),3500);}
  function status(){if(viewOnly)return tr('已保存教学版','Saved teaching version');if(saveError)return tr('尚未保留 · 点击重试','Not retained · Tap to retry');if(store.temporary)return tr('临时编辑 · 关闭前备份','Temporary · Back up before closing');if(generation>retained)return tr('正在保留草稿…','Retaining draft…');return generation===manual?tr('已保存','Saved'):tr('草稿已保留','Draft retained');}
  function updateStatus(){const n=root.querySelector('.coach-status');if(n){n.textContent=status();n.classList.toggle('error',!!saveError);const parent=n.closest('button');if(parent)parent.dataset.do=saveError?'save-help':'details';}}
  function checkpoint(){undo.push(clone(play));if(undo.length>60)undo.shift();redo=[];}
  function changed(){generation++;cache=null;stop();clearTimeout(saveTimer);saveTimer=setTimeout(()=>retain().catch(()=>{}),450);updateStatus();}
  function edit(work,{renderNow=true}={}){if(viewOnly)return;checkpoint();work();scheduleBall(play);changed();if(renderNow)render();}
  function enqueue(work){const next=queue.catch(()=>{}).then(work);queue=next;return next;}
  async function retain(){if(!play||viewOnly)return;clearTimeout(saveTimer);const snapshot=clone(play),stamp=generation,id=record.id;return enqueue(async()=>{try{records=await store.change([{id,expected:record.revision,record:{...clone(record),draft:snapshot}}]);if(record?.id===id){record=records.find(r=>r.id===id);retained=Math.max(retained,stamp);}saveError='';updateStatus();}catch(e){saveError=e.message;updateStatus();throw e;}});}
  async function leave(work){stop();cancelGesture();if(play&&!viewOnly)await retain();return work();}
  function openRecord(value,teach=false){record=clone(value);play=clone(teach?value.saved:value.draft);viewOnly=teach;screen='board';selection=null;scenarioId=play.defaultScenario;mode=menu=sheet=null;time=0;frameId=null;undo=[];redo=[];generation=retained=0;manual=JSON.stringify(value.draft)===JSON.stringify(value.saved)?0:-1;saveError='';routesOnly=false;camera=nearCamera();stop();cache=null;render();}
  function nearCamera(){return{x:-2,y:Math.max(0,play.field.lineOfScrimmageY-30),w:34,h:44};}
  async function create(type='offense',source){const fresh=makeRecord(source?copySimpleLesson(source):simplePlay(type)),value=source?copyRecord(fresh,records):fresh;records=await store.change([{id:value.id,expected:0,record:value}]);openRecord(records.find(r=>r.id===value.id));if(source)notify(value.draft.origin.omittedOutcomes?tr('已复制默认跑位；不适用这套跑位的旧结局未复制。出处已保留。','Default routes copied; incompatible old outcomes were omitted. Sources retained.'):tr('已复制跑位与出处；节奏为默认教学示意。','Routes and sources copied; timing uses the default teaching rhythm.'));}
  async function save(asCopy=false){
    if(!Object.values(play.title).some(v=>v.trim())){sheet={kind:'play',saveAfter:true};render();root.querySelector('[data-edit="title"]')?.focus();return false;}
    if(play.defaultScenario!==scenarioId){play.defaultScenario=scenarioId;changed();}
    const errors=checks().errors;if(errors.length){sheet={kind:'issues'};menu=null;render();notify(tr('先修复标出的内容；草稿会保留。','Fix the highlighted items; the draft is retained.'));return false;}
    const snapshot=clone(play),stamp=generation;
    await enqueue(async()=>{let target=record;if(asCopy)target=copyRecord({...record,draft:snapshot},records);const value=teachingRecord(target,asCopy?target.draft:snapshot);records=await store.change([{id:value.id,expected:asCopy?0:record.revision,record:value,enforceNames:true}]);if(asCopy)openRecord(records.find(r=>r.id===value.id));else{record=records.find(r=>r.id===value.id);retained=Math.max(retained,stamp);manual=stamp;saveError='';updateStatus();}notify(store.temporary?tr('本次内容已保存；关闭前请导出备份。','Session saved; export a backup before closing.'):tr('教学版已保存','Teaching version saved'));});
    if(generation>stamp&&!asCopy)saveTimer=setTimeout(()=>retain().catch(()=>{}),100);
    return true;
  }
  function exportBackup(single=false){const current=play&&!viewOnly?{...clone(record),draft:clone(play)}:record;const values=single?[current]:records.map(r=>r.id===current?.id?current:r);if(!values.length){notify(tr('还没有战术','No tactics yet'));return;}const url=URL.createObjectURL(new Blob([JSON.stringify(backup(values),null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`Flagventures-${single?'tactic':'library'}.backup.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);notify(tr('备份开始下载，请确认文件保存完成。','Backup download started; check that the file is saved.'));}
  function ask(title,content,confirm){dialog.innerHTML=`<h2>${esc(title)}</h2>${content}<p class="coach-dialog-error" role="alert"></p><div class="coach-dialog-actions">${button('cancel',tr('取消','Cancel'))}${button('confirm',tr('确认','Confirm'),'class="primary"')}</div>`;dialog.showModal();dialog.querySelector('[data-do=cancel]').onclick=()=>dialog.close();dialog.querySelector('[data-do=confirm]').onclick=async()=>{try{await confirm();dialog.close();}catch(e){dialog.querySelector('[role=alert]').textContent=e.message;}};}
  function menuAt(kind,id,event,page='main'){stop();if(kind==='frame'){time=compiled().keyframes.find(f=>f.id===id)?.at??time;frameId=id;}else if(!viewOnly&&['player','route'].includes(kind)){time=0;frameId=null;}mode=null;sheet=null;selection={kind,id};menu={kind,id,page,x:event.clientX,y:event.clientY,...(kind==='blank'?{point:boundPoint(pointAt(event))}:{})};render();}
  function select(kind,id){const reset=atFinish()&&kind==='player';stop();if(!viewOnly||reset){time=0;frameId=null;}selection={kind,id};menu=sheet=null;mode=null;render();}
  function setSheet(kind,id){menu=null;sheet={kind,id};stop();render();}
  function render(){
    if(root.hidden)return;
    const focus=document.activeElement?.dataset.edit,caret=document.activeElement?.selectionStart,scroll=root.querySelector('.coach-library')?.scrollTop;
    const oldToast=root.querySelector('.coach-toast')?.textContent;
    root.innerHTML=header()+(screen==='library'?libraryHtml():boardHtml())+'<div class="coach-overlays"></div><input id="coachBackupInput" type="file" accept=".json" hidden>';
    if(screen==='board')renderBoard();renderOverlay();updateStatus();if(oldToast)notify(oldToast);if(undoDeletion)renderUndo();
    if(scroll)root.querySelector('.coach-library').scrollTop=scroll;
    if(focus){const input=root.querySelector(`[data-edit="${CSS.escape(focus)}"]`);input?.focus({preventScroll:true});if(typeof caret==='number'&&['text','textarea'].includes(input?.type))input.setSelectionRange(caret,caret);}
    root.querySelector('#coachBackupInput').onchange=e=>importFile(e.target.files[0]).catch(e=>notify(e.message));
  }
  function header(){return `<header class="coach-head">${iconButton(screen==='library'?'close':'library','back',screen==='library'?tr('返回教学','Back to lessons'):tr('返回我的战术','Back to my tactics'))}<div class="coach-heading">${screen==='library'?`<h1>Flagventures <small>${esc(tr('我的战术','My tactics'))}</small></h1>`:`<button type="button" class="coach-title" data-do="${saveError?'save-help':'details'}" aria-label="${esc(tr('战术名称与说明','Tactic name and explanation'))}"><span class="coach-name">${esc(titleOf(play))}</span><small class="coach-status" role="status"></small></button>`}</div>${iconButton('more','more',tr('更多','More'))}${screen==='library'?button('new',tr('＋ 新战术','＋ New tactic'),'class="primary"'):viewOnly?button('edit-saved',tr('编辑草稿','Edit draft'),'class="primary"'):button('save',tr('保存','Save'),'class="primary"')}</header>`;}
  function thumbnail(value){return `<svg viewBox="-2 20 34 45" aria-hidden="true"><path d="M0 ${value.field.lineOfScrimmageY}H30" stroke="#f1d68d" stroke-width=".12"/>${value.players.map((p,i)=>`<path d="${esc(pathToSvg(p.at,p.motion.steps||[]))}" stroke="${colorOf(p,i)}" stroke-width=".35" fill="none"/><circle cx="${p.at[0]}" cy="${p.at[1]}" r=".9" fill="${colorOf(p,i)}"/>`).join('')}</svg>`;}
  function libraryHtml(){return `<section class="coach-library">${loading?`<p>${esc(tr('正在读取战术…','Loading tactics…'))}</p>`:saveError?`<div class="coach-storage-error" role="alert"><p>${esc(saveError)}</p>${button('retry-store',tr('重试','Retry'))}${button('temporary',tr('临时画板','Temporary board'))}</div>`:`<p class="coach-library-intro">${esc(store.temporary?tr('本次临时使用；关闭前请导出备份。','Temporary session; export a backup before closing.'):tr('点开继续画；长按卡片可复制或删除。','Open to keep drawing; hold a card to copy or delete.'))}${store.resetLegacy?` ${esc(tr('旧画板数据已清空。','The old board library has been cleared.'))}`:''}</p>`}<div class="coach-cards">${[...records].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(r=>`<article class="coach-card" data-card="${esc(r.id)}" role="button" tabindex="0" aria-label="${esc(tr('打开 ','Open ')+titleOf(r.draft))}">${thumbnail(r.draft)}${iconButton('card-more','more',tr('战术操作','Tactic actions'),`data-id="${esc(r.id)}"`)}<h2>${esc(titleOf(r.draft))}</h2><p>${esc(types().find(t=>t[0]===r.draft.type)?.[1]||'')} · ${esc(!r.saved?tr('草稿','Draft'):JSON.stringify(r.draft)===JSON.stringify(r.saved)?tr('已保存','Saved'):tr('有草稿修改','Draft changes'))}</p></article>`).join('')}</div>${!loading&&!saveError&&!records.length?`<div class="coach-empty"><p>${esc(tr('画出你们的第一套配合','Draw your first team play'))}</p>${button('copy-builtin',tr('复制当前教学条目','Copy this lesson'))}</div>`:''}</section>`;}
  function boardHtml(){const errors=checks(false).errors.filter(e=>!e.message.includes('Draw at least one route')&&!e.message.includes('Add at least one duty'));return `<main class="coach-work"><div class="coach-board"><span class="coach-board-label">${esc(viewOnly?tr('已保存教学版','Saved teaching version'):play.type==='defense'?tr('防守分工','Defensive duties'):tr('↑ 进攻方向','↑ Attack direction'))}</span>${iconButton('fit','fit',tr('全场与近景切换','Full field / close-up'),'')}<svg class="coach-canvas" tabindex="0" aria-label="${esc(tr('战术画板：点选拖动，长按打开菜单','Tactic board: select and drag; hold for actions'))}" preserveAspectRatio="xMidYMid meet"></svg><div class="coach-hint" role="status">${esc(hint())}</div><div class="coach-hud"><div class="coach-undo-tools" ${viewOnly||(!undo.length&&!redo.length)?'hidden':''}>${iconButton('undo','undo',tr('撤销','Undo'),undo.length?'':'disabled')}${iconButton('redo','redo',tr('重做','Redo'),redo.length?'':'hidden')}</div><button type="button" class="coach-play" data-do="play">${icon(playing?'pause':'play')}<span>${esc(playing?tr('暂停','Pause'):tr('播放','Play'))}</span></button>${play.scenarios.length>1?button('outcomes',titleOf(plan())+' ⌄','class="coach-outcome"'):errors.length?button('issues',tr('有内容待调整','Needs adjustment'),'class="coach-outcome coach-problem"'):''}</div></div></main>`;}
  function hint(){if(atFinish())return tr('播放结束 · 点击任意球员回到初始站位','Playback finished · Tap any player to return to the starting positions');if(mode?.type==='pan')return tr('拖动移动画布；点一下退出','Drag to pan; tap to exit');if(mode?.type==='draw')return tr(`从 ${mode.player} 拖出路线，松开完成`,`Draw from ${mode.player}; release to finish`);if(mode?.type==='ball')return tr('点目标球员','Tap the target player');if(mode?.type==='zone')return tr('拖出区域，松开完成','Draw the zone; release to finish');if(mode?.type==='duty')return tr('点区域或目标；也可点场上一个位置','Tap a zone, target, or field position');if(mode?.type==='target')return tr('点场上放置目标标记','Tap the field to place a target');if(frameId){const f=play.bookmarks.find(f=>f.id===frameId);const text=teachingText(f,getLanguage());return text.text?text.text+(text.fallback?tr('（尚无中文译文）',' (translation not available)'):''):tr('停在这里讲解','Pause here to explain');}if(time>0)return `${time.toFixed(1)} s${routesOnly?' · '+tr('仅跑位','Routes only'):''} · ${tr('点停点可以停留讲解','Tap a stop to explain')}`;if(selection?.kind==='player'){const p=object('player',selection.id);return `${p.name||p.id}${p.label.en?' · '+p.label.en:''} · ${tr('拖动摆人 · 长按打开菜单','Drag to position · Hold for actions')}`;}return tr('点选摆人 · 长按画线 · 点线加停点','Select to position · Hold to draw · Tap a route for a stop');}
  function renderOverlay(){const host=root.querySelector('.coach-overlays');if(!host)return;if(menu){const list=menuItems();const left=Math.max(12,Math.min(innerWidth-250,menu.x??innerWidth-270));const count=Math.ceil(list.length/(menu.page==='templates'?2:1));const top=Math.max(12,Math.min(innerHeight-Math.min(innerHeight*.7,44*count+50)-12,menu.y??78));host.innerHTML=`<div class="coach-backdrop" data-do="dismiss"></div><section class="coach-context" role="menu" aria-label="${esc(tr('场上操作','On-field actions'))}" style="left:${left}px;top:${top}px"><h2>${esc(menuTitle())}</h2><div ${menu.page==='templates'?'class="coach-template-grid"':''}>${list.map(([action,label,attrs=''])=>button(action,label,`role="menuitem" ${attrs}`)).join('')}</div></section>`;}else if(sheet)host.innerHTML=`<div class="coach-backdrop" data-do="dismiss"></div><section class="coach-sheet" role="dialog" aria-label="${esc(sheetTitle())}"><div class="coach-sheet-head"><h2>${esc(sheetTitle())}</h2>${iconButton('dismiss','close',tr('收起','Collapse'))}</div>${sheetHtml()}</section>`;else host.innerHTML='';}
  function menuTitle(){if(menu.kind==='player')return `${object('player',menu.id).name||menu.id} ${object('player',menu.id).label.en||''}`;if(menu.kind==='new')return tr('新建战术','New tactic');if(menu.kind==='card')return titleOf(records.find(r=>r.id===menu.id).draft);if(menu.kind==='route')return menu.id+' · '+tr('路线','Route');if(menu.kind==='blank')return tr('在这里添加','Add here');if(menu.kind==='outcomes')return tr('这次怎样配合','Choose this outcome');return tr('更多','More');}
  function menuItems(){
    if(menu.page==='templates')return Object.keys(ROUTES).map(term=>['template',getLanguage()==='zh'?`${term} · ${ROUTES[term]}`:term,`data-term="${term}"`]);
    if(menu.page==='fake')return [['ball',tr('假交递','Fake handoff'),'data-type="fake-handoff"'],['ball',tr('假传','Pump fake'),'data-type="pump-fake"']];
    if(menu.kind==='new')return types().map(([type,label])=>['create',label,`data-type="${type}"`]);
    if(menu.page==='duties')return [['assign-duty',tr('覆盖区域','Coverage'),'data-type="coverage"'],['assign-duty',tr('盯人／指向目标','Matchup / target'),'data-type="matchup"'],['assign-duty',tr('冲传方向','Rush direction'),'data-type="rush"']];
    if(menu.page==='view')return [['zoom-in',tr('放大','Zoom in')],['zoom-out',tr('缩小','Zoom out')],['fit',tr('全场／近景','Full field / close-up')],['pan',tr('拖动移动画布','Drag to pan')]];
    if(menu.page==='zones')return [['zone',tr('椭圆区域','Ellipse'),'data-type="ellipse"'],['zone',tr('矩形区域','Rectangle'),'data-type="rectangle"'],['zone',tr('多边形区域','Polygon'),'data-type="polygon"']];
    if(menu.kind==='player'){
      const list=[],p=object('player',menu.id);
      if(!viewOnly&&['offense','run'].includes(play.type)&&ballActors(play,plan()).has(p.id))list.push(['ball',tr('传球 ↗','Pass ↗'),'data-type="pass"'],['ball',tr('交递','Handoff'),'data-type="handoff"'],['fake-menu',tr('假动作 ›','Fake ›')]);
      if(!viewOnly&&play.type!=='formation')list.push(['draw',tr('画路线 ↗','Draw route ↗')],['templates',tr('套用跑法 ›','Route template ›')]);
      if(!viewOnly&&play.type==='defense')list.push(['duty',tr('安排职责','Assign duty')]);
      list.push(['explain',tr('说明','Explanation')]);if(!viewOnly&&p.motion.steps?.length)list.push(['remove-route',tr('清除路线','Clear route'),'class="danger"']);return list;
    }
    if(menu.kind==='route')return viewOnly?[['explain',tr('球员说明','Player explanation')]]:[['draw',tr('重新画线','Redraw route')],['templates',tr('套用跑法 ›','Route template ›')],['remove-route',tr('删除路线','Delete route'),'class="danger"']];
    if(menu.kind==='card'){const r=records.find(r=>r.id===menu.id);return [['open-card',tr('继续编辑','Keep editing')],['teach-card',tr('演示保存版','Teach saved version'),r.saved?'':'disabled'],['copy-card',tr('复制一套','Make a copy')],['export-card',tr('导出备份','Export backup')],['delete-card',tr('删除','Delete'),'class="danger"']];}
    if(menu.kind==='blank')return play.type==='defense'&&!viewOnly?[['zones',tr('画覆盖区域 ›','Draw coverage zone ›')],['target',tr('加对方目标标记','Add opponent target')],['add-stop',tr('添加讲解停点','Add teaching stop')]]:[['add-stop',tr('添加讲解停点','Add teaching stop')]];
    if(menu.kind==='outcomes')return play.scenarios.map(s=>['outcome',titleOf(s)+(s.id===scenarioId?' ✓':''),`data-id="${esc(s.id)}"`]).concat(viewOnly?[]:[['new-outcome',tr('＋ 换一个接球人','＋ Another receiver')],['delete-outcome',tr('删除当前结局','Delete this outcome'),'class="danger"']]);
    if(['zone','target','duty','frame','event'].includes(menu.kind))return [['explain',tr('说明','Explanation')],...(!viewOnly?[['remove-object',tr('删除','Delete'),'class="danger"']]:[])];
    const list=screen==='library'?[['copy-builtin',tr('复制当前教学条目','Copy this lesson')],['export-all',tr('导出全库备份','Export library')],['import',tr('载入备份','Load backup')]]:[['details',tr('名称与说明','Name and explanation')],['sources',tr('查看出处','View sources')],['export-one',tr('导出这套战术','Export this tactic')],['reset',tr('回到站位','Reset lineup')],['speed',tr('播放速度','Playback speed')],['view',tr('球场视图 ›','Field view ›')],['snap',snap?tr('关闭 1 码吸附','Turn off 1 yd snap'):tr('开启 1 码吸附','Turn on 1 yd snap')]];
    if(screen==='board'&&['offense','run'].includes(play.type)&&play.scenarios.length>1)list.push(['outcomes',tr('切换球路结局','Choose outcome')]);
    if(screen==='board'&&!viewOnly&&['offense','run'].includes(play.type)){list.push(['routes-only',plan().mode==='ball'?(routesOnly?tr('显示球路','Show ball actions'):tr('仅跑位预览','Preview routes only')):tr('安排球路','Arrange ball actions')]);}
    if(screen==='board'&&!viewOnly)list.push(['save-copy',tr('另存一套','Save a copy')]);
    list.push(['language',getLanguage()==='zh'?'English':'中文']);if(screen==='board')list.push(['library',tr('我的战术库','My tactics')]);return list;
  }
  function sheetTitle(){return ({play:tr('名称与说明','Name and explanation'),player:tr('球员说明','Player explanation'),frame:tr('讲解停点','Teaching stop'),zone:tr('覆盖区域','Coverage zone'),target:tr('目标标记','Target marker'),duty:tr('防守职责','Defensive duty'),event:tr('球动作','Ball action'),sources:tr('出处','Sources'),issues:tr('需要调整','Needs adjustment'),'save-help':tr('保存状态','Save status'),speed:tr('播放速度','Playback speed')})[sheet.kind]||tr('说明','Explanation');}
  function fieldInput(key,label,value){return `<label>${esc(label)}<input type="text" data-edit="${key}" value="${esc(value||'')}" ${viewOnly?'readonly':''}></label>`;}
  function sheetHtml(){
    if(sheet.kind==='sources'){const refs=play.origin.references||[];return `<p>${esc(play.origin.kind==='self'?tr('自编战术','Coach-created tactic'):tr('基于原战术改编；跑位与节奏为教学设置。','Adapted from the source; routes and timing are teaching settings.'))}</p><ul>${refs.map(r=>safeURL(r.url)?`<li><a href="${esc(safeURL(r.url))}" target="_blank" rel="noopener noreferrer">${esc(r.title||r.publisher||r.url)}</a></li>`:'').join('')}</ul>`;}
    if(sheet.kind==='issues')return `<p>${esc(tr('点下面的问题找到场上对象。','Tap an issue to find the object on the field.'))}</p>${checks().errors.map(e=>button('find-issue',localMessage(e.message),`data-id="${esc(e.object)}" data-scenario="${esc(e.scenario||'')}" class="coach-issue"`)).join('')}`;
    if(sheet.kind==='save-help')return `<p>${esc(saveError||tr('草稿自动保留；保存更新供教学使用的版本。','Drafts are retained automatically; Save updates the teaching version.'))}</p>${store.temporary?`<p>${esc(tr('双击文件仅临时使用，关闭前须导出备份。','A double-clicked file is temporary; export a backup before closing.'))}</p>`:''}${saveError?button('details',tr('修改名称与说明','Edit name and explanation'))+button('retry',tr('重试','Retry'))+button('save-copy',tr('另存一套','Save a copy')):''}${button('export-one',tr('导出备份','Export backup'))}`;
    if(sheet.kind==='speed')return [0.5,1,2,3].map(n=>button('set-speed',n+'×'+(n===speed?' ✓':''),`data-speed="${n}"`)).join('');
    const item=object(sheet.kind,sheet.id)||play,lang=getLanguage();let html='';
    if(sheet.kind==='play')html+=fieldInput('title',tr('战术名称','Tactic name'),play.title[lang]);
    if(sheet.kind==='player'){let from=item.at,distance=0;for(const step of item.motion.steps||[]){distance+=stepLength(from,step);if(step.to)from=step.to;}html+=`<p class="coach-help">${distance.toFixed(1)} ${esc(tr('码跑动；距离与节奏为教学设置。','yd route; distances and timing are teaching settings.'))}</p>`;}
    if(sheet.kind==='player')html+=fieldInput('name',tr('显示代号','Player label'),item.name)+fieldInput('term',tr('跑法术语（可选）','Route term (optional)'),item.label.en);
    if(['zone','target','frame'].includes(sheet.kind))html+=fieldInput('name',tr('名称','Name'),sheet.kind==='frame'?item.title[lang]:item.label||item.name);
    if(sheet.kind==='duty'&&!viewOnly)html+=button('retarget',tr('重新指向区域或目标','Choose a new zone or target'));
    if(sheet.kind==='duty')html+=`<p>${esc(item.player+' · '+({coverage:tr('覆盖区域','Coverage'),matchup:tr('盯人','Matchup'),rush:tr('冲传','Rush')})[item.type])}</p>`;
    const text=item.explanation?.[lang]?.text||'';
    html+=`<label>${esc(tr('说明（可不填）','Explanation (optional)'))}<textarea data-edit="explanation" placeholder="${esc(tr('写一句给孩子的提示…','Write a tip for your child…'))}" ${viewOnly?'readonly':''}>${esc(text)}</textarea></label>`;
    if(!text&&item.explanation?.[lang==='zh'?'en':'zh']?.text)html+=`<p class="coach-help">${esc(tr('另一语言已有说明；本语言可后补。','An explanation exists in the other language; add this translation when ready.'))}</p>`;
    if(sheet.kind==='frame'){const f=compiled().keyframes.find(f=>f.id===sheet.id);html+=`<p class="coach-help">${Number.isFinite(f?.at)?f.at.toFixed(1)+' s · ':''}${esc(tr('全队停在这一刻；球员并非必须停跑。','The scene pauses here; this is not a running pause.'))}</p>`;if(play.type==='defense')html+=(viewOnly?'':button('reset-layers',tr('显示全部分工','Show all duties')))+`<details><summary>${esc(tr('这一停点显示的分工','Duties shown at this stop'))}</summary>${play.zones.map(z=>`<label><input type="checkbox" data-layer="zone" data-id="${esc(z.id)}" ${!item.view||item.view.zoneIds.includes(z.id)?'checked':''} ${viewOnly?'disabled':''}>${esc(z.label)}</label>`).join('')}${play.assignments.map(d=>`<label><input type="checkbox" data-layer="duty" data-id="${esc(d.id)}" ${!item.view||item.view.assignmentIds.includes(d.id)?'checked':''} ${viewOnly?'disabled':''}>${esc(d.player+' '+d.type)}</label>`).join('')}</details>`;}
    if(sheet.saveAfter)html+=button('save',tr('保存战术','Save tactic'),'class="primary"');
    if(!viewOnly&&['zone','target','duty','frame','event'].includes(sheet.kind))html+=button('remove-object',tr('删除','Delete'),'class="danger"');
    return html;
  }
  function renderBoard(){
    const svg=root.querySelector('.coach-canvas');if(!svg||!play)return;
    svg.setAttribute('viewBox',`${camera.x} ${camera.y} ${camera.w} ${camera.h}`);
    const c=compiled(),scene=getScene(c.lesson,time),scale=Math.max(1,Math.min(svg.clientWidth/camera.w,svg.clientHeight/camera.h));
    const hitR=Math.max(1.1,22/scale),dot=Math.max(.85,15/scale),font=Math.max(.9,12/scale),selected=selection?.id;
    const hit=(kind,id,extra='')=>`data-hit="${kind}" data-id="${esc(id)}" ${extra} role="button" tabindex="0"`;
    const frame=frameId?play.bookmarks.find(f=>f.id===frameId):undefined,layers=frame?.view;
    let html=`<defs>${play.players.map((p,i)=>`<marker id="coach-arrow-${i}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0L10 5L0 10Z" fill="${colorOf(p,i)}"/></marker>`).join('')}<marker id="coach-ball-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#f2c469"/></marker><marker id="coach-duty-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="3" markerHeight="3" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#e2dcaf"/></marker></defs><rect x="0" y="0" width="30" height="70" rx=".5" fill="#234d40" stroke="#d8e3d433" stroke-width=".1"/><rect width="30" height="10" fill="#c9d9b215"/><rect y="60" width="30" height="10" fill="#c9d9b215"/><text x="15" y="6" text-anchor="middle" font-size="${font}" fill="#d8e3d4">${esc(tr('进攻端区','Attacking end zone'))}</text><text x="15" y="66" text-anchor="middle" font-size="${font}" fill="#d8e3d4">${esc(tr('己方端区','Own end zone'))}</text>`;
    for(let y=10;y<=60;y++)html+=`<path d="M0 ${y}H30" stroke="#cfdfcc" stroke-width="${y%5===0?.065:.025}" opacity="${y%5===0?.3:.12}"/>${y%5===0?`<text x="30.55" y="${y+.35}" font-size="${font*.85}" fill="#d8dec5">${play.field.lineOfScrimmageY-y}</text>`:''}`;
    html+=`<path d="M0 ${play.field.lineOfScrimmageY}H30" stroke="#f1d68d" stroke-width=".16"/><text x=".25" y="${play.field.lineOfScrimmageY-.6}" font-size="${font*.8}" fill="#f1d68d">${esc(tr('开球线','LOS'))}</text><path d="M15 10V60" stroke="#cfdfcc" stroke-width=".08" stroke-dasharray=".4 .6" opacity=".3"/>`;
    const handle=(at,kind,id,key)=>`<g ${hit(kind,id,`data-key="${key}"`)} aria-label="${esc(tr('拖动边界点','Drag boundary point'))}"><circle cx="${at[0]}" cy="${at[1]}" r="${hitR}" fill="transparent"/><circle cx="${at[0]}" cy="${at[1]}" r=".32" fill="#f1d68d" pointer-events="none"/></g>`;
    for(const z of play.zones){if(layers&&!layers.zoneIds.includes(z.id))continue;const attrs=`${hit('zone',z.id)} fill="#c7e8a22a" stroke="${selected===z.id?'#f1d68d':'#c7e8a2'}" stroke-width=".15" aria-label="${esc(z.label)}"`;html+=z.type==='polygon'?`<polygon points="${z.points.map(p=>p.join(',')).join(' ')}" ${attrs}/>`:z.type==='rectangle'?`<rect x="${z.center[0]-z.radiusX}" y="${z.center[1]-z.radiusY}" width="${z.radiusX*2}" height="${z.radiusY*2}" ${attrs}/>`:`<ellipse cx="${z.center[0]}" cy="${z.center[1]}" rx="${z.radiusX}" ry="${z.radiusY}" ${attrs}/>`;const at=zoneCenter(z);html+=`<text x="${at[0]}" y="${at[1]}" text-anchor="middle" font-size="${font*.8}" fill="#e5edda" pointer-events="none">${esc(z.label)}</text>`;if(selected===z.id&&!viewOnly&&!playing)html+=z.points?z.points.map((p,i)=>handle(p,'zone',z.id,`point:${i}`)).join(''):handle([z.center[0]+z.radiusX,z.center[1]+z.radiusY],'zone',z.id,'corner');}
    for(const d of c.lesson.assignments){if(!d.guide||(layers&&!layers.assignmentIds.includes(d.id)))continue;const path=pathToSvg(d.guide.from,d.guide.steps);html+=`<path d="${esc(path)}" stroke="#e2dcaf" stroke-dasharray=".3 .4" stroke-width=".18" fill="none" marker-end="url(#coach-duty-arrow)"/><path d="${esc(path)}" stroke="transparent" stroke-width="${hitR*2}" fill="none" ${hit('duty',d.id)} aria-label="${esc(d.player+' '+d.type)}"/>`;if(selected===d.id&&!viewOnly&&d.end&&!d.target)html+=handle(d.end,'duty',d.id,'end');}
    for(const t of play.targets)html+=`<g ${hit('target',t.id)} aria-label="${esc(t.name)}"><circle cx="${t.at[0]}" cy="${t.at[1]}" r="${hitR}" fill="transparent"/><path d="M${t.at[0]-.5} ${t.at[1]}H${t.at[0]+.5}M${t.at[0]} ${t.at[1]-.5}V${t.at[1]+.5}" stroke="#f1d68d" stroke-width=".15"/><text x="${t.at[0]}" y="${t.at[1]+1.3}" font-size="${font*.8}" text-anchor="middle" fill="#f1d68d">${esc(t.name)}</text></g>`;
    play.players.forEach((p,i)=>{if(p.motion.steps?.length){const d=pathToSvg(p.at,p.motion.steps);html+=`<path d="${esc(d)}" fill="none" stroke="${colorOf(p,i)}" stroke-width=".23" opacity="${selected&&selected!==p.id?.5:.9}" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#coach-arrow-${i})"/><path d="${esc(d)}" fill="none" stroke="transparent" stroke-width="${hitR*2}" ${hit('route',p.id)} aria-label="${esc(p.id+' '+tr('跑动路线','running route'))}"/>`;}});
    if(stroke.length)html+=`<polyline points="${stroke.map(p=>p.join(',')).join(' ')}" fill="none" stroke="${mode?.type==='zone'?'#f1d68d':colorOf(object('player',mode?.player)||{},play.players.findIndex(p=>p.id===mode?.player))}" stroke-width=".25" stroke-linecap="round"/>`;
    const validBall=!routesOnly&&!checks(false).errors.some(e=>e.scenario===scenarioId&&e.step===3&&!play.bookmarks.some(f=>f.id===e.object));
    const ball=validBall&&c.lesson.ball?getBallState(c.lesson,time,{},c.scenario):undefined;
    if(ball){for(const f of ball.flights)html+=`<path d="M${f.start.join(' ')}L${f.end.join(' ')}" fill="none" stroke="#f2c469" stroke-width=".2" stroke-dasharray=".5 .45" marker-end="url(#coach-ball-arrow)"/><path d="M${f.start.join(' ')}L${f.end.join(' ')}" fill="none" stroke="transparent" stroke-width="${hitR*1.5}" ${hit('event',f.id)} aria-label="${esc(eventName(f.type))}"/>`;
      for(const e of c.scenario.events.filter(e=>['handoff','fake-handoff','pump-fake'].includes(e.type))){const at=positionAt(c.lesson.players.find(p=>p.id===e.from),e.at);html+=`<g ${hit('event',e.id)} aria-label="${esc(eventName(e.type))}"><circle cx="${at[0]}" cy="${at[1]}" r="${hitR}" fill="transparent"/><text x="${at[0]}" y="${at[1]-1.4}" text-anchor="middle" font-size="${font}" fill="#f2c469">${e.type==='handoff'?'○':'FAKE ×'}</text></g>`;}
      for(const carry of ball.carries){const p=c.lesson.players.find(p=>p.id===carry.owner),points=[];for(let i=0;i<=64;i++)points.push(positionAt(p,carry.at+(carry.endAt-carry.at)*i/64));html+=`<polyline points="${points.map(p=>p.join(',')).join(' ')}" fill="none" stroke="#f5f7ee" stroke-width=".1" opacity=".85"/>`;}}
    for(const e of plan()?.events.filter(e=>e.pending)||[]){const from=object('player',e.from),to=object('player',e.to);if(from&&to)html+=`<path d="M${from.at.join(' ')}L${to.at.join(' ')}" fill="none" stroke="#efa9a0" stroke-width=".23" stroke-dasharray=".3 .3" ${hit('event',e.id)} aria-label="${esc(tr('交递需要会合','Handoff needs a meeting'))}"/>`;}
    for(const [i,p]of scene.players.entries()){const at=positionAt(p,time),active=selected===p.id;let direction=p.facing?.direction;
      if(!direction){const early=positionAt(p,Math.max(0,time-.02)),late=positionAt(p,time+.02);direction=late.map((v,i)=>v-early[i]);if(Math.hypot(...direction)<1e-6){let t=p.motion.startAt||0,previous=p.at;direction=[0,-1];for(const a of p.motion.steps||[]){if(a.to){const near=positionAt(p,t+(time<=t?.01:Math.max(0,a.seconds-.01))),end=positionAt(p,t+(time<=t?.02:a.seconds));direction=end.map((v,i)=>v-near[i]);previous=a.to;}if(time<t+a.seconds)break;t+=a.seconds;}}}
      const angle=Math.atan2(direction[1],direction[0])*180/Math.PI;
      html+=`<g ${hit('player',p.id)} aria-label="${esc((p.name||p.id)+' '+(p.label.en||''))}"><title>${esc([p.label.en,p.label.zh,teachingText(p,getLanguage()).text].filter(Boolean).join(' · '))}</title><circle cx="${at[0]}" cy="${at[1]}" r="${hitR}" fill="transparent"/>${active?`<circle cx="${at[0]}" cy="${at[1]}" r="${dot+.25}" fill="none" stroke="#e9efdd" stroke-width=".12"/>`:''}<circle cx="${at[0]}" cy="${at[1]}" r="${dot}" fill="${colorOf(p,i)}"/>${p.motion.type==='path'?`<path d="M .65 -.25L1.2 0L.65 .25Z" transform="translate(${at[0]} ${at[1]}) rotate(${angle})" fill="${colorOf(p,i)}"/>`:''}<text x="${at[0]}" y="${at[1]+font*.34}" font-size="${font}" text-anchor="middle" font-weight="700" fill="#183d33">${esc((p.name||p.id).length>4?p.id:p.name||p.id)}</text></g>`;}
    let stopNumber=0;for(const f of c.keyframes){if(!f.valid||(f.at===0&&!f.marker))continue;let at=f.marker;
      if(!at&&f.binding.player){const p=c.lesson.players.find(p=>p.id===f.binding.player);if(p)at=positionAt(p,f.at);}
      else if(!at&&f.binding.event&&ball)at=getBallState(c.lesson,f.at,{},c.scenario)?.position;
      if(!at)continue;const number=++stopNumber,center=[at[0]+.9,at[1]-.9];html+=`<g ${hit('frame',f.id)} aria-label="${esc(tr('讲解停点 ','Teaching stop ')+number)}"><circle cx="${center[0]}" cy="${center[1]}" r="${hitR}" fill="transparent"/><circle cx="${center[0]}" cy="${center[1]}" r="${Math.max(.45,9/scale)}" fill="#f1d68d" stroke="#234d40" stroke-width=".1"/><text x="${center[0]}" y="${center[1]+font*.22}" font-size="${font*.7}" text-anchor="middle" fill="#183d33">${number}</text></g>`;}
    if(ball&&ball.position.every(Number.isFinite)){
      const gap=dot+.45;
      let offset=[gap,0];
      if(ball.state==='held'&&ball.owner==='C'&&!ball.event)offset=[0,-gap];
      else if(ball.state==='flight'&&ball.event.type==='snap'&&ball.event.from==='C')offset=[gap*ball.progress,-gap*(1-ball.progress)];
      html+=`<ellipse data-coach-ball cx="${ball.position[0]+offset[0]}" cy="${ball.position[1]+offset[1]}" rx="${Math.max(.4,7/scale)}" ry="${Math.max(.23,4/scale)}" fill="#b88052" stroke="#f8e4bf" stroke-width=".1"/>`;
    }
    svg.innerHTML=html;const n=root.querySelector('.coach-hint');if(n){n.textContent=hint();n.setAttribute('aria-live',playing?'off':'polite');}
  }
  function pointAt(e){const svg=root.querySelector('.coach-canvas');return [new DOMPoint(e.clientX,e.clientY).matrixTransform(svg.getScreenCTM().inverse()).x,new DOMPoint(e.clientX,e.clientY).matrixTransform(svg.getScreenCTM().inverse()).y];}
  function cancelGesture(){clearTimeout(longTimer);if(gesture?.baseline){play=gesture.baseline;cache=null;}gesture=null;pointers.clear();stroke=[];}
  function activateHit(hit,point,event){
    if(mode?.type==='ball'&&hit?.hit==='player'){
      const intent=mode;
      if(hit.id===intent.player){notify(tr('点另一名目标球员','Tap another target player'));return;}
      edit(()=>{const s=addBallAction(play,scenarioId,intent.kind,intent.player,hit.id);scenarioId=s.id;});
      routesOnly=false;selection={kind:'player',id:hit.id};mode=null;render();
      if(plan().events.some(e=>e.pending))notify(tr('交递双方还没会合：调整路线使他们碰面。','The handoff needs a meeting: adjust the routes.'));
      else notify(`${intent.player} → ${hit.id} · ${eventName(intent.kind)}`);
      return;
    }
    if(mode?.type==='duty'){const owner=mode.player,replaceId=mode.replaceId;if(mode.kind==='coverage'&&hit?.hit!=='zone'){notify(tr('点一片覆盖区域','Tap a coverage zone'));return;}edit(()=>{const type=hit?.hit==='zone'?'coverage':mode.kind||'matchup';if(replaceId)play.assignments=play.assignments.filter(d=>d.id!==replaceId);play.assignments.push({id:uid('duty'),player:owner,type,explanation:explanation(),...(type==='coverage'?{zone:hit.id}:hit?.hit==='target'?{target:hit.id}:{end:snapPoint(point,snap)})});});mode=null;render();return;}
    if(mode?.type==='target'){const at=snapPoint(point,snap);mode=null;ask(tr('对方目标','Opponent target'),`<label>${esc(tr('名称，例如对方 QB','Name, e.g. opponent QB'))}<input id="coachTargetName" value="${esc(tr('对方 QB','Opponent QB'))}"></label>`,()=>edit(()=>play.targets.push({id:uid('target'),name:dialog.querySelector('input').value||tr('对方 QB','Opponent QB'),at,explanation:explanation()})));return;}
    if(!hit){selection=null;menu=sheet=null;render();return;}
    if(hit.hit==='frame'){seekFrame(hit.id);return;}
    if(hit.hit==='route'&&!viewOnly){const player=object('player',hit.id),near=nearestRoutePoint(player,point);if(!near)return;const binding={type:'route',player:player.id,progress:near.fraction},existing=findNearbyStops(play,binding,scenarioId)[0];if(existing){seekFrame(existing.id);notify(tr('这里已有讲解停点','A teaching stop already exists here'));return;}let f;edit(()=>{f={id:uid('stop'),title:{zh:getLanguage()==='zh'?'讲解停点':'',en:getLanguage()==='en'?'Teaching stop':''},binding,explanation:explanation()};play.bookmarks.push(f);});seekFrame(f.id);return;}
    if(hit.hit==='route'&&viewOnly){const near=nearestRoutePoint(object('player',hit.id),point);if(near){stop();time=compiled().bindingTime({type:'route',player:hit.id,progress:near.fraction},hit.id);frameId=null;selection={kind:'player',id:hit.id};render();}return;}
    if(hit.hit==='event'){
      const c=compiled(),event=c.scenario.events.find(e=>e.id===hit.id);
      if(!Number.isFinite(event?.at)){selection={kind:'event',id:hit.id};setSheet('event',hit.id);return;}
      let progress=0;
      if(['snap','pass'].includes(event.type)){
        const flight=getBallState(c.lesson,0,{},c.scenario).flights.find(f=>f.id===hit.id);
        progress=nearestRoutePoint({at:flight.start,motion:{type:'path',steps:[{id:hit.id,type:'line',to:flight.end,seconds:1}]}},point).fraction;
      }
      if(viewOnly){stop();time=event.at+((event.endAt??event.at)-event.at)*progress;frameId=null;sheet={kind:'event',id:hit.id};render();return;}
      const binding={type:'ball',event:hit.id,phase:'progress',progress},existing=findNearbyStops(play,binding,scenarioId)[0];
      if(existing){seekFrame(existing.id);notify(tr('这里已有讲解停点','A teaching stop already exists here'));return;}
      let f;edit(()=>{f={id:uid('stop'),scenario:scenarioId,title:{zh:getLanguage()==='zh'?eventName(event.type)+'停点':'',en:getLanguage()==='en'?eventName(event.type)+' stop':''},binding,explanation:explanation()};play.bookmarks.push(f);});seekFrame(f.id);return;
    }
    select(hit.hit,hit.id);
  }
  function seekFrame(id){const f=compiled().keyframes.find(f=>f.id===id);if(!f?.valid){notify(tr('这个停点需要重新添加','Add this stop again'));return;}stop();time=f.at;frameId=id;selection={kind:'frame',id};menu=null;mode=null;sheet={kind:'frame',id};render();}
  root.addEventListener('contextmenu',e=>{const svg=e.target.closest('.coach-canvas'),card=e.target.closest('[data-card]');if(!svg&&!card)return;e.preventDefault();if(card){menu={kind:'card',id:card.dataset.card,x:e.clientX,y:e.clientY};renderOverlay();return;}const hit=e.target.closest('[data-hit]')?.dataset;menuAt(hit?.hit||'blank',hit?.id,e);});
  root.addEventListener('pointerdown',e=>{
    const card=e.target.closest('[data-card]');if(card&&!e.target.closest('button')){gesture={type:'card',id:card.dataset.card,start:[e.clientX,e.clientY],long:false};longTimer=setTimeout(()=>{if(gesture?.type==='card'){gesture.long=true;menu={kind:'card',id:card.dataset.card,x:e.clientX,y:e.clientY};renderOverlay();}},520);return;}
    const svg=e.target.closest('.coach-canvas');if(!svg||e.button===2)return;e.preventDefault();svg.setPointerCapture(e.pointerId);pointers.set(e.pointerId,[e.clientX,e.clientY]);
    if(pointers.size===2){clearTimeout(longTimer);if(gesture?.baseline)play=gesture.baseline;stroke=[];cache=null;const p=[...pointers.values()],center=p[0].map((v,i)=>(v+p[1][i])/2);gesture={type:'pinch',camera:{...camera},distance:Math.hypot(p[0][0]-p[1][0],p[0][1]-p[1][1]),center,anchor:pointAt({clientX:center[0],clientY:center[1]}),scale:Math.min(svg.clientWidth/camera.w,svg.clientHeight/camera.h)};renderBoard();return;}
    if(pointers.size>1)return;
    const hit=e.target.closest('[data-hit]')?.dataset,point=pointAt(e);
    if(mode?.type==='pan'){gesture={type:'pan',start:[e.clientX,e.clientY],camera:{...camera},scale:Math.min(svg.clientWidth/camera.w,svg.clientHeight/camera.h)};return;}
    if(mode?.type==='draw'||mode?.type==='zone'){gesture={type:mode.type,start:[e.clientX,e.clientY],point};stroke=mode.type==='draw'?[clone(object('player',mode.player).at)]:[snapPoint(point,snap)];return;}
    const selected=selection?.id===hit?.id;
    const draggable=!viewOnly&&!mode&&time===0&&selected&&hit&&(['player','zone','target'].includes(hit.hit)||(hit.hit==='duty'&&hit.key==='end'));
    gesture={type:'press',hit,point,start:[e.clientX,e.clientY],draggable,baseline:draggable?clone(play):null,moved:false,long:false};
    if(!mode)longTimer=setTimeout(()=>{if(gesture?.type==='press'&&!gesture.moved){gesture.long=true;menuAt(hit?.hit||'blank',hit?.id,e);}},520);
  });
  root.addEventListener('pointermove',e=>{
    if(gesture?.type==='card'){if(Math.hypot(e.clientX-gesture.start[0],e.clientY-gesture.start[1])>8){clearTimeout(longTimer);gesture.moved=true;}return;}
    if(!pointers.has(e.pointerId)||!gesture)return;pointers.set(e.pointerId,[e.clientX,e.clientY]);
    if(gesture.type==='pinch'){if(pointers.size<2)return;const p=[...pointers.values()],distance=Math.hypot(p[0][0]-p[1][0],p[0][1]-p[1][1]),center=p[0].map((v,i)=>(v+p[1][i])/2),zoom=Math.max(.4,Math.min(3,gesture.distance/Math.max(1,distance)));camera={w:Math.max(12,Math.min(70,gesture.camera.w*zoom)),h:Math.max(16,Math.min(150,gesture.camera.h*zoom)),x:0,y:0};const realZoom=camera.w/gesture.camera.w;camera.x=gesture.anchor[0]-(gesture.anchor[0]-gesture.camera.x)*realZoom-(center[0]-gesture.center[0])/gesture.scale*realZoom;camera.y=gesture.anchor[1]-(gesture.anchor[1]-gesture.camera.y)*realZoom-(center[1]-gesture.center[1])/gesture.scale*realZoom;renderBoard();return;}
    if(gesture.type==='pinch-end'||gesture.long)return;
    const distance=Math.hypot(e.clientX-gesture.start[0],e.clientY-gesture.start[1]);if(distance>8){clearTimeout(longTimer);gesture.moved=true;}
    if(gesture.type==='pan'){camera={...gesture.camera,x:gesture.camera.x-(e.clientX-gesture.start[0])/gesture.scale,y:gesture.camera.y-(e.clientY-gesture.start[1])/gesture.scale};renderBoard();return;}
    const point=boundPoint(pointAt(e));
    if(gesture.type==='draw'||gesture.type==='zone'){if(!stroke.length||Math.hypot(point[0]-stroke.at(-1)[0],point[1]-stroke.at(-1)[1])>.12){if(stroke.length<4000)stroke.push(point);renderBoard();}return;}
    if(gesture.draggable&&gesture.moved){play=clone(gesture.baseline);const hit=gesture.hit,base=object(hit.hit,hit.id);let origin=hit.hit==='player'||hit.hit==='target'?base.at:hit.hit==='zone'?zoneCenter(base):base.end;const to=hit.key?snapPoint(point,snap):snapPoint(origin.map((v,i)=>v+point[i]-gesture.point[i]),snap);moveObject(play,hit.hit,hit.id,to,hit.key);cache=null;renderBoard();}
  });
  function endPointer(e,cancel=false){
    clearTimeout(longTimer);pointers.delete(e.pointerId);if(!gesture)return;
    if(gesture.type==='card'){if(cancel)gesture=null;return;}
    if(['pinch','pinch-end'].includes(gesture.type)){gesture=pointers.size?{type:'pinch-end'}:null;return;}
    const g=gesture;gesture=null;
    if(cancel){if(g.baseline)play=g.baseline;stroke=[];cache=null;renderBoard();return;}
    if(g.long)return;
    if(g.type==='pan'){if(!g.moved)mode=null;render();return;}
    if(g.type==='draw'){const points=stroke.slice(1);stroke=[];const id=mode.player;mode=null;const baseline=clone(play);const oldStops=play.bookmarks.filter(f=>f.binding.player===id).length;const player=object('player',id);if(drawRoute(play,player,points,snap)){undo.push(baseline);redo=[];changed();}render();if(oldStops)notify(tr('路线已替换；相关旧停点已移除，可撤销。','Route replaced; old route stops removed. Undo is available.'));return;}
    if(g.type==='zone'){const points=stroke;stroke=[];const shape=mode.shape;mode=null;if(points.length>1){edit(()=>{const first=snapPoint(points[0],snap),last=snapPoint(points.at(-1),snap),z={id:uid('zone'),type:shape,label:tr('覆盖区域','Coverage zone'),explanation:explanation()};if(shape==='polygon'){z.points=simplifyStroke(points,.4).map(p=>snapPoint(p,snap));if(z.points.length<3)return;}else{z.center=first.map((v,i)=>(v+last[i])/2);z.radiusX=Math.max(.5,Math.abs(last[0]-first[0])/2);z.radiusY=Math.max(.5,Math.abs(last[1]-first[1])/2);}play.zones.push(z);selection={kind:'zone',id:z.id};});}else render();return;}
    if(g.draggable&&g.moved){undo.push(g.baseline);redo=[];changed();render();return;}
    if(g.moved)return;
    activateHit(g.hit,g.point,e);
  }
  root.addEventListener('pointerup',e=>endPointer(e));root.addEventListener('pointercancel',e=>endPointer(e,true));
  async function handle(action,node,e){
    const id=menu?.id||sheet?.id||selection?.id,kind=menu?.kind||sheet?.kind||selection?.kind;
    const anchor={x:e.clientX||innerWidth-265,y:e.clientY||78};
    if(action==='dismiss'){menu=sheet=mode=null;cancelGesture();render();return;}
    if(action==='more'){menu={kind:'more',...anchor};sheet=null;renderOverlay();return;}
    if(action==='new'){menu={kind:'new',...anchor};renderOverlay();return;}
    if(action==='create'){await leave(()=>create(node.dataset.type));return;}
    if(action==='library'){await leave(()=>{screen='library';play=undefined;record=undefined;menu=sheet=mode=null;viewOnly=false;render();});return;}
    if(action==='close'){await leave(()=>{root.hidden=true;document.body.style.overflow='';document.body.classList.remove('coach-open');for(const n of document.querySelectorAll('.app-header,.layout,#floatingPlay'))n.inert=false;previousFocus?.focus();});return;}
    if(action==='copy-builtin'){await leave(()=>create(getCurrentLesson().kind,getCurrentLesson()));return;}
    if(action==='open-card'||action==='teach-card'){const value=records.find(r=>r.id===id);menu=null;await leave(()=>openRecord(value,action==='teach-card'));return;}
    if(action==='edit-saved'){openRecord(records.find(r=>r.id===record.id));return;}
    if(action==='card-more'){menu={kind:'card',id:node.dataset.id,...anchor};sheet=null;renderOverlay();return;}
    if(action==='copy-card'){const value=copyRecord(records.find(r=>r.id===id),records);records=await store.change([{id:value.id,expected:0,record:value}]);menu=null;render();return;}
    if(action==='delete-card'){const value=records.find(r=>r.id===id);records=await store.change([{id,expected:value.revision,remove:true}]);undoDeletion=clone(value);clearTimeout(undoTimer);undoTimer=setTimeout(()=>{undoDeletion=null;root.querySelector('.coach-delete-undo')?.remove();},10000);menu=null;render();return;}
    if(action==='restore-deleted'){const value=undoDeletion;if(value){records=await store.change([{id:value.id,expected:0,record:value}]);undoDeletion=null;clearTimeout(undoTimer);render();}return;}
    if(action==='save'||action==='save-copy'){if(await save(action==='save-copy')){sheet=null;render();}return;}
    if(action==='save-help'){setSheet('save-help');return;}
    if(action==='details'){setSheet('play');return;}
    if(action==='sources'){setSheet('sources');return;}
    if(action==='issues'){setSheet('issues');return;}
    if(action==='retry'){if(!store.temporary&&!store.db)await store.open();await retain();sheet=null;render();return;}
    if(action==='retry-store'){await store.open();records=await store.list();saveError='';render();return;}
    if(action==='temporary'){store.temporary=true;saveError='';records=await store.list();render();return;}
    if(action==='import'){menu=null;renderOverlay();root.querySelector('#coachBackupInput').click();return;}
    if(action==='export-all'){exportBackup();menu=null;renderOverlay();return;}
    if(action==='export-one'){exportBackup(true);return;}
    if(action==='export-card'){const previous=record;record=records.find(r=>r.id===id);exportBackup(true);record=previous;menu=null;renderOverlay();return;}
    if(action==='templates'||action==='fake-menu'||action==='zones'||action==='duty'||action==='view'){menu.page=({templates:'templates','fake-menu':'fake',zones:'zones',duty:'duties',view:'view'})[action];renderOverlay();return;}
    if(action==='draw'){mode={type:'draw',player:id};selection={kind:'player',id};menu=sheet=null;time=0;frameId=null;render();return;}
    if(action==='template'){const term=node.dataset.term,reference=routeLessons.find(l=>l.id==='route-'+term.toLowerCase().replaceAll(' ','-'));edit(()=>applyRouteTemplate(play,object('player',id),term,reference));menu=null;render();return;}
    if(action==='remove-route'){edit(()=>{const p=object('player',id);p.motion={type:'unspecified',note:tr('未绘制路线','No route drawn')};p.label.en=p.label.zh='';play.bookmarks=play.bookmarks.filter(f=>f.binding.player!==id);});menu=null;render();return;}
    if(action==='ball'){mode={type:'ball',kind:node.dataset.type,player:id};menu=sheet=null;time=0;frameId=null;render();return;}
    if(action==='new-outcome'){mode={type:'ball',kind:'pass',player:play.players.find(p=>['QB','Q'].includes(p.id))?.id};menu=sheet=null;time=0;render();return;}
    if(action==='outcomes'){menu={kind:'outcomes',...anchor};sheet=null;renderOverlay();return;}
    if(action==='outcome'){scenarioId=node.dataset.id;stop();time=0;frameId=null;menu=null;cache=null;render();return;}
    if(action==='delete-outcome'){if(play.scenarios.length===1){notify(tr('至少保留一个结局','Keep at least one outcome'));return;}edit(()=>{play.scenarios=play.scenarios.filter(s=>s.id!==scenarioId);play.bookmarks=play.bookmarks.filter(f=>f.scenario!==scenarioId);scenarioId=play.scenarios[0].id;play.defaultScenario=scenarioId;});menu=null;render();return;}
    if(action==='zone'){mode={type:'zone',shape:node.dataset.type};menu=null;render();return;}
    if(action==='target'){mode={type:'target'};menu=null;render();return;}
    if(action==='assign-duty'){mode={type:'duty',player:id,kind:node.dataset.type};menu=null;render();return;}
    if(action==='retarget'){const d=object('duty',id);mode={type:'duty',player:d.player,kind:d.type,replaceId:d.id};menu=sheet=null;render();return;}
    if(action==='reset-layers'){edit(()=>delete object('frame',id).view);render();return;}
    if(action==='add-stop'){const marker=menu?.point||[15,35];let frame;edit(()=>{frame={id:uid('stop'),title:{zh:getLanguage()==='zh'?'讲解停点':'',en:getLanguage()==='en'?'Teaching stop':''},binding:{type:'time',seconds:time},marker,explanation:explanation()};play.bookmarks.push(frame);});menu=null;seekFrame(frame.id);return;}
    if(action==='explain'){setSheet(kind==='route'?'player':kind,id);return;}
    if(action==='remove-object'){
      const removedFrame=kind==='frame'?object('frame',id):undefined;
      edit(()=>{const key=({frame:'bookmarks',zone:'zones',target:'targets',duty:'assignments'})[kind];if(key)play[key]=play[key].filter(o=>o.id!==id);else if(kind==='event'){plan().events=plan().events.filter(o=>o.id!==id);play.bookmarks=play.bookmarks.filter(f=>f.binding.event!==id);}},{renderNow:false});
      if(frameId&&!play.bookmarks.some(f=>f.id===frameId))frameId=null;
      selection=menu=sheet=mode=null;render();
      if(removedFrame){const count=findNearbyStops(play,removedFrame.binding,removedFrame.scenario||scenarioId).length;notify(count?tr(`当前停点已删除；附近还有 ${count} 个停点，可撤销。`,`Stop deleted; ${count} other ${count===1?'stop is':'stops are'} nearby. Undo is available.`):tr('讲解停点已删除，可撤销。','Teaching stop deleted. Undo is available.'));}
      return;
    }
    if(action==='find-issue'){if(node.dataset.scenario)scenarioId=node.dataset.scenario;const objectId=node.dataset.id;const k=['player','zone','target','duty','frame','event'].find(k=>object(k,objectId));if(k){selection={kind:k,id:objectId};if(k==='frame'){const f=compiled().keyframes.find(f=>f.id===objectId);if(f?.valid){time=f.at;frameId=objectId;}}sheet={kind:k,id:objectId};}else sheet={kind:'play'};render();return;}
    if(action==='undo'||action==='redo'){stop();const list=action==='undo'?undo:redo,other=action==='undo'?redo:undo;if(list.length){other.push(clone(play));play=list.pop();if(!play.scenarios.some(s=>s.id===scenarioId))scenarioId=play.defaultScenario;changed();time=0;frameId=null;menu=sheet=mode=null;render();}return;}
    if(action==='zoom-in'||action==='zoom-out'){const ratio=action==='zoom-in'?.8:1.25;camera={x:camera.x+camera.w*(1-ratio)/2,y:camera.y+camera.h*(1-ratio)/2,w:camera.w*ratio,h:camera.h*ratio};menu=null;renderOverlay();renderBoard();return;}
    if(action==='pan'){mode={type:'pan'};menu=null;render();return;}
    if(action==='fit'){camera=camera.h<60?{x:-2,y:-3,w:34,h:76}:nearCamera();renderBoard();return;}
    if(action==='snap'){snap=!snap;menu=null;renderOverlay();notify(snap?tr('按 1 码吸附','Snapping to 1 yd'):tr('精细绘图：已关闭吸附','Fine drawing: snap is off'));return;}
    if(action==='reset'){stop();time=0;frameId=null;selection=menu=sheet=mode=null;render();return;}
    if(action==='speed'){setSheet('speed');return;}
    if(action==='set-speed'){speed=Number(node.dataset.speed);sheet=null;render();return;}
    if(action==='language'){const lang=document.getElementById('language');lang.value=getLanguage()==='zh'?'en':'zh';lang.dispatchEvent(new Event('change'));menu=sheet=null;render();return;}
    if(action==='routes-only'){routesOnly=plan().mode==='ball'?!routesOnly:false;if(plan().mode!=='ball'){mode={type:'ball',kind:'pass',player:play.players.find(p=>['QB','Q'].includes(p.id))?.id};}menu=null;render();notify(routesOnly?tr('仅预览跑位，原球路保留。','Previewing routes only; ball actions remain saved.'):tr('按当前球路演示','Previewing this ball outcome'));return;}
    if(action==='play'){if(playing){stop();render();return;}const errors=checks(false).errors.filter(e=>!e.scenario||e.scenario===scenarioId);if(errors.some(e=>e.step===1||e.step===2)){sheet={kind:'issues'};render();return;}if(errors.some(e=>e.step===3&&!play.bookmarks.some(f=>f.id===e.object))){routesOnly=true;notify(tr('球路需调整；先预览跑位。','Ball actions need adjustment; previewing routes.'));}if(time>=compiled().lesson.timeline.duration)time=0;frameId=null;menu=sheet=mode=null;playing=true;playbackFinished=false;lastTick=undefined;render();animation=requestAnimationFrame(tick);return;}
  }
  let routesOnly=false;
  root.addEventListener('click',e=>{const node=e.target.closest('[data-do]');if(node){handle(node.dataset.do,node,e).catch(error=>{saveError=error.message;updateStatus();notify(error.message);});return;}const card=e.target.closest('[data-card]');if(card){const held=gesture?.type==='card'&&gesture.long;const moved=gesture?.type==='card'&&gesture.moved;gesture=null;if(!held&&!moved)openRecord(records.find(r=>r.id===card.dataset.card));}});
  root.addEventListener('input',e=>{
    const key=e.target.dataset.edit;if(!key||viewOnly||!sheet)return;
    const item=object(sheet.kind,sheet.id)||play,value=e.target.value;
    if(e.target.dataset.baseline!==String(generation)){checkpoint();e.target.dataset.baseline=String(generation+1);}
    if(key==='title'){play.title[getLanguage()]=value;root.querySelector('.coach-name').textContent=titleOf(play);}
    if(key==='name'){if(sheet.kind==='frame')item.title[getLanguage()]=value;else if(sheet.kind==='zone')item.label=value;else item.name=value;}
    if(key==='term'){item.label.en=value;item.label.zh=ROUTES[value]||'';item.label.basis='author';}
    if(key==='explanation'){item.explanation??=explanation();const other=getLanguage()==='zh'?'en':'zh';if(item.explanation[getLanguage()].text!==value&&item.explanation[other].text)item.explanation[other].status='review';item.explanation[getLanguage()]={text:value,status:'confirmed'};}
    changed();e.target.dataset.baseline=String(generation);renderBoard();
  });
  root.addEventListener('change',e=>{if(!e.target.dataset.layer||viewOnly)return;const frame=object('frame',sheet.id);edit(()=>{frame.view??={zoneIds:play.zones.map(z=>z.id),assignmentIds:play.assignments.map(d=>d.id)};const key=e.target.dataset.layer==='zone'?'zoneIds':'assignmentIds';frame.view[key]=frame.view[key].filter(id=>(key==='zoneIds'?play.zones:play.assignments).some(o=>o.id===id));const id=e.target.dataset.id;frame.view[key]=e.target.checked?[...new Set([...frame.view[key],id])]:frame.view[key].filter(v=>v!==id);});});
  root.addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();menu=sheet=mode=null;cancelGesture();stop();render();return;}
    if(e.target.matches('input,textarea,select'))return;
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&!viewOnly){e.preventDefault();handle(e.shiftKey?'redo':'undo',e.target,e);return;}
    const hit=e.target.closest('[data-hit]')?.dataset,card=e.target.closest('[data-card]');
    if(e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10')){if(hit||card){e.preventDefault();const r=e.target.getBoundingClientRect();if(card){menu={kind:'card',id:card.dataset.card,x:r.left,y:r.bottom};renderOverlay();}else menuAt(hit.hit,hit.id,{clientX:r.left,clientY:r.bottom});}return;}
    if((e.key==='Enter'||e.key===' ')&&(hit||card)){e.preventDefault();if(card)openRecord(records.find(r=>r.id===card.dataset.card));else{const r=e.target.getBoundingClientRect();activateHit(hit,pointAt({clientX:r.x+r.width/2,clientY:r.y+r.height/2}),e);}return;}
    if(menu&&['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const nodes=[...root.querySelectorAll('.coach-context button:not(:disabled)')],index=nodes.indexOf(document.activeElement);nodes[(index+(e.key==='ArrowDown'?1:nodes.length-1))%nodes.length]?.focus();}
    if(e.key==='Tab'){const nodes=[...root.querySelectorAll('button:not(:disabled),input,select,textarea,a[href],[tabindex="0"]')].filter(n=>n.getClientRects().length&&!n.closest('[hidden]'));const edge=nodes[e.shiftKey?0:nodes.length-1];if(e.target===edge){e.preventDefault();nodes[e.shiftKey?nodes.length-1:0]?.focus();}}
  });
  async function importFile(file){if(!file)return;if(file.size>25*1024*1024)throw new Error(tr('备份不能超过 25 MB','Backup cannot exceed 25 MB'));const imported=parseBackup(await file.text());await leave(()=>{screen='library';play=undefined;record=undefined;viewOnly=false;menu=sheet=null;});const rows=imported.map(value=>({value,local:records.find(r=>r.id===value.id)}));
    ask(tr('载入战术备份','Load tactic backup'),rows.map((row,i)=>`<div class="coach-import-row"><strong>${esc(titleOf(row.value.draft))}</strong>${row.local&&equivalent(row.value,row.local)?`<p>${esc(tr('内容相同，将跳过','Identical; skip'))}</p>`:`<select data-import="${i}">${(row.local?[['copy',tr('复制并改名','Copy and rename')],['replace',tr('替换本机内容','Replace local content')],['skip',tr('跳过','Skip')]]:[['add',tr('新增','Add')],['copy',tr('复制并改名','Copy and rename')],['skip',tr('跳过','Skip')]]).map(([v,t])=>`<option value="${v}">${esc(t)}</option>`).join('')}</select>`}</div>`).join('')+`<p>${esc(tr('替换会直接覆盖该战术的草稿和保存版。','Replace overwrites this tactic’s draft and saved version.'))}</p>`,async()=>{const changes=[],future=[...records];for(const [i,row]of rows.entries()){const choice=dialog.querySelector(`[data-import="${i}"]`);if(!choice||choice.value==='skip')continue;let value=clone(row.value);if(choice.value==='copy')value=copyRecord(value,future);changes.push({id:value.id,expected:choice.value==='replace'?row.local.revision:0,record:value,enforceNames:true});future.push(value);}records=await store.change(changes);render();notify(tr('备份已载入','Backup loaded'));});render();
  }
  function renderUndo(){root.querySelector('.coach-delete-undo')?.remove();if(!undoDeletion)return;const n=document.createElement('div');n.className='coach-delete-undo';n.setAttribute('role','status');n.innerHTML=`${esc(tr('战术已删除','Tactic deleted'))}${button('restore-deleted',tr('撤销 · 10 秒','Undo · 10 s'))}`;root.append(n);}
  function tick(now){animation=undefined;if(root.hidden||!playing)return;if(lastTick!==undefined)time=Math.min(compiled().lesson.timeline.duration,time+Math.min(.1,(now-lastTick)/1000)*speed);lastTick=now;if(time>=compiled().lesson.timeline.duration){stop(true);render();return;}renderBoard();animation=requestAnimationFrame(tick);}
  window.addEventListener('resize',()=>{if(!root.hidden){if(screen==='board')renderBoard();if(menu)renderOverlay();}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){stop();if(play&&!viewOnly)retain().catch(()=>{});}});
  window.addEventListener('beforeunload',e=>{if((store.temporary&&records.length>0)||(!root.hidden&&play&&!viewOnly&&(saveError||generation>retained))){e.preventDefault();e.returnValue='';}});
  window.visualViewport?.addEventListener('resize',()=>{root.style.setProperty('--coach-keyboard',`${Math.max(0,innerHeight-visualViewport.height-visualViewport.offsetTop)}px`);root.querySelector('.coach-sheet :focus')?.scrollIntoView({block:'nearest'});});
  if(typeof BroadcastChannel!=='undefined'){channel=new BroadcastChannel('flagventures-coach-v3');channel.onmessage=()=>{if(screen==='library'&&!loading)store.list().then(all=>{records=all;render();}).catch(e=>{saveError=e.message;updateStatus();});};const change=store.change.bind(store);store.change=async changes=>{const all=await change(changes);channel.postMessage('updated');return all;};}
  async function show(){previousFocus=document.activeElement;pauseTeaching();root.hidden=false;document.body.style.overflow='hidden';document.body.classList.add('coach-open');for(const n of document.querySelectorAll('.app-header,.layout,#floatingPlay'))n.inert=true;await ready;render();root.querySelector('button')?.focus({preventScroll:true});}
  return{async open(){await show();},async copy(){await show();await leave(()=>create(getCurrentLesson().kind,getCurrentLesson()));}};
}
