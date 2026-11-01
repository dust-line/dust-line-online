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
const freshInv=()=>({primary:null,secondary:1,armor:0,kit:false,nades:{he:0,smoke:0,flash:0}});

/* ---------- комнаты ---------- */
let nextId=1;
const rooms=new Map();
class Room{
  constructor(code,mode,map){
    this.code=code; this.mode=mode; this.max=mode==='ffa'?C.MAX_FFA:C.MAX_BOMB;
    this.map=map; const md=MAPDATA[map]; this.solids=md.solids; this.boxes=md.boxes3;
    this.players=new Map(); this.nades=[]; this.rockets=[]; this.nid=1;
    this.phase=mode==='ffa'?'live':'wait'; this.timer=mode==='ffa'?C.FFA_TIME:0; this.startT=3; this.buyUntil=0;
    this.round=0; this.score={CT:0,T:0}; this.lossStreak={CT:0,T:0}; this.matchOver=false; this.snapAcc=0;
    this.bomb={s:'none',x:0,z:0,timer:0,site:null,carrier:null};
  }
  send(p,o){ if(p.ws.readyState===1) p.ws.send(JSON.stringify(o)); }
  broadcast(o,except){ const s=JSON.stringify(o); for(const p of this.players.values()) if(p!==except&&p.ws.readyState===1) p.ws.send(s); }
  teamCount(){ const n={CT:0,T:0}; for(const p of this.players.values()) n[p.team]++; return n; }
  aliveCount(team){ let n=0; for(const p of this.players.values()) if(p.alive&&p.team===team) n++; return n; }
  pickTeam(pref){ const n=this.teamCount(), other=t=>t==='CT'?'T':'CT';
    if((pref==='CT'||pref==='T')&&n[pref]<C.MAX_TEAM&&n[pref]<=n[other(pref)]) return pref;
    return n.CT<=n.T?'CT':'T'; }
  sendInv(p){ this.send(p,{t:'inv',money:this.mode==='bomb'?p.money:0,primary:p.inv.primary,secondary:p.inv.secondary,armor:Math.round(p.inv.armor),kit:p.inv.kit,nades:p.inv.nades,free:this.mode!=='bomb'}); }
  canBuy(p){ return p.alive&&(this.mode==='ffa'||(this.phase==='freeze'||this.phase==='wait'||(this.phase==='live'&&Date.now()<this.buyUntil))); }

  add(ws,name,pref){
    const id=nextId++;
    const team=this.mode==='ffa'?(Math.random()<.5?'CT':'T'):this.pickTeam(pref);
    const p={id,ws,name,team,x:0,y:0,z:0,yaw:0,pitch:0,w:1,sp:0,hp:100,alive:false,kills:0,deaths:0,money:C.START_MONEY,inv:freshInv(),
      using:false,useP:0,lastShot:0,lastKnife:0,respawnT:0,lastSt:Date.now(),survived:false};
    this.players.set(id,p);
    this.send(p,{t:'welcome',id,room:this.code,mode:this.mode,map:this.map,team});
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
    v.alive=false; v.hp=0; v.deaths++; v.useP=0; v.using=false;
    if(att&&att!==v){ att.kills++;
      if(this.mode==='bomb'){ const rw=how==='граната'?300:how==='гранатомёт'?200:how==='нож'?1500:(WEAPONS[wIdx]?WEAPONS[wIdx].reward:300);
        att.money=Math.min(C.MAX_MONEY,att.money+rw); this.sendInv(att); this.send(att,{t:'money',add:rw}); } }
    if(this.bomb.s==='carried'&&this.bomb.carrier===v.id) this.dropBomb(v);
    if(this.mode==='ffa'||this.phase==='wait') v.respawnT=C.RESPAWN;
    this.broadcast({t:'kill',k:att&&att!==v?att.id:0,kn:att&&att!==v?att.name:'',kt:att?att.team:'',v:v.id,vn:v.name,vt:v.team,head:!!head,how:how||''});
  }
  canHurt(a,b){ return this.mode==='ffa'||a===b||a.team!==b.team; }
  explode(o,owner,how,R,dEnemy,dSelf){
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
    this.buyUntil=Date.now()+C.BUY_TIME*1000;
    const b=this.bomb; Object.assign(b,{s:'none',x:0,z:0,timer:0,site:null,carrier:null});
    const idx={CT:0,T:0}, ts=[];
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
      const add=this.mode==='bomb'?(p.team===winner?C.WIN_MONEY:lossMoney):0; p.money=Math.min(C.MAX_MONEY,p.money+add); this.sendInv(p);
      this.send(p,{t:'round',title:p.team===winner?'Раунд за нами':'Раунд проигран',sub:(winner==='CT'?'Победа спецназа':'Победа террористов')+' — '+reason+(add?' · +$'+add:''),win:p.team===winner}); }
    if(this.score[winner]>=C.MATCH_WIN) this.matchOver=true;
  }
  toWait(){
    this.phase='wait'; this.startT=3; this.nades=[]; this.rockets=[]; Object.assign(this.bomb,{s:'none',carrier:null,site:null,timer:0});
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
        if(d>2+9*el){ this.send(p,{t:'pos',x:r2(p.x),z:r2(p.z)}); p.lastSt=now; return; }
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
        if(it.startsWith('w:')){ const wi=Number(it.slice(2)), W=WEAPONS[wi]; if(!W||W.knife||wi===1) return; price=W.price;
          if(inv.primary===wi||inv.secondary===wi) ok=false; }
        else if(it==='armor'){ price=GEAR.armor; if(inv.armor>=100) ok=false; }
        else if(it==='kit'){ price=GEAR.kit; if(inv.kit||this.mode==='ffa'||p.team!=='CT') ok=false; }
        else if(it in NADE_MAX){ price=GEAR[it]; if(inv.nades[it]>=NADE_MAX[it]) ok=false; }
        else return;
        if(this.mode!=='bomb') price=0;
        if(!ok||p.money<price) return this.send(p,{t:'buyfail'});
        p.money-=price;
        if(it.startsWith('w:')){ const wi=Number(it.slice(2)); if(WEAPONS[wi].slot==='s') inv.secondary=wi; else inv.primary=wi; this.send(p,{t:'bought',w:wi}); }
        else if(it==='armor') inv.armor=100; else if(it==='kit') inv.kit=true; else inv.nades[it]++;
        this.sendInv(p); return; }
      case 'use': p.using=!!m.on; return;
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
    if(this.mode==='ffa') this.tickFFA(dt); else this.tickBomb(dt);
    this.snapAcc+=dt; if(this.snapAcc>=0.05){ this.snapAcc=0; this.snapshot(); }
  }
  nadeBoom(n){
    const o=n.p; o.y=Math.max(o.y,0.35);
    if(n.type==='smoke') return this.broadcast({t:'smoke',nid:n.id,x:r2(o.x),z:r2(o.z)});
    if(n.type==='flash') return this.broadcast({t:'flash',nid:n.id,x:r2(o.x),y:r2(o.y),z:r2(o.z),owner:n.owner});
    this.broadcast({t:'boom',nid:n.id,x:r2(o.x),y:r2(o.y),z:r2(o.z)});
    this.explode(o,this.players.get(n.owner)||null,'граната',C.NADE_R,140,85);
  }
  tickFFA(dt){
    if(this.phase==='matchend'){ this.timer-=dt; if(this.timer<=0){ this.phase='live'; this.timer=C.FFA_TIME;
        for(const p of this.players.values()){ p.kills=0; p.deaths=0; this.spawn(p,0); }
        this.broadcast({t:'round',title:'Новый бой',sub:'Первый, кто наберёт '+C.FFA_KILLS+' убийств, побеждает'}); } return; }
    this.timer-=dt;
    for(const p of this.players.values()) if(!p.alive){ p.respawnT-=dt; if(p.respawnT<=0) this.spawn(p,0); }
    let leader=null; for(const p of this.players.values()) if(!leader||p.kills>leader.kills) leader=p;
    if(leader&&(leader.kills>=C.FFA_KILLS||this.timer<=0)){
      this.phase='matchend'; this.timer=C.MATCH_END_TIME;
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
      case 'freeze': this.timer-=dt; if(this.timer<=0){ this.phase='live'; this.timer=C.ROUND_TIME; } return;
      case 'post':
        this.timer-=dt;
        if(this.timer<=0){
          if(this.matchOver){ this.phase='matchend'; this.timer=C.MATCH_END_TIME; const w=this.score.CT>this.score.T?'CT':'T';
            for(const p of this.players.values()) this.send(p,{t:'round',title:p.team===w?'Победа в матче!':'Матч проигран',sub:'Спецназ '+this.score.CT+' : '+this.score.T+' Террористы',end:1}); }
          else this.startRound(); }
        return;
      case 'matchend': this.timer-=dt; if(this.timer<=0) this.startMatch(); return;
      case 'live': this.tickLive(dt); return;
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
      ps.push([p.id,r2(p.x),r2(p.y),r2(p.z),r3(p.yaw),r3(p.pitch),Math.max(0,Math.round(p.hp)),p.alive?1:0,p.team,p.w,r2(p.useP),p.name,p.kills,p.deaths]);
    const b=this.bomb;
    this.broadcast({t:'snap',ps,b:{s:b.s,x:r2(b.x),z:r2(b.z),tm:r2(b.timer),site:b.site,c:b.carrier},
      r:{ph:this.phase,tm:r2(this.timer),n:this.round,ct:this.score.CT,tt:this.score.T,mode:this.mode,buy:r2(Math.max(0,(this.buyUntil-Date.now())/1000))}});
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
      if(!r){ const mode=['ffa','retake'].includes(m.mode)?m.mode:'bomb'; let map=MAPS[m.map]?m.map:'port'; if(mode!=='ffa'&&!MAPS[map].sites) map='port';
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
