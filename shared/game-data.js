// Общие данные и правила «Пыльного рубежа онлайн»: этот файл используют и сервер, и браузер.
(function(G){
'use strict';
const C={DRONE_TIME:8,DRONE_RANGE:16,DRONE_DIST:12,DRONE_ALT:2.6,DROP_OPEN:1.5,DROP_DELAY:25,DROP_FFA:75,HOLO_TIME:8,DASH_CD:5,PLANT_TIME:3.2,DEFUSE_TIME:5,BOMB_TIME:40,ROUND_TIME:115,FREEZE_TIME:4,BUY_TIME:20,POST_TIME:5,MATCH_END_TIME:9,MATCH_WIN:7,EYE:1.7,
  FFA_KILLS:30,FFA_TIME:600,RESPAWN:3,MAX_BOMB:10,MAX_FFA:12,MAX_TEAM:5,NADE_R:7.5,BOMB_R:22,NR:0.11,
  START_MONEY:800,MAX_MONEY:16000,WIN_MONEY:3250,LOSS_MONEY:1400,LOSS_STEP:500,PLANT_MONEY:300};

// Боевые параметры оружия (внешний вид и анимации — в браузере)
// slot: p — основное, s — пистолет, k — нож; pierce — сколько человек пробивает пуля, mul — сколько урона остаётся после каждого
const WEAPONS=[
  {name:'АК-47',slot:'p',dmg:34,head:4,rate:0.1,pierce:2,mul:0.7,reward:300,price:2700},
  {name:'Пистолет',slot:'s',dmg:28,head:3.6,rate:0.16,pierce:1,mul:1,reward:300,price:0},
  {name:'Снайперка',slot:'p',sniper:true,dmg:115,head:2.5,rate:1.35,pierce:5,mul:1,reward:100,price:4750},
  {name:'Нож',slot:'k',knife:true,rate:0.35,reward:1500,price:0},
  {name:'ПП',slot:'p',dmg:24,head:3.5,rate:0.075,pierce:1,mul:1,reward:600,price:1250},
  {name:'Дробовик',slot:'p',pellets:8,dmg:17,head:2,rate:0.9,reward:900,price:1100},
  {name:'М4',slot:'p',dmg:30,head:4,rate:0.09,pierce:2,mul:0.7,reward:300,price:3100},
  {name:'Пулемёт',slot:'p',dmg:32,head:3.5,rate:0.08,pierce:3,mul:0.75,reward:300,price:5200},
  {name:'Револьвер',slot:'s',dmg:55,head:3,rate:0.42,pierce:2,mul:0.75,reward:300,price:700},
  {name:'Лёгкая снайперка',slot:'p',sniper:true,dmg:78,head:2.5,rate:1.15,pierce:2,mul:0.85,reward:300,price:1700},
  {name:'Автопистолет',slot:'s',dmg:18,head:3.5,rate:0.06,pierce:1,mul:1,reward:300,price:500},
  {name:'Автодробовик',slot:'p',pellets:7,dmg:15,head:2,rate:0.28,reward:600,price:3000},
  {name:'Винтовка с оптикой',slot:'p',dmg:30,head:4,rate:0.095,pierce:2,mul:0.7,reward:300,price:3300},
  {name:'Гранатомёт',slot:'p',rocket:true,rate:1.0,reward:200,price:6000},
  {name:'Золотой АК',slot:'p',special:true,dmg:45,head:4,rate:0.1,pierce:3,mul:0.8,reward:300,price:0}];
const GEAR={armor:650,kit:400,he:300,smoke:300,flash:200,holo:250,drone:300};
const NADE_MAX={he:1,smoke:1,flash:2,holo:1};
const NADE_FUSE={he:1.8,smoke:1.6,flash:1.4,holo:1.0};

// ---------- карты ----------
// Каждая карта описана функцией, которая вызывает a.box(...) и другие «кирпичики».
// Сервер собирает из этого только стены для попаданий и движения, браузер — ещё и красоту.
const SP_DUST=[[0,-34],[-10,-34],[10,-34],[-34,-12],[34,-12],[-17,-35],[17,-35],[24,-30],[-30,-35],[34,-35],[0,-27],[-36,-28]];
const MAPS={
  dust:{name:'Пыльный рубеж',ground:'sand',fog:0xe2cfa9,sky:['#5b8fc4','#a8c3d9','#ecd9b6'],sites:null,spawn:{T:{x:0,z:34},CT:{x:0,z:-34}},spawns:SP_DUST,
    build(a){
      a.box(0,-41,84,2,7,'wall'); a.box(0,41,84,2,7,'wall'); a.box(-41,0,2,84,7,'wall'); a.box(41,0,2,84,7,'wall');
      a.box(-8,-9,1.2,10,5,'wall'); a.box(-8,9,1.2,10,5,'wall'); a.box(8,-9,1.2,10,5,'wall'); a.box(8,9,1.2,10,5,'wall');
      a.box(0,0,4,4,3,'stone');
      a.box(-24,-14,16,1.2,5,'wall'); a.box(24,14,16,1.2,5,'wall'); a.box(24,-18,10,1.2,5,'wall'); a.box(-24,18,10,1.2,5,'wall');
      a.box(-26,-24,10,1.2,5,'wall'); a.box(-21,-29,1.2,9,5,'wall'); a.box(26,24,10,1.2,5,'wall'); a.box(21,29,1.2,9,5,'wall');
      [[-20,4],[20,-4],[0,-22],[0,22]].forEach(p=>a.box(p[0],p[1],2,2,5,'stone'));
      [[-4,-20],[4,20],[-12,10],[12,-10],[5,-6],[-5,6],[-33,4],[33,-4],[-30,-8],[30,8],[-16,26],[16,-26],[-2,30],[2,-30],[-26,-34],[26,34]].forEach(p=>a.crate(p[0],p[1]));
      [[-14,-30],[14,30],[-30,30],[30,-30],[-34,-20],[34,20]].forEach(p=>a.crate(p[0],p[1],true));
      [[-13,-28.4],[13,28.4],[-28.4,8.6]].forEach(p=>a.box(p[0],p[1],1.4,1.4,1.4,'crate'));
    }},
  port:{name:'Порт',ground:'concrete',fog:0xc6c9c8,sky:['#6c8db0','#b4c4d2','#d9dcd8'],sites:{A:{x:-26,z:-22},B:{x:26,z:-22}},spawn:{T:{x:0,z:34},CT:{x:0,z:-34}},
    spawns:[[0,-34],[-10,-34],[10,-34],[-30,-34],[30,-34],[-36,-12],[36,-12],[-20,-36],[20,-36],[0,-24],[-24,-4],[24,-4]],
    build(a){
      a.box(0,-41,84,2,7,'brick'); a.box(0,41,84,2,7,'brick'); a.box(-41,0,2,84,7,'brick'); a.box(41,0,2,84,7,'brick');
      a.box(-14,14.3,1.2,23.4,5,'brick'); a.box(14,14.3,1.2,23.4,5,'brick'); a.box(0,16,8,8,6,'stone');
      a.box(-36,2,8,1.2,5,'brick'); a.box(-19,2,10,1.2,5,'brick'); a.box(-9,2,10,1.2,5,'brick');
      a.box(9,2,10,1.2,5,'brick'); a.box(19,2,10,1.2,5,'brick'); a.box(36,2,8,1.2,5,'brick');
      a.box(-10,-16,1.2,20,5,'brick'); a.box(10,-16,1.2,20,5,'brick'); a.box(0,-12,3,3,2.2,'stone');
      a.box(-33,-24,2.45,6.1,2.6,'cont_blue'); a.box(-24,-13,6.1,2.45,2.6,'cont_red'); a.crate(-19,-27); a.crate(-28,-31,true); a.crate(-17,-19);
      a.box(33,-24,2.45,6.1,2.6,'cont_orange'); a.box(24,-13,6.1,2.45,2.6,'cont_blue'); a.crate(19,-27); a.crate(28,-31,true); a.crate(17,-19);
      a.box(-27,14,2.45,6.1,2.6,'cont_green'); a.crate(-34,22); a.crate(-22,24,true);
      a.box(27,12,2.45,6.1,2.6,'cont_red'); a.crate(34,20); a.crate(22,22,true);
      a.crate(-8,8); a.crate(8,24); a.crate(-6,-28); a.crate(6,-28); a.crate(-36,-8); a.crate(36,-8);
      a.site('A',-26,-22); a.site('B',26,-22);
    }},
  winter:{name:'Зимовье',ground:'snow',fog:0xdbe3ea,sky:['#8fa8c2','#c9d6e2','#eef2f5'],sun:0xdfe9ff,sites:{A:{x:-26,z:-24},B:{x:24,z:-24}},spawn:{T:{x:0,z:34},CT:{x:0,z:-35}},
    spawns:[[0,-36],[-8,-36],[8,-36],[-30,-36],[30,-36],[-38,-4],[38,-4],[20,-36],[-12,-16],[34,-14],[14,-20],[-2,-6]],
    build(a){
      a.box(0,-41,84,2,6,'log'); a.box(0,41,84,2,6,'log'); a.box(-41,0,2,84,6,'log'); a.box(41,0,2,84,6,'log');
      a.decor('ice',0,1,80,6);
      for(const z of [-2,4]) for(const [x,w] of [[-36.5,7],[-15,24],[14,22],[35.5,9]]) a.box(x,z,w,0.4,1.1,'log');
      for(const x of [-30,0,28]) a.decor('planks',x,1);
      a.box(-26,-31,20,0.8,4,'log'); a.box(-36,-24,0.8,14,4,'log'); a.box(-33,-17,6,0.8,4,'log'); a.box(-19,-17,6,0.8,4,'log');
      a.box(-16,-28.5,0.8,5,4,'log'); a.box(-16,-19,0.8,4,4,'log'); a.crate(-31,-27); a.crate(-21,-28,true); a.crate(-33,-20);
      a.box(24,-32,16,1,1.2,'stone'); a.box(32,-27,1,10,1.2,'stone'); a.box(27,-19,3,1.2,1.2,'log');
      a.crate(28,-28); a.crate(20,-21); a.pine(18,-30,1.1); a.pine(30,-17,1); a.pine(16,-17,0.9);
      a.cabin(0,-14,8,6,4); a.cabin(-6,-26,6,5,3.5); a.box(8,-8,2,2,1,'stone');
      [[-38,-12,1],[12,-36,1.1],[36,-36,1.2],[-12,-36,1],[38,-8,0.9],[-10,-8,1],[20,-10,1.1]].forEach(p=>a.pine(p[0],p[1],p[2]));
      a.cabin(-24,20,8,7,4); a.cabin(22,18,7,8,4); a.cabin(0,22,6,6,3.5); a.cabin(-8,30,4,3,3);
      a.crate(12,30,true); a.crate(-30,10); a.box(-34,10,3,1.2,1.2,'log'); a.box(34,10,3,1.2,1.2,'log'); a.crate(30,30);
      [[-36,30,1.2],[36,32,1.1],[-14,12,1],[14,12,0.9],[-30,36,1],[30,24,1],[8,8,0.8],[-38,-30,1]].forEach(p=>a.pine(p[0],p[1],p[2]));
      a.site('A',-26,-24); a.site('B',24,-24); a.decor('snow');
    }},
  factory:{name:'Завод',ground:'asphalt',fog:0x6f5f73,sky:['#2c2847','#7a5a7a','#f0a46a'],sun:0xff9a5a,sunI:0.6,hemi:[0xc9b7d9,0x4a3b3b,0.55],
    sites:{A:{x:-27,z:-24},B:{x:26,z:-25}},spawn:{T:{x:0,z:34},CT:{x:0,z:-35}},
    spawns:[[0,-35],[-8,-36],[8,-36],[-30,-36],[30,-36],[-38,-10],[38,-10],[-20,-34],[24,-37],[0,-24],[-25,-8],[25,-8]],
    build(a){
      a.box(0,-41,84,2,7,'metal'); a.box(0,41,84,2,7,'metal'); a.box(-41,0,2,84,7,'metal'); a.box(41,0,2,84,7,'metal');
      for(const x of [-10,10]){ a.box(x,-7,0.8,10,5,'metal'); a.box(x,7,0.8,10,5,'metal'); }
      for(const z of [-12,12]){ a.box(-6,z,8,0.8,5,'metal'); a.box(6,z,8,0.8,5,'metal'); }
      a.box(0,0,6,1.5,1.2,'metal'); a.crate(-5,5); a.crate(5,-5,true);
      a.box(-28,14,14,10,6,'metal'); a.box(28,16,12,12,6,'metal');
      a.box(-34,-24,1,8,1.4,'metal'); a.box(-27,-31,10,1,1.4,'metal'); a.box(-21,-19,2,3,2,'crate'); a.crate(-31,-19); a.crate(-24,-29);
      a.silo(33,-31); a.silo(33,-19); a.silo(19,-32); a.crate(24,-18); a.crate(29,-27);
      a.box(-15,-23,0.8,14,5,'metal'); a.box(15,-23,0.8,14,5,'metal');
      a.crate(-6,-28); a.crate(6,-28,true); a.crate(-6,28); a.crate(8,26,true); a.crate(-36,-2); a.crate(36,2); a.crate(-18,30); a.crate(20,30);
      a.decor('pipes');
      for(const [x,z] of [[-22,-22],[22,-22],[0,-16],[0,20],[-30,26]]) a.lamp(x,z);
      a.site('A',-27,-24); a.site('B',26,-25);
    }},
  city:{name:'Ночной город',ground:'asphalt',fog:0x111522,sky:['#05070f','#141a33','#2a2440'],sun:0x8899ff,sunI:0.35,hemi:[0x3a4a7a,0x101018,0.55],
    sites:{A:{x:-24,z:-26},B:{x:24,z:-26}},spawn:{T:{x:0,z:35},CT:{x:0,z:-36}},
    spawns:[[0,-36],[-10,-36],[10,-36],[-30,-36],[30,-36],[-38,-14],[38,-14],[-16,-30],[16,-35],[0,-13],[-20,-10],[20,-10]],
    build(a){
      a.box(0,-41,84,2,12,'building'); a.box(0,41,84,2,12,'building'); a.box(-41,0,2,84,12,'building'); a.box(41,0,2,84,12,'building');
      a.box(-24,20,20,18,12,'building'); a.box(24,20,20,18,10,'building'); a.box(0,-22,12,10,14,'building');
      a.box(-30,-4,12,8,9,'building'); a.box(30,-4,12,8,9,'building'); a.box(-8,6,3,2,2.5,'metal'); a.box(8,-6,3,2,2.5,'metal');
      a.car(-16,-6,false,'car_red'); a.car(14,4,true,'car_blue'); a.car(-18,-22,true,'car_white'); a.car(19,-31,false,'car_yellow');
      a.car(29,-31,false,'car_red'); a.car(24,-19,true,'car_white'); a.car(0,30,true,'car_yellow'); a.car(-4,-10,true,'car_blue');
      a.box(-30,-30,3,3,1.2,'stone'); a.decor('fountain',-30,-30);
      a.crate(-28,-20); a.crate(-20,-30); a.box(31,-22,2,1.5,1.5,'metal'); a.crate(-6,32); a.crate(6,26,true); a.crate(-36,8); a.crate(36,8,true);
      a.sign('КАФЕ','#ff4fb0',-24,6,10.9,Math.PI,6); a.sign('24/7','#3ff0ff',24,5,10.9,Math.PI,5); a.sign('ОТЕЛЬ','#ffd84a',0,9,-16.9,0,7);
      a.sign('КИНО','#b06bff',-23.9,5,-4,Math.PI/2,5); a.sign('БАР','#6bff8a',23.9,5,-4,-Math.PI/2,4);
      a.lamp(-12,-12,0x9fc4ff); a.lamp(12,-12,0x9fc4ff); a.lamp(0,10,0x9fc4ff); a.lamp(-17,-31,0xffb36b); a.lamp(30,-25,0xffb36b); a.lamp(-12,26,0x9fc4ff);
      a.site('A',-24,-26); a.site('B',24,-26);
    }}};
for(const k in MAPS){ const m=MAPS[k]; m.ffa=m.spawns.concat(m.spawns.map(([x,z])=>[x,-z])); }

// Собирает карту: hooks (необязательно) получают всё, что нужно нарисовать в браузере
function buildMap(id,hooks){ const h=hooks||{}, boxes=[];
  const box=(x,z,w,d,hh,kind,y0)=>{ y0=y0||0; boxes.push([x,z,w,d,hh,kind,y0]); if(h.box) h.box(x,z,w,d,hh,kind,y0); };
  const a={box,
    crate:(x,z,stack)=>{ box(x,z,2,2,2,'crate'); if(stack) box(x,z,2,2,2,'crate',2); },
    pine:(x,z,s)=>{ box(x,z,0.5,0.5,2,'log'); if(h.pine) h.pine(x,z,s); },
    cabin:(x,z,w,d,hh)=>{ box(x,z,w,d,hh,'log'); if(h.roof) h.roof(x,z,w,d,hh); },
    silo:(x,z)=>{ box(x,z,3.4,3.4,9,'metal'); if(h.silo) h.silo(x,z); },
    lamp:(x,z,col)=>{ box(x,z,0.3,0.3,5,'metal'); if(h.lamp) h.lamp(x,z,col); },
    car:(x,z,ax,kind)=>{ box(x,z,ax?4.2:1.9,ax?1.9:4.2,1.1,kind); box(x+(ax?-0.2:0),z+(ax?0:-0.2),ax?2.2:1.7,ax?1.7:2.2,0.7,'glass',1.1); },
    sign:(...args)=>{ if(h.sign) h.sign(...args); },
    site:(...args)=>{ if(h.site) h.site(...args); },
    decor:(...args)=>{ if(h.decor) h.decor(...args); }};
  MAPS[id].build(a);
  return {boxes,solids:buildSolids(boxes),boxes3:buildBoxes(boxes)}; }
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function buildSolids(B){ const s=[];
  for(const [x,z,w,d,h,,y0] of B){
    if(y0<0.5) s.push({minX:x-w/2,maxX:x+w/2,minZ:z-d/2,maxZ:z+d/2,top:y0+h});
    else for(const o of s) if(Math.abs((o.minX+o.maxX)/2-x)<0.01&&Math.abs((o.minZ+o.maxZ)/2-z)<0.01) o.top=Math.max(o.top,y0+h); }
  return s; }
function buildBoxes(B){ return B.map(([x,z,w,d,h,,y0])=>({minX:x-w/2,maxX:x+w/2,minY:y0,maxY:y0+h,minZ:z-d/2,maxZ:z+d/2})); }
function collide(p,r,solids){
  for(let it=0;it<2;it++) for(const b of solids){
    const cx=clamp(p.x,b.minX,b.maxX), cz=clamp(p.z,b.minZ,b.maxZ), dx=p.x-cx, dz=p.z-cz, d2=dx*dx+dz*dz;
    if(d2<r*r){
      if(d2>1e-8){ const d=Math.sqrt(d2); p.x=cx+dx/d*r; p.z=cz+dz/d*r; }
      else { const l=p.x-b.minX, rr=b.maxX-p.x, t=p.z-b.minZ, bt=b.maxZ-p.z, m=Math.min(l,rr,t,bt);
        if(m===l)p.x=b.minX-r; else if(m===rr)p.x=b.maxX+r; else if(m===t)p.z=b.minZ-r; else p.z=b.maxZ+r; } } } }
function clampMap(p){ p.x=clamp(p.x,-39.5,39.5); p.z=clamp(p.z,-39.5,39.5); }
function segBlocked(ax,ay,az,bx,by,bz,boxes){
  const d=[bx-ax,by-ay,bz-az], o=[ax,ay,az];
  outer: for(const b of boxes){
    const mn=[b.minX,b.minY,b.minZ], mx=[b.maxX,b.maxY,b.maxZ]; let t0=0.002,t1=0.998;
    for(let i=0;i<3;i++){
      if(Math.abs(d[i])<1e-9){ if(o[i]<mn[i]||o[i]>mx[i]) continue outer; }
      else { let u=(mn[i]-o[i])/d[i], v=(mx[i]-o[i])/d[i]; if(u>v){ const q=u; u=v; v=q; } t0=Math.max(t0,u); t1=Math.min(t1,v); if(t0>t1) continue outer; } }
    return true; }
  return false; }
function pointHit(p,solids,R){ R=R||C.NR; for(const b of solids) if(p.x>b.minX-R&&p.x<b.maxX+R&&p.z>b.minZ-R&&p.z<b.maxZ+R&&p.y-R<b.top) return true; return false; }
function nadeStep(n,dt,solids){ const p=n.p, v=n.v, R=C.NR; let bounced=false;
  v.y-=16*dt;
  for(let s=0;s<3;s++){ const h=dt/3;
    const ox=p.x; p.x+=v.x*h; if(pointHit(p,solids)){ p.x=ox; v.x*=-0.45; }
    const oz=p.z; p.z+=v.z*h; if(pointHit(p,solids)){ p.z=oz; v.z*=-0.45; }
    const oy=p.y; p.y+=v.y*h;
    if(p.y<R||pointHit(p,solids)){ if(p.y<R) p.y=R; else p.y=oy; if(v.y<-2.5) bounced=true; if(v.y<0){ v.x*=0.7; v.z*=0.7; } v.y*=-0.35; if(Math.abs(v.y)<0.6) v.y=0; } }
  if(v.y===0){ const fr=1-Math.min(1,dt*3); v.x*=fr; v.z*=fr; }
  clampMap(p); return bounced; }
function siteAt(map,x,z,r){ const S=MAPS[map].sites; if(!S) return null; for(const k in S) if(Math.hypot(S[k].x-x,S[k].z-z)<(r||5)) return k; return null; }

Object.assign(G,{C,WEAPONS,GEAR,NADE_MAX,NADE_FUSE,MAPS,buildMap,clamp,collide,clampMap,segBlocked,pointHit,nadeStep,siteAt});
})(typeof module!=='undefined'&&module.exports?module.exports:(window.GD={}));
