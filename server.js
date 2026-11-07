'use strict';
// Сервер «Пыльный рубеж онлайн»: раздаёт игру и ведёт матчи по WebSocket.
const http=require('http'), fs=require('fs'), path=require('path');
const {WebSocketServer}=require('ws');
const GD=require('./shared/game-data.js');
const {C,MAPS,WEAPONS,GEAR,NADE_MAX,NADE_FUSE}=GD;
const MAPDATA={}; for(const id in MAPS) MAPDATA[id]=GD.buildMap(id);
const PORT=Number(process.env.PORT)||3000;
const PUBLIC=path.join(__dirname,'public');
const MIME={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.ico':'image/x-icon','.svg':'image/svg+xml'};

/* ---------- раздача файлов игры ---------- */
const server=http.createServer((req,res)=>{
  let url; try{ url=decodeURIComponent((req.url||'/').split('?')[0]); }catch(e){ res.writeHead(400); return res.end(); }
  if(url==='/rooms'){ const list=[...rooms.values()].map(r=>({code:r.code,mode:r.mode,map:r.map,players:[...r.players.values()].length,max:r.max}));
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-cache'}); return res.end(JSON.stringify(list)); }
  if(url==='/healthz'){ res.writeHead(200,{'Content-Type':'text/plain'}); return res.end('ok'); }
  let file;
  if(url==='/shared/game-data.js') file=path.join(__dirname,'shared','game-data.js');
  else { file=path.join(PUBLIC,url==='/'?'index.html':url); if(!file.startsWith(PUBLIC+path.sep)){ res.writeHead(403); return res.end(); } }
  fs.readFile(file,(err,data)=>{
    if(err){ res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); return res.end('Не найдено'); }
    res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'}); res.end(data); });
});

/* ---------- помощники ---------- */
const clamp=GD.clamp, rand=(a,b)=>a+Math.random()*(b-a);
const num=v=>(typeof v==='number'&&Number.isFinite(v))?v:NaN;
const vec=(a)=>Array.isArray(a)&&a.length===3&&a.every(x=>Number.isFinite(x))?a:null;
const r2=v=>Math.round(v*100)/100, r3=v=>Math.round(v*1000)/1000;
const shuffle=a=>{ a=a.slice(); for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; };
const cleanName=s=>(String(s||'').replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,16))||('Игрок'+((Math.random()*900+100)|0));
const cleanCode=s=>(String(s||'').toLowerCase().replace(/[^a-z0-9а-яё_-]/gi,'').slice(0,16))||'main';
const OFFS=[[0,0],[-2.5,0],[2.5,0],[-5,0],[5,0],[0,2.5],[-2.5,2.5],[2.5,2.5],[-5,2.5],[5,2.5]];
const freshInv=()=>({primary:null,secondary:1,armor:0,kit:false,nades:{he:0,smoke:0,flash:0,holo:0},drone:0,trap:0});

/* ---------- комнаты ---------- */
let nextId=1;
const rooms=new Map();
class Room{
  constructor(code,mode,map){
    this.code=code; this.mode=mode; this.max=mode==='ffa'?C.MAX_FFA:C.MAX_BOMB;
    this.traps=[]; this.vote=null; this.setMap(map);
    this.players=new Map(); this.nades=[]; this.rockets=[]; this.nid=1;
    this.phase=mode==='ffa'?'live':'wait'; this.timer=mode==='ffa'?C.FFA_TIME:0; this.startT=3; this.buyUntil=0;
    this.round=0; this.score={CT:0,T:0}; this.lossStreak={CT:0,T:0}; this.matchOver=false; this.snapAcc=0;
    this.bomb={s:'none',x:0,z:0,timer:0,site:null,carrier:null};
    this.drop={s:'none',x:0,z:0,h:0,t:0}; this.hostages=[]; this.dropAt=mode==='ffa'?Date.now()+45000:0; this.holos=[]; this.drones=[];
  }
  setMap(map){ this.map=map; this.boxesAll=MAPDATA[map].boxes; this.broken=new Set(); this.crateHP=new Map(); this.rebuildGeom();
    const W=GD.WEATHERS; this.weather=map==='city'?['night','night','fog','rain'][(Math.random()*4)|0]:W[(Math.random()*W.length)|0]; }
  rebuildGeom(){ const live=this.boxesAll.filter((b,i)=>!this.broken.has(i)); this.solids=GD.buildSolids(live); this.boxes=GD.buildBoxes(live); }
  resetCrates(){ if(!this.broken.size&&!this.crateHP.size) return; this.broken.clear(); this.crateHP.clear(); this.rebuildGeom(); this.broadcast({t:'crates',broken:[]}); }
  hitCrate(i,dmg){ const b=this.boxesAll[i]; if(!b||b[5]!=='crate'||this.broken.has(i)) return;
    const hp=(this.crateHP.has(i)?this.crateHP.get(i):C.CRATE_HP)-dmg; if(hp>0){ this.crateHP.set(i,hp); return; }
    const ids=[i]; this.boxesAll.forEach((o,j)=>{ if(j!==i&&o[5]==='crate'&&!this.broken.has(j)&&Math.abs(o[0]-b[0])<0.01&&Math.abs(o[1]-b[1])<0.01&&o[6]>b[6]) ids.push(j); });
    for(const j of ids) this.broken.add(j); this.rebuildGeom(); this.broadcast({t:'crate',ids}); }
  send(p,o){ if(p.ws.readyState===1) p.ws.send(JSON.stringify(o)); }
  broadcast(o,except){ const s=JSON.stringify(o); for(const p of this.players.values()) if(p!==except&&p.ws.readyState===1) p.ws.send(s); }
  teamCount(){ const n={CT:0,T:0}; for(const p of this.players.values()) n[p.team]++; return n; }
  aliveCount(team){ let n=0; for(const p of this.players.values()) if(p.alive&&p.team===team) n++; return n; }
  pickTeam(pref){ const n=this.teamCount(), other=t=>t==='CT'?'T':'CT';
    if((pref==='CT'||pref==='T')&&n[pref]<C.MAX_TEAM&&n[pref]<=n[other(pref)]) return pref;
    return n.CT<=n.T?'CT':'T'; }
  sendInv(p){ this.send(p,{t:'inv',money:this.eco()?p.money:0,primary:p.inv.primary,secondary:p.inv.secondary,armor:Math.round(p.inv.armor),kit:p.inv.kit,nades:p.inv.nades,drone:p.inv.drone||0,trap:p.inv.trap||0,free:!this.eco()}); }
  eco(){ return this.mode==='bomb'||this.mode==='hostage'; }
  canBuy(p){ return p.alive&&(this.mode==='ffa'||(this.phase==='freeze'||this.phase==='wait'||(this.phase==='live'&&Date.now()<this.buyUntil))); }

  add(ws,name,pref){
    const id=nextId++;
    const team=this.mode==='ffa'?(Math.random()<.5?'CT':'T'):this.pickTeam(pref);
    const p={id,ws,name,team,x:0,y:0,z:0,yaw:0,pitch:0,w:1,sp:0,hp:100,alive:false,kills:0,deaths:0,money:C.START_MONEY,inv:freshInv(),
      using:false,useP:0,dropP:0,lastChat:0,lastRadio:0,lastDash:0,dashUntil:0,lastShot:0,lastKnife:0,respawnT:0,lastSt:Date.now(),survived:false};
    this.players.set(id,p);
    this.send(p,{t:'welcome',id,room:this.code,mode:this.mode,map:this.map,team,weather:this.weather,broken:[...this.broken]});
    this.broadcast({t:'msg',text:name+' заходит в игру'},p);
    if(this.mode==='ffa'||this.phase==='wait') this.spawn(p,this.teamIndex(p));
    else this.send(p,{t:'round',title:'Раунд уже идёт',sub:'Ты появишься в следующем раунде'});
    this.sendInv(p);
    return p;
  }
  remove(p){
    if(this.bomb.s==='carried'&&this.bomb.carrier===p.id) this.dropBomb(p);
    this.players.delete(p.id);
    this.broadcast({t:'msg',text:p.name+' выходит из игры'});
    if(!this.players.size) rooms.delete(this.code);
  }
  teamIndex(p){ let i=0; for(const o of this.players.values()){ if(o===p) return i; if(o.team===p.team) i++; } return i; }
  spawnPoint(p,idx){
    const M=MAPS[this.map];
    if(this.mode==='ffa'){ let best=null,bd=-1;
      for(const s of shuffle(M.ffa).slice(0,8)){ let md=1e9;
        for(const o of this.players.values()) if(o!==p&&o.alive) md=Math.min(md,Math.hypot(o.x-s[0],o.z-s[1]));
        if(md>bd){ bd=md; best=s; } }
      return {x:best[0]+rand(-0.8,0.8),z:best[1]+rand(-0.8,0.8)}; }
    const c=M.spawn[p.team], o=OFFS[idx%OFFS.length], dir=c.z>0?1:-1;
    return {x:c.x+o[0],z:c.z+o[1]*dir};
  }
  spawn(p,idx,at){
    const q=at?{x:at.x,z:at.z}:this.spawnPoint(p,idx||0); GD.collide(q,0.4,this.solids); GD.clampMap(q);
    Object.assign(p,{x:q.x,y:0,z:q.z,hp:100,alive:true,useP:0,using:false,respawnT:0,lastSt:Date.now()});
    p.yaw=Math.atan2(q.x,q.z);
    this.send(p,{t:'spawn',x:r2(q.x),z:r2(q.z),yaw:r3(p.yaw)}); this.sendInv(p);
  }

  /* --- урон и убийства --- */
  damage(v,dmg,att,head,how,from,wIdx){
    if(!v.alive) return;
    if(v.inv.armor>0&&how!=='бомба'){ const ab=dmg*0.5; v.inv.armor=Math.max(0,v.inv.armor-ab); dmg-=ab; }
    v.hp-=dmg;
    this.send(v,{t:'hurt',dmg:Math.round(dmg),fx:r2(from.x),fz:r2(from.z),armor:Math.round(v.inv.armor)});
    if(att&&att!==v) this.send(att,{t:'hitok',head:!!head,kill:v.hp<=0});
    if(v.hp<=0) this.kill(v,att,head,how,wIdx);
  }
  kill(v,att,head,how,wIdx){
    v.alive=false; v.hp=0; v.deaths++; v.useP=0; v.dropP=0; v.using=false; if(v.inv.primary===14) v.inv.primary=null;
    if(att&&att!==v){ att.kills++;
      if(this.eco()){ const rw=how==='граната'?300:how==='гранатомёт'?200:how==='нож'?1500:(WEAPONS[wIdx]?WEAPONS[wIdx].reward:300);
        att.money=Math.min(C.MAX_MONEY,att.money+rw); this.sendInv(att); this.send(att,{t:'money',add:rw}); } }
    if(this.bomb.s==='carried'&&this.bomb.carrier===v.id) this.dropBomb(v);
    if(this.mode==='ffa'||this.phase==='wait') v.respawnT=C.RESPAWN;
    this.broadcast({t:'kill',k:att&&att!==v?att.id:0,kn:att&&att!==v?att.name:'',kt:att?att.team:'',v:v.id,vn:v.name,vt:v.team,head:!!head,how:how||'',w:wIdx==null?-1:wIdx,khp:att&&att!==v?Math.max(0,Math.round(att.hp)):0,kx:att?r2(att.x):0,kz:att?r2(att.z):0});
  }
  canHurt(a,b){ return this.mode==='ffa'||a===b||a.team!==b.team; }
  explode(o,owner,how,R,dEnemy,dSelf){
    this.boxesAll.forEach((b,i)=>{ if(b[5]!=='crate'||this.broken.has(i)) return; const d=Math.hypot(b[0]-o.x,b[6]+1-o.y,b[1]-o.z); if(d<R+1) this.hitCrate(i,dEnemy*Math.max(0.3,1-d/R)); });
    for(const p of this.players.values()){ if(!p.alive) continue;
      const d=Math.hypot(p.x-o.x,p.y+1-o.y,p.z-o.z); if(d>=R) continue;
      if(owner&&p!==owner&&!this.canHurt(owner,p)) continue;
      if(GD.segBlocked(o.x,o.y,o.z,p.x,p.y+1,p.z,this.boxes)) continue;
      this.damage(p,(p===owner?dSelf:dEnemy)*(1-d/R),owner,false,how,o); } }

  /* --- бомба --- */
  dropBomb(p){ const b=this.bomb; b.s='dropped'; b.x=p.x; b.z=p.z; b.carrier=null; this.broadcast({t:'bomb',ev:'dropped'}); }
  plant(p,site){ const b=this.bomb; b.s='planted'; b.x=p.x; b.z=p.z; b.site=site; b.timer=C.BOMB_TIME; b.carrier=null;
    p.money=Math.min(C.MAX_MONEY,p.money+C.PLANT_MONEY); this.sendInv(p); this.send(p,{t:'money',add:C.PLANT_MONEY});
    this.broadcast({t:'bomb',ev:'planted',site,name:p.name}); }
  defuse(p){ this.bomb.s='defused'; this.broadcast({t:'bomb',ev:'defused',name:p.name}); this.endRound('CT','бомба обезврежена'); }
  explodeBomb(){ const b=this.bomb; b.s='exploded';
    this.broadcast({t:'boom',x:r2(b.x),y:0.3,z:r2(b.z),big:1});
    for(const p of this.players.values()){ if(!p.alive) continue; const d=Math.hypot(p.x-b.x,p.z-b.z);
      if(d<C.BOMB_R) this.damage(p,450*(1-d/C.BOMB_R),null,false,'бомба',{x:b.x,z:b.z}); }
    this.endRound('T','бомба взорвалась'); }

  /* --- раунды (режим с бомбой) --- */
  startMatch(){ this.score={CT:0,T:0}; this.lossStreak={CT:0,T:0}; this.round=0; this.matchOver=false;
    for(const p of this.players.values()){ p.kills=0; p.deaths=0; p.money=C.START_MONEY; p.inv=freshInv(); p.survived=false; p.alive=false; }
    this.startRound(); }
  startRound(){
    this.round++; this.phase='freeze'; this.timer=C.FREEZE_TIME; this.nades=[]; this.rockets=[];
    this.buyUntil=Date.now()+C.BUY_TIME*1000; this.drop.s='none'; this.holos=[]; this.drones=[]; this.traps=[]; this.resetCrates(); this.dropAt=Date.now()+(C.FREEZE_TIME+C.DROP_DELAY)*1000;
    const b=this.bomb; Object.assign(b,{s:'none',x:0,z:0,timer:0,site:null,carrier:null});
    const idx={CT:0,T:0}, ts=[];
    if(this.mode==='hostage'){
      this.resetHostages(); b.s='none';
      for(const p of shuffle([...this.players.values()])){ if(!p.survived) p.inv=freshInv(); p.inv.kit=false; this.spawn(p,idx[p.team]++); }
      for(const p of this.players.values())
        this.send(p,{t:'round',title:'Раунд '+this.round,sub:(p.team==='CT'?'Освободите заложников и выведите их к зелёной зоне «Выход»':'Не дайте увести заложников и удержите здание')+' · B — магазин'});
      return; }
    if(this.mode==='retake'){
      // the bomb is already planted on a random site; terrorists start around it
      const key=Math.random()<.5?'A':'B', st=MAPS[this.map].sites[key], bp={x:st.x+rand(-1.5,1.5),z:st.z+rand(-1.5,1.5)};
      GD.collide(bp,0.3,this.solids); Object.assign(b,{s:'planted',x:bp.x,z:bp.z,site:key,timer:C.BOMB_TIME,carrier:null});
      let ti=0; const nT=[...this.players.values()].filter(p=>p.team==='T').length||1;
      for(const p of shuffle([...this.players.values()])){
        if(!p.survived) p.inv=freshInv(); if(p.team!=='CT') p.inv.kit=false;
        if(p.team==='T'){ const a=ti++/nT*Math.PI*2+rand(-0.3,0.3), r=rand(4,8); this.spawn(p,0,{x:st.x+Math.cos(a)*r,z:st.z+Math.sin(a)*r}); }
        else this.spawn(p,idx.CT++); }
      for(const p of this.players.values())
        this.send(p,{t:'round',title:'Раунд '+this.round,sub:(p.team==='T'?'Бомба на точке '+key+' — не дай её обезвредить':'Бомба на точке '+key+' — обезвредьте её')+' · B — магазин (бесплатно)'});
      return; }
    for(const p of shuffle([...this.players.values()])){
      if(!p.survived){ p.inv=freshInv(); } if(p.team!=='CT') p.inv.kit=false;
      this.spawn(p,idx[p.team]++); if(p.team==='T') ts.push(p); }
    if(ts.length){ const c=ts[(Math.random()*ts.length)|0]; b.s='carried'; b.carrier=c.id; }
    for(const p of this.players.values()){
      let sub='Не дайте заложить бомбу на A или B';
      if(p.team==='T') sub=b.carrier===p.id?'Бомба у тебя — заложи её на A или B':'Помогите донести бомбу до A или B';
      this.send(p,{t:'round',title:'Раунд '+this.round,sub:sub+' · B — магазин'}); }
  }
  endRound(winner,reason){
    if(this.phase!=='live') return;
    this.phase='post'; this.timer=C.POST_TIME; this.score[winner]++;
    const loser=winner==='CT'?'T':'CT';
    const lossMoney=C.LOSS_MONEY+C.LOSS_STEP*Math.min(this.lossStreak[loser],4);
    this.lossStreak[loser]++; this.lossStreak[winner]=0;
    for(const p of this.players.values()){ p.using=false; p.survived=p.alive;
      const add=this.eco()?(p.team===winner?C.WIN_MONEY:lossMoney):0; p.money=Math.min(C.MAX_MONEY,p.money+add); this.sendInv(p);
      this.send(p,{t:'round',title:p.team===winner?'Раунд за нами':'Раунд проигран',sub:(winner==='CT'?'Победа спецназа':'Победа террористов')+' — '+reason+(add?' · +$'+add:''),win:p.team===winner}); }
    if(this.score[winner]>=C.MATCH_WIN) this.matchOver=true;
  }
  toWait(){
    this.phase='wait'; this.startT=3; this.nades=[]; this.rockets=[]; this.hostages=[]; this.drop.s='none'; this.dropAt=0; this.holos=[]; this.drones=[]; Object.assign(this.bomb,{s:'none',carrier:null,site:null,timer:0});
    this.broadcast({t:'round',title:'Ожидание игроков',sub:'Нужен хотя бы один игрок в каждой команде. Пока можно потренироваться'});
    for(const p of this.players.values()) if(!p.alive) this.spawn(p,this.teamIndex(p));
  }

  /* --- сообщения от игроков --- */
  owns(p,w){ return w===3||w===p.inv.primary||w===p.inv.secondary; }
  validHit(p,v,pt){ if(!v||!v.alive||v===p||!this.canHurt(p,v)) return false;
    if(Math.hypot(pt[0]-v.x,pt[2]-v.z)>2.6||pt[1]<-0.3||pt[1]>v.y+2.7) return false;
    return !GD.segBlocked(p.x,p.y+C.EYE,p.z,pt[0],pt[1],pt[2],this.boxes); }
  handle(p,m){
    const now=Date.now(), live=this.phase!=='freeze'&&this.phase!=='matchend';
    switch(m.t){
      case 'st':{
        if(!p.alive) return;
        const x=num(m.x), y=num(m.y), z=num(m.z), yaw=num(m.yaw), pitch=num(m.pitch);
        if([x,y,z,yaw,pitch].some(Number.isNaN)) return;
        p.yaw=yaw; p.pitch=clamp(pitch,-1.6,1.6); p.w=Number.isInteger(m.w)&&this.owns(p,m.w)?m.w:p.w; p.sp=clamp(num(m.sp)||0,0,20);
        if(this.phase==='freeze'){ p.lastSt=now; return; }
        const el=(now-p.lastSt)/1000, d=Math.hypot(x-p.x,z-p.z);
        if(d>2+9*el+(now<p.dashUntil?9:0)){ this.send(p,{t:'pos',x:r2(p.x),z:r2(p.z)}); p.lastSt=now; return; }
        const q={x,z}; GD.clampMap(q); p.x=q.x; p.z=q.z; p.y=clamp(y,0,4); p.lastSt=now;
        return; }
      case 'shot':{
        if(!p.alive||!live) return;
        const wi=m.w|0, W=WEAPONS[wi]; if(!W||W.knife||W.rocket||!this.owns(p,wi)) return;
        if(now-p.lastShot<W.rate*1000*0.6) return; p.lastShot=now;
        const e=vec(m.e); if(!e) return;
        this.broadcast({t:'shot',id:p.id,w:wi,e:e.map(r2)},p);
        const hits=Array.isArray(m.hits)?m.hits.slice(0,W.pellets||W.pierce||1):[];
        const ey=p.y+C.EYE, agg=new Map(); let idx=0; const seen=new Set();
        for(const h of hits){ const pt=vec(h&&h.pt); if(!pt) continue; const v=this.players.get(h.id|0); if(!this.validHit(p,v,pt)) continue;
          const dist=Math.hypot(pt[0]-p.x,pt[1]-ey,pt[2]-p.z), head=!!h.head; let dmg;
          if(W.pellets){ dmg=W.dmg*(head?W.head:1)*(dist<8?1:dist<16?0.6:0.25); }
          else { if(seen.has(v)) continue; seen.add(v); dmg=W.dmg*(head?W.head:1)*(dist>40&&!W.sniper?0.85:1)*Math.pow(W.mul||0.7,idx++); }
          const a=agg.get(v)||{dmg:0,head:false}; a.dmg+=dmg; a.head=a.head||head; agg.set(v,a); }
        for(const [v,a] of agg) this.damage(v,a.dmg,p,a.head,'',p,wi);
        return; }
      case 'knife':{
        if(!p.alive||!live||now-p.lastKnife<350) return; p.lastKnife=now;
        const h=m.hit; if(!h) return; const v=this.players.get(h.id|0);
        if(!v||!v.alive||v===p||!this.canHurt(p,v)||Math.hypot(v.x-p.x,v.z-p.z)>2.8) return;
        const fx=-Math.sin(v.yaw), fz=-Math.cos(v.yaw), tx=p.x-v.x, tz=p.z-v.z, tl=Math.hypot(tx,tz)||1, behind=(fx*tx+fz*tz)/tl<-0.4;
        let dmg=m.heavy?(behind?200:65):(behind?90:40); if(h.head) dmg*=1.3;
        this.damage(v,dmg,p,false,'нож',p,3); return; }
      case 'rocket':{
        if(!p.alive||!live||p.inv.primary!==13||now-p.lastShot<900) return; p.lastShot=now;
        const o=vec(m.o), d=vec(m.d); if(!o||!d) return;
        if(Math.hypot(o[0]-p.x,o[2]-p.z)>2.5) return; const dl=Math.hypot(...d)||1;
        const r={id:this.nid++,owner:p.id,p:{x:o[0],y:clamp(o[1],0.3,4),z:o[2]},v:{x:d[0]/dl*38,y:d[1]/dl*38,z:d[2]/dl*38},t:0};
        this.rockets.push(r); this.broadcast({t:'rocket',rid:r.id,o:[r.p.x,r.p.y,r.p.z].map(r3),v:[r.v.x,r.v.y,r.v.z].map(r3)});
        return; }
      case 'nade':{
        const type=m.type; if(!p.alive||!live||!(type in NADE_FUSE)||!(p.inv.nades[type]>0)) return;
        const o=vec(m.o), v=vec(m.v); if(!o||!v||Math.hypot(o[0]-p.x,o[2]-p.z)>2) return;
        const sp=Math.hypot(...v), k=sp>26?26/sp:1;
        p.inv.nades[type]--; this.sendInv(p);
        const n={id:this.nid++,owner:p.id,type,p:{x:o[0],y:clamp(o[1],0.2,4),z:o[2]},v:{x:v[0]*k,y:v[1]*k,z:v[2]*k},t:NADE_FUSE[type]};
        this.nades.push(n); this.broadcast({t:'nade',nid:n.id,type,o:[n.p.x,n.p.y,n.p.z].map(r3),v:[n.v.x,n.v.y,n.v.z].map(r3)});
        return; }
      case 'buy':{
        if(!this.canBuy(p)) return this.send(p,{t:'msg',text:'Магазин закрыт'});
        const it=String(m.item||''), inv=p.inv; let price=0, ok=true;
        if(it.startsWith('w:')){ const wi=Number(it.slice(2)), W=WEAPONS[wi]; if(!W||W.knife||W.special||wi===1) return; price=W.price;
          if(inv.primary===wi||inv.secondary===wi) ok=false; }
        else if(it==='armor'){ price=GEAR.armor; if(inv.armor>=100) ok=false; }
        else if(it==='kit'){ price=GEAR.kit; if(inv.kit||this.mode==='ffa'||this.mode==='hostage'||p.team!=='CT') ok=false; }
        else if(it==='drone'){ price=GEAR.drone; if(inv.drone>=1) ok=false; }
        else if(it==='trap'){ price=GEAR.trap; if(inv.trap>=1) ok=false; }
        else if(it in NADE_MAX){ price=GEAR[it]; if(inv.nades[it]>=NADE_MAX[it]) ok=false; }
        else return;
        if(!this.eco()) price=0;
        if(!ok||p.money<price) return this.send(p,{t:'buyfail'});
        p.money-=price;
        if(it.startsWith('w:')){ const wi=Number(it.slice(2)); if(WEAPONS[wi].slot==='s') inv.secondary=wi; else inv.primary=wi; this.send(p,{t:'bought',w:wi}); }
        else if(it==='armor') inv.armor=100; else if(it==='kit') inv.kit=true; else if(it==='drone') inv.drone=1; else if(it==='trap') inv.trap=1; else inv.nades[it]++;
        this.sendInv(p); return; }
      case 'use': p.using=!!m.on; return;
      case 'chat':{ if(now-p.lastChat<700) return; const text=GD.cleanChat(m.text); if(!text) return; p.lastChat=now;
        const teamOnly=!!m.team&&this.mode!=='ffa', o={t:'chat',id:p.id,name:p.name,team:p.team,text,teamOnly,dead:!p.alive};
        if(teamOnly){ for(const q of this.players.values()) if(q.team===p.team) this.send(q,o); } else this.broadcast(o); return; }
      case 'radio':{ if(now-p.lastRadio<900) return; const cmd=m.cmd|0; if(cmd<0||cmd>=GD.RADIO.length) return; p.lastRadio=now;
        const pt=vec(m.pt), o={t:'radio',id:p.id,name:p.name,team:p.team,cmd,pt:pt?pt.map(r2):null,x:r2(p.x),z:r2(p.z)};
        if(this.mode==='ffa') this.broadcast(o); else for(const q of this.players.values()) if(q.team===p.team) this.send(q,o); return; }
      case 'dash': if(!p.alive||now-p.lastDash<C.DASH_CD*1000-300) return; p.lastDash=now; p.dashUntil=now+700; return;
      case 'drone':{
        if(!p.alive||!live||!(p.inv.drone>0)) return; p.inv.drone--; this.sendInv(p);
        const fx=-Math.sin(p.yaw), fz=-Math.cos(p.yaw); let tx=p.x+fx*C.DRONE_DIST, tz=p.z+fz*C.DRONE_DIST;
        for(let k=1;k<=C.DRONE_DIST*2;k++){ const q={x:p.x+fx*k/2,y:C.DRONE_ALT,z:p.z+fz*k/2}; if(GD.pointHit(q,this.solids,0.4)){ const s=Math.max(0.5,k/2-1); tx=p.x+fx*s; tz=p.z+fz*s; break; } }
        const q={x:tx,z:tz}; GD.clampMap(q);
        const d={id:this.nid++,owner:p.id,team:p.team,x:p.x,y:1.6,z:p.z,tx:q.x,tz:q.z,t:C.DRONE_TIME+1,scan:0,spotted:[]};
        this.drones.push(d); this.broadcast({t:'drone',ev:'up',id:d.id,name:p.name}); return; }
      case 'crate':{ if(!p.alive||now-(p.lastCrate||0)<40) return; p.lastCrate=now; const i=m.id|0, b=this.boxesAll[i], W=WEAPONS[m.w|0];
        if(!b||Math.hypot(b[0]-p.x,b[1]-p.z)>(W&&W.knife?3.5:120)) return; this.hitCrate(i,W&&W.knife?45:W&&W.dmg?W.dmg:30); return; }
      case 'trap':{ if(!p.alive||!live||!(p.inv.trap>0)) return; p.inv.trap--; this.sendInv(p);
        const q={x:p.x-Math.sin(p.yaw)*1.1,z:p.z-Math.cos(p.yaw)*1.1}; GD.collide(q,0.3,this.solids); GD.clampMap(q);
        this.traps.push({id:this.nid++,owner:p.id,team:p.team,x:q.x,z:q.z,arm:C.TRAP_ARM,t:this.mode==='ffa'?90:999,fuse:-1}); return; }
      case 'traphit':{ if(!p.alive) return; const i=this.traps.findIndex(t=>t.id===(m.id|0)); if(i<0) return; const t=this.traps[i];
        if(this.mode==='ffa'?t.owner===p.id:t.team===p.team) return; this.traps.splice(i,1); this.broadcast({t:'trapev',ev:'gone',id:t.id,x:r2(t.x),z:r2(t.z),by:p.name}); return; }
      case 'vote':{ if(!this.vote||!this.vote.options.includes(m.map)) return; this.vote.votes.set(p.id,m.map); this.sendTally(); return; }
      case 'dronehit':{ if(!p.alive) return; const i=this.drones.findIndex(d=>d.id===(m.id|0)); if(i<0) return; const d=this.drones[i];
        if(this.mode==='ffa'?d.owner===p.id:d.team===p.team) return;
        if(Math.hypot(d.x-p.x,d.z-p.z)>120) return; this.drones.splice(i,1);
        this.broadcast({t:'drone',ev:'gone',id:d.id,x:r2(d.x),y:r2(d.y),z:r2(d.z),by:p.name}); return; }
      case 'holohit':{ if(!p.alive) return; const i=this.holos.findIndex(h=>h.id===(m.id|0)); if(i<0) return; const h=this.holos[i];
        if(this.mode==='ffa'?h.owner===p.id:h.team===p.team) return; this.holos.splice(i,1);
        this.broadcast({t:'holo',ev:'pop',id:h.id,x:r2(h.x),z:r2(h.z),by:p.name}); return; }
      case 'team':{
        if(this.mode==='ffa') return;
        const t=m.team; if((t!=='CT'&&t!=='T')||t===p.team) return;
        if(this.teamCount()[t]>=C.MAX_TEAM){ this.send(p,{t:'msg',text:'В этой команде уже '+C.MAX_TEAM+' игроков'}); return; }
        if(this.bomb.s==='carried'&&this.bomb.carrier===p.id) this.dropBomb(p);
        p.team=t; p.alive=false; p.useP=0; p.survived=false; p.inv=freshInv();
        this.broadcast({t:'msg',text:p.name+' теперь за '+(t==='CT'?'спецназ':'террористов')});
        if(this.phase==='wait') this.spawn(p,this.teamIndex(p));
        else this.send(p,{t:'round',title:'Команда сменена',sub:'Ты появишься в следующем раунде'});
        return; }
    }
  }

  /* --- игровой такт --- */
  tick(dt){
    for(let i=this.nades.length-1;i>=0;i--){ const n=this.nades[i]; GD.nadeStep(n,dt,this.solids); n.t-=dt;
      if(n.t<=0){ this.nades.splice(i,1); this.nadeBoom(n); } }
    for(let i=this.rockets.length-1;i>=0;i--){ const r=this.rockets[i]; r.t+=dt; r.v.y-=2*dt; let boom=r.t>4;
      for(let s=0;s<4&&!boom;s++){ r.p.x+=r.v.x*dt/4; r.p.y+=r.v.y*dt/4; r.p.z+=r.v.z*dt/4;
        if(r.p.y<0.15||GD.pointHit(r.p,this.solids,0.1)) boom=true;
        else { const owner=this.players.get(r.owner); for(const p of this.players.values()) if(p.alive&&p.id!==r.owner&&(!owner||this.canHurt(owner,p))&&Math.hypot(p.x-r.p.x,p.z-r.p.z)<0.65&&r.p.y>p.y&&r.p.y<p.y+2.1){ boom=true; break; } } }
      if(boom){ this.rockets.splice(i,1); const o={x:r.p.x,y:Math.max(r.p.y,0.35),z:r.p.z};
        this.broadcast({t:'boom',rid:r.id,x:r2(o.x),y:r2(o.y),z:r2(o.z)}); this.explode(o,this.players.get(r.owner)||null,'гранатомёт',C.NADE_R,140,85); } }
    this.tickDrop(dt); this.tickHolos(dt); this.tickDrones(dt); this.tickTraps(dt);
    if(this.mode==='ffa') this.tickFFA(dt); else this.tickBomb(dt);
    this.snapAcc+=dt; if(this.snapAcc>=0.05){ this.snapAcc=0; this.snapshot(); }
  }
  // supply drop: falls from the sky mid-round, whoever opens it gets the golden AK
  tickDrop(dt){ const d=this.drop, now=Date.now();
    if(d.s==='none'){ if(this.dropAt&&now>=this.dropAt&&(this.mode==='ffa'||this.phase==='live')&&this.players.size){
        const list=MAPS[this.map].ffa, sp=list[(Math.random()*list.length)|0], q={x:sp[0]*0.6,z:sp[1]*0.6}; GD.collide(q,1,this.solids); GD.clampMap(q);
        Object.assign(d,{s:'falling',x:q.x,z:q.z,h:28,t:45}); this.dropAt=0; this.broadcast({t:'drop',ev:'incoming',x:r2(q.x),z:r2(q.z)}); } return; }
    if(d.s==='falling'){ d.h-=dt*5; if(d.h<=0){ d.h=0; d.s='landed'; this.broadcast({t:'drop',ev:'landed'}); } return; }
    d.t-=dt; if(d.t<=0){ d.s='none'; if(this.mode==='ffa') this.dropAt=now+C.DROP_FFA*1000; return; }
    for(const p of this.players.values()){
      if(p.alive&&p.using&&p.sp<1.5&&Math.hypot(p.x-d.x,p.z-d.z)<2.2){ p.dropP+=dt;
        if(p.dropP>=C.DROP_OPEN){ p.dropP=0; d.s='none'; p.inv.primary=14; this.send(p,{t:'bought',w:14}); this.sendInv(p);
          this.broadcast({t:'drop',ev:'taken',name:p.name,team:p.team}); if(this.mode==='ffa') this.dropAt=now+C.DROP_FFA*1000; return; } }
      else p.dropP=0; } }
  // proximity trap: arms after 1.5 s, goes off when an enemy steps close
  tickTraps(dt){ for(let i=this.traps.length-1;i>=0;i--){ const t=this.traps[i]; t.arm-=dt; t.t-=dt;
      if(t.t<=0){ this.traps.splice(i,1); this.broadcast({t:'trapev',ev:'gone',id:t.id,x:r2(t.x),z:r2(t.z)}); continue; }
      if(t.fuse>=0){ t.fuse-=dt; if(t.fuse<=0){ this.traps.splice(i,1); const o={x:t.x,y:0.4,z:t.z};
          this.broadcast({t:'boom',x:r2(o.x),y:0.4,z:r2(o.z)}); this.explode(o,this.players.get(t.owner)||null,'ловушка',5.5,130,60); } continue; }
      if(t.arm>0) continue;
      for(const p of this.players.values()){ if(!p.alive||p.id===t.owner||(this.mode!=='ffa'&&p.team===t.team)) continue;
        if(Math.hypot(p.x-t.x,p.z-t.z)<C.TRAP_R){ t.fuse=0.35; this.broadcast({t:'trapev',ev:'trig',id:t.id,x:r2(t.x),z:r2(t.z)});
          const o={t:'trapev',ev:'alert',x:r2(t.x),z:r2(t.z),name:p.name}; if(this.mode==='ffa'){ const ow=this.players.get(t.owner); if(ow) this.send(ow,o); } else for(const q of this.players.values()) if(q.team===t.team) this.send(q,o);
          break; } } } }
  // map vote at the end of a match
  startVote(){ const ok=Object.keys(MAPS).filter(k=>this.mode==='ffa'?true:this.mode==='hostage'?k==='embassy':!!MAPS[k].sites);
    if(ok.length<2){ this.vote=null; return; } const opts=[this.map,...shuffle(ok.filter(k=>k!==this.map)).slice(0,2)];
    this.vote={options:opts,votes:new Map()}; this.broadcast({t:'vote',options:opts,secs:C.VOTE_TIME}); }
  sendTally(){ const tally={}; for(const o of this.vote.options) tally[o]=0; for(const v of this.vote.votes.values()) tally[v]++; this.broadcast({t:'votes',tally}); }
  finishVote(){ const v=this.vote; this.vote=null; let map=this.map;
    if(v){ const tally={}; for(const o of v.options) tally[o]=0; for(const x of v.votes.values()) tally[x]++; const best=Math.max(...Object.values(tally));
      const top=v.options.filter(o=>tally[o]===best); map=top[(Math.random()*top.length)|0]; }
    this.setMap(map); this.traps=[]; this.broadcast({t:'map',map,weather:this.weather}); }
  // recon drone: flies forward, hovers and reveals enemies to the owner's team
  tickDrones(dt){ for(let i=this.drones.length-1;i>=0;i--){ const d=this.drones[i]; d.t-=dt;
      if(d.t<=0){ this.drones.splice(i,1); this.broadcast({t:'drone',ev:'gone',id:d.id,x:r2(d.x),y:r2(d.y),z:r2(d.z)}); continue; }
      const dx=d.tx-d.x, dz=d.tz-d.z, dl=Math.hypot(dx,dz), st=Math.min(dl,12*dt); if(dl>0.01){ d.x+=dx/dl*st; d.z+=dz/dl*st; }
      d.y+=(C.DRONE_ALT-d.y)*Math.min(1,dt*3);
      d.scan-=dt; if(d.scan<=0){ d.scan=0.25; const owner=this.players.get(d.owner); d.spotted=[];
        for(const p of this.players.values()){ if(!p.alive||p.id===d.owner) continue; if(this.mode==='ffa'?false:p.team===d.team) continue;
          if(Math.hypot(p.x-d.x,p.z-d.z)>C.DRONE_RANGE) continue; if(GD.segBlocked(d.x,d.y,d.z,p.x,p.y+1.5,p.z,this.boxes)) continue; d.spotted.push(p.id); } } } }
  // hostages: special forces lead them out to the rescue zone
  resetHostages(){ const H=MAPS[this.map].hostages||[]; this.hostages=H.map(([x,z],i)=>({id:i+1,x,z,yaw:0,state:0,by:0})); }
  tickHostage(dt){
    const R=MAPS[this.map].rescue;
    for(const p of this.players.values()){ let ok=false;
      if(p.alive&&p.team==='CT'&&p.using&&p.sp<1.5){ const h=this.hostages.find(h=>h.state===0&&Math.hypot(h.x-p.x,h.z-p.z)<1.9);
        if(h){ ok=true; p.useP+=dt; if(p.useP>=C.RESCUE_HOLD){ p.useP=0; h.state=1; h.by=p.id; this.send(p,{t:'msg',text:'Заложник идёт за тобой — веди его к зелёной зоне'}); } } }
      if(!ok) p.useP=0; }
    for(const h of this.hostages){ if(h.state!==1) continue; const f=this.players.get(h.by);
      if(!f||!f.alive){ h.state=0; h.by=0; continue; }
      const dx=f.x-h.x, dz=f.z-h.z, d=Math.hypot(dx,dz); h.yaw=Math.atan2(-dx,-dz);
      if(d>1.6){ const st=Math.min(d-1.6,6.8*dt); const q={x:h.x+dx/d*st,z:h.z+dz/d*st}; GD.collide(q,0.35,this.solids);
        for(const o of this.hostages) if(o!==h&&o.state!==2){ const ex=q.x-o.x, ez=q.z-o.z, e=Math.hypot(ex,ez); if(e<0.7&&e>0.001){ q.x=o.x+ex/e*0.7; q.z=o.z+ez/e*0.7; } }
        h.x=q.x; h.z=q.z; if(d>9){ h.x=f.x-dx/d*1.6; h.z=f.z-dz/d*1.6; } }
      if(R&&Math.hypot(h.x-R.x,h.z-R.z)<R.r){ h.state=2; f.money=Math.min(C.MAX_MONEY,f.money+C.RESCUE_MONEY); this.sendInv(f); this.send(f,{t:'money',add:C.RESCUE_MONEY});
        const left=this.hostages.filter(o=>o.state!==2).length; this.broadcast({t:'hostage',ev:'rescued',name:f.name,left}); } }
    const ctA=this.aliveCount('CT'), tA=this.aliveCount('T');
    if(this.hostages.length&&this.hostages.every(h=>h.state===2)) return this.endRound('CT','все заложники спасены');
    if(tA===0) return this.endRound('CT','террористы уничтожены');
    if(ctA===0) return this.endRound('T','спецназ уничтожен');
    this.timer-=dt; if(this.timer<=0) this.endRound('T','время вышло'); }
  tickHolos(dt){ for(let i=this.holos.length-1;i>=0;i--){ const h=this.holos[i]; h.t-=dt; if(h.t<=0){ this.holos.splice(i,1); this.broadcast({t:'holo',ev:'pop',id:h.id,x:r2(h.x),z:r2(h.z)}); } } }
  nadeBoom(n){
    const o=n.p; o.y=Math.max(o.y,0.35);
    if(n.type==='holo'){ const ow=this.players.get(n.owner), q={x:o.x,z:o.z}; GD.collide(q,0.4,this.solids);
      this.holos.push({id:n.id,x:q.x,z:q.z,yaw:ow?ow.yaw:0,team:ow?ow.team:'T',owner:n.owner,t:C.HOLO_TIME}); return this.broadcast({t:'holo',ev:'up',id:n.id,x:r2(q.x),z:r2(q.z)}); }
    if(n.type==='smoke') return this.broadcast({t:'smoke',nid:n.id,x:r2(o.x),z:r2(o.z)});
    if(n.type==='flash') return this.broadcast({t:'flash',nid:n.id,x:r2(o.x),y:r2(o.y),z:r2(o.z),owner:n.owner});
    this.broadcast({t:'boom',nid:n.id,x:r2(o.x),y:r2(o.y),z:r2(o.z)});
    this.explode(o,this.players.get(n.owner)||null,'граната',C.NADE_R,140,85);
  }
  tickFFA(dt){
    if(this.phase==='matchend'){ this.timer-=dt; if(this.timer<=0){ this.finishVote(); this.resetCrates(); this.phase='live'; this.timer=C.FFA_TIME;
        for(const p of this.players.values()){ p.kills=0; p.deaths=0; this.spawn(p,0); }
        this.broadcast({t:'round',title:'Новый бой',sub:'Первый, кто наберёт '+C.FFA_KILLS+' убийств, побеждает'}); } return; }
    this.timer-=dt;
    for(const p of this.players.values()) if(!p.alive){ p.respawnT-=dt; if(p.respawnT<=0) this.spawn(p,0); }
    let leader=null; for(const p of this.players.values()) if(!leader||p.kills>leader.kills) leader=p;
    if(leader&&(leader.kills>=C.FFA_KILLS||this.timer<=0)){
      this.phase='matchend'; this.timer=C.VOTE_TIME; this.startVote();
      this.broadcast({t:'round',title:'Бой окончен',sub:'Победил '+leader.name+' — '+leader.kills+' убийств',end:1}); }
  }
  tickBomb(dt){
    const n=this.teamCount();
    if(this.phase!=='wait'&&(n.CT===0||n.T===0)){ this.toWait(); return; }
    switch(this.phase){
      case 'wait':
        for(const p of this.players.values()) if(!p.alive){ p.respawnT-=dt; if(p.respawnT<=0) this.spawn(p,this.teamIndex(p)); }
        if(n.CT>0&&n.T>0){ this.startT-=dt; if(this.startT<=0){ this.broadcast({t:'msg',text:'Матч начинается!'}); this.startMatch(); } } else this.startT=3;
        return;
      case 'freeze': this.timer-=dt; if(this.timer<=0){ this.phase='live'; this.timer=this.mode==='hostage'?C.HOSTAGE_TIME:C.ROUND_TIME; } return;
      case 'post':
        this.timer-=dt;
        if(this.timer<=0){
          if(this.matchOver){ this.phase='matchend'; this.timer=C.VOTE_TIME; this.startVote(); const w=this.score.CT>this.score.T?'CT':'T';
            for(const p of this.players.values()) this.send(p,{t:'round',title:p.team===w?'Победа в матче!':'Матч проигран',sub:'Спецназ '+this.score.CT+' : '+this.score.T+' Террористы',end:1}); }
          else this.startRound(); }
        return;
      case 'matchend': this.timer-=dt; if(this.timer<=0){ this.finishVote(); this.startMatch(); } return;
      case 'live': if(this.mode==='hostage') this.tickHostage(dt); else this.tickLive(dt); return;
    }
  }
  tickLive(dt){
    const b=this.bomb;
    for(const p of this.players.values()){ let ok=false;
      if(p.alive&&p.using&&p.sp<1.5&&p.y<0.1){
        if(b.s==='carried'&&b.carrier===p.id){ const site=GD.siteAt(this.map,p.x,p.z,5);
          if(site){ ok=true; p.useP+=dt; if(p.useP>=C.PLANT_TIME){ p.useP=0; this.plant(p,site); } } }
        else if(b.s==='planted'&&p.team==='CT'&&Math.hypot(p.x-b.x,p.z-b.z)<1.8){ ok=true; p.useP+=dt;
          if(p.useP>=(p.inv.kit?C.DEFUSE_TIME/2:C.DEFUSE_TIME)){ p.useP=0; this.defuse(p); return; } } }
      if(!ok) p.useP=0; }
    if(b.s==='dropped') for(const p of this.players.values())
      if(p.alive&&p.team==='T'&&Math.hypot(p.x-b.x,p.z-b.z)<1.3){ b.s='carried'; b.carrier=p.id; this.send(p,{t:'msg',text:'Бомба у тебя'}); this.broadcast({t:'bomb',ev:'picked'}); break; }
    const ctA=this.aliveCount('CT'), tA=this.aliveCount('T');
    if(b.s==='planted'){ b.timer-=dt; if(b.timer<=0){ this.explodeBomb(); return; } if(ctA===0) this.endRound('T','спецназ уничтожен'); return; }
    if(tA===0) return this.endRound('CT','террористы уничтожены');
    if(ctA===0) return this.endRound('T','спецназ уничтожен');
    this.timer-=dt; if(this.timer<=0) this.endRound('CT','время вышло');
  }
  snapshot(){
    const ps=[]; for(const p of this.players.values())
      ps.push([p.id,r2(p.x),r2(p.y),r2(p.z),r3(p.yaw),r3(p.pitch),Math.max(0,Math.round(p.hp)),p.alive?1:0,p.team,p.w,r2(p.useP),p.name,p.kills,p.deaths,r2(p.dropP)]);
    const b=this.bomb;
    this.broadcast({t:'snap',ps,b:{s:b.s,x:r2(b.x),z:r2(b.z),tm:r2(b.timer),site:b.site,c:b.carrier},
      r:{ph:this.phase,tm:r2(this.timer),n:this.round,ct:this.score.CT,tt:this.score.T,mode:this.mode,buy:r2(Math.max(0,(this.buyUntil-Date.now())/1000))},
      d:{s:this.drop.s,x:r2(this.drop.x),z:r2(this.drop.z),h:r2(this.drop.h)},hg:(this.hostages||[]).map(h=>[h.id,r2(h.x),r2(h.z),h.state,r3(h.yaw),h.by]),hs:this.holos.map(h=>[h.id,r2(h.x),r2(h.z),r3(h.yaw),h.team,h.owner]),ds:this.drones.map(d=>[d.id,r2(d.x),r2(d.y),r2(d.z),d.team,d.owner,d.spotted]),tp:this.traps.map(t=>[t.id,r2(t.x),r2(t.z),t.team,t.owner,t.arm>0?0:1])});
  }
}

/* ---------- WebSocket ---------- */
const wss=new WebSocketServer({server,path:'/ws',maxPayload:8192});
wss.on('connection',ws=>{
  let room=null, p=null; ws.isAlive=true;
  ws.on('pong',()=>{ ws.isAlive=true; });
  ws.on('message',raw=>{
    let m; try{ m=JSON.parse(raw); }catch(e){ return; }
    if(!m||typeof m.t!=='string') return;
    if(m.t==='join'){
      if(p) return;
      const code=cleanCode(m.room); let r=rooms.get(code);
      if(!r){ const mode=['ffa','retake','hostage'].includes(m.mode)?m.mode:'bomb'; let map=MAPS[m.map]?m.map:'port';
        if(mode==='hostage') map='embassy'; else if(mode!=='ffa'&&!MAPS[map].sites) map='port';
        r=new Room(code,mode,map); rooms.set(code,r); }
      if(r.players.size>=r.max){ ws.send(JSON.stringify({t:'error',text:'Комната «'+code+'» заполнена'})); return; }
      room=r; p=r.add(ws,cleanName(m.name),m.team); return; }
    if(p&&room) room.handle(p,m);
  });
  ws.on('close',()=>{ if(p&&room) room.remove(p); p=null; });
  ws.on('error',()=>{});
});
setInterval(()=>{ for(const ws of wss.clients){ if(!ws.isAlive){ ws.terminate(); continue; } ws.isAlive=false; try{ ws.ping(); }catch(e){} } },20000);
let lastT=Date.now();
setInterval(()=>{ const now=Date.now(), dt=Math.min(0.1,(now-lastT)/1000); lastT=now; for(const r of rooms.values()) r.tick(dt); },1000/30);

server.listen(PORT,()=>console.log('Пыльный рубеж онлайн: http://localhost:'+PORT));
