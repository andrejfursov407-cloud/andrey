const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {WebSocketServer}=require('ws');
const PORT=process.env.PORT||3000,HOST=process.env.HOST||'0.0.0.0',PUB=path.join(__dirname,'public');
const DBF=process.env.DB||path.join(__dirname,'data','db.json');
fs.mkdirSync(path.dirname(DBF),{recursive:true});
let db={users:{},chats:{},msgs:[],stories:[]};try{db=JSON.parse(fs.readFileSync(DBF))}catch{}
let tm;const save=()=>{clearTimeout(tm);tm=setTimeout(()=>fs.writeFileSync(DBF,JSON.stringify(db)),300)};
const MIME={'.html':'text/html;charset=utf-8','.js':'text/javascript','.json':'application/json','.png':'image/png','.crt':'application/x-x509-ca-cert','.webmanifest':'application/manifest+json'};
const app=(q,r)=>{let p=q.url.split('?')[0];if(p=='/')p='/index.html';const f=path.join(PUB,path.normalize(p));
if(!f.startsWith(PUB)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){r.writeHead(404);return r.end()}
r.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(self), microphone=(self)'});fs.createReadStream(f).pipe(r)};
const CD=process.env.CERT_DIR||path.join(__dirname,'data','certs'),tls=fs.existsSync(CD+'/fullchain.pem')&&fs.existsSync(CD+'/privkey.pem');
const srv=tls?require('https').createServer({cert:fs.readFileSync(CD+'/fullchain.pem'),key:fs.readFileSync(CD+'/privkey.pem')},app):http.createServer(app);
if(tls)http.createServer((q,r)=>{if(q.url.startsWith('/.well-known/')||q.url=='/ca.crt')return app(q,r);r.writeHead(301,{Location:'https://'+(q.headers.host||'').split(':')[0]+q.url});r.end()}).listen(process.env.HTTP_PORT||80,HOST);
const wss=new WebSocketServer({server:srv,path:'/ws',maxPayload:8e6});
const on=new Map(),norm=s=>{let d=String(s||'').replace(/\D/g,'');if(d.length==11&&d[0]=='8')d='7'+d.slice(1);return d};
const hash=(p,s)=>crypto.scryptSync(String(p),s,64).toString('hex');
const eq=(a,b)=>!!a&&!!b&&a.length==b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
const send=(w,o)=>w.readyState==1&&w.send(JSON.stringify(o));
const to=(p,o)=>(on.get(p)||[]).forEach(w=>send(w,o));
const mine=p=>Object.values(db.chats).filter(c=>c.m.includes(p));
const rl=new Map();const lim=(k,max,win)=>{const a=(rl.get(k)||[]).filter(t=>t>Date.now()-win);rl.set(k,a);if(a.length>=max)return true;a.push(Date.now());return false};
const TS=process.env.TURN_SECRET;
const ice=req=>{const l=[{urls:'stun:stun.l.google.com:19302'}];if(TS){const h=String(req.headers.host||'').split(':')[0],u=(Math.floor(Date.now()/1e3)+86400)+':a';
l.unshift({urls:['turn:'+h+':3478?transport=udp','turn:'+h+':3478?transport=tcp'],username:u,credential:crypto.createHmac('sha1',TS).update(u).digest('base64')})}return l};
wss.on('connection',(ws,req)=>{let me=null,tries=0;
ws.on('message',d=>{let m;try{m=JSON.parse(d)}catch{return}
const rep=o=>send(ws,{...o,r:m.r});
if(!me){
 if(++tries>8)return ws.close();
 if(lim('a'+req.socket.remoteAddress,30,9e5))return rep({err:'Слишком много попыток, подождите'});
 const ph=norm(m.phone);let u=db.users[ph],tok;
 if(m.t=='reg'){
  if(!/^\d{10,15}$/.test(ph)||String(m.pass||'').length<8||!m.pub)return rep({err:'Неверный номер или пароль короче 8 символов'});
  if(lim('r'+req.socket.remoteAddress,10,36e5))return rep({err:'Слишком много регистраций'});
  if(u)return rep({err:'Номер уже зарегистрирован'});
  const salt=crypto.randomBytes(16).toString('hex');u=db.users[ph]={salt,hash:hash(m.pass,salt),pub:m.pub};
 }else if(m.t=='login'){
  if(!u||!eq(u.hash,hash(m.pass,u.salt)))return rep({err:'Неверный номер или пароль'});u.pub=m.pub||u.pub;
 }else if(m.t=='tok'){
  if(!u||!eq(u.tk,hash(m.tok,'t')))return rep({err:'expired'});
 }else return;
 if(m.t!='tok'){tok=crypto.randomBytes(24).toString('hex');u.tk=hash(tok,'t')}
 me=ph;if(!on.has(me))on.set(me,new Set());on.get(me).add(ws);save();
 const cs=mine(me),ids=new Set(cs.map(c=>c.id)),pubs={};cs.forEach(c=>c.m.forEach(p=>pubs[p]=db.users[p].pub));pubs[me]=u.pub;
 return rep({ok:1,phone:me,tok,ice:ice(req),sync:{chats:cs,msgs:db.msgs.filter(x=>ids.has(x.c)),stories:db.stories.filter(s=>s.to.includes(me)),pubs}});
}
if(m.t=='search'){const p=norm(m.phone),u=db.users[p];return rep(u?{phone:p,pub:u.pub}:{none:1})}
if(m.t=='pubs'){const o={};(m.p||[]).slice(0,100).forEach(p=>db.users[p]&&(o[p]=db.users[p].pub));return rep({map:o})}
if(m.t=='mk'){
 const mem=[...new Set([me,...(m.m||[]).map(norm)])];
 if(mem.length<2||mem.length>200||mem.some(p=>!db.users[p]))return rep({err:1});
 const g=mem.length>2||!!m.name,id=g?crypto.randomUUID():[...mem].sort().join('-');
 if(!db.chats[id]){const c=db.chats[id]={id,m:mem,n:g?String(m.name||'Группа').slice(0,50):null};save();
  const pb={};mem.forEach(p=>pb[p]=db.users[p].pub);mem.forEach(p=>to(p,{t:'chat',c,pubs:pb}))}
 return rep({id});
}
if(m.t=='send'){const c=db.chats[m.c];if(!c||!c.m.includes(me)||!m.e)return;
 const x={id:crypto.randomUUID(),c:c.id,f:me,ts:Date.now(),e:m.e};db.msgs.push(x);save();c.m.forEach(p=>to(p,{t:'msg',x}))}
if(m.t=='story'){const al=new Set([me]);mine(me).forEach(c=>c.m.forEach(p=>al.add(p)));
 const tt=(m.to||[]).filter(p=>al.has(p));if(!m.e||!tt.length)return;
 const x={id:crypto.randomUUID(),f:me,ts:Date.now(),e:m.e,to:tt};db.stories.push(x);save();tt.forEach(p=>to(p,{t:'story',x}))}
if(m.t=='del'){const i=db.msgs.findIndex(x=>x.id==m.id&&x.f==me);if(i<0)return;const c=db.chats[db.msgs[i].c];db.msgs.splice(i,1);save();c.m.forEach(p=>to(p,{t:'del',id:m.id}))}
if(m.t=='leave'){const c=db.chats[m.c];if(!c||!c.m.includes(me)||!c.n)return;c.m=c.m.filter(p=>p!=me);to(me,{t:'gone',id:c.id});
 if(!c.m.length){delete db.chats[c.id];db.msgs=db.msgs.filter(x=>x.c!=c.id)}else{const pb={};c.m.forEach(p=>pb[p]=db.users[p].pub);c.m.forEach(p=>to(p,{t:'chat',c,pubs:pb}))}save()}
if(m.t=='add'){const c=db.chats[m.c];if(!c||!c.m.includes(me)||!c.n)return rep({err:1});const n=[...new Set((m.m||[]).map(norm))].filter(p=>db.users[p]&&!c.m.includes(p));
 if(!n.length||c.m.length+n.length>200)return rep({err:1});c.m.push(...n);const pb={};c.m.forEach(p=>pb[p]=db.users[p].pub);c.m.forEach(p=>to(p,{t:'chat',c,pubs:pb}));save();return rep({ok:1})}
if(m.t=='logout'){db.users[me].tk=null;save()}
if(m.t=='sig'&&m.to)to(norm(m.to),{t:'sig',from:me,d:m.d});
});
ws.on('close',()=>me&&on.get(me)&&on.get(me).delete(ws));
});
setInterval(()=>{db.stories=db.stories.filter(s=>s.ts>Date.now()-864e5);save()},36e5);
const LP=tls?PORT:(process.env.HTTP_PORT||PORT);srv.listen(LP,HOST,()=>console.log('Андрей: '+(tls?'https':'http')+' порт '+LP));
