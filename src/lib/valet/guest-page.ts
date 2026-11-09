/**
 * VALET guest pass page — served by src/app/valet-pass/route.ts as one
 * self-contained HTML document (the /menu pattern): no React shell, so none of
 * the staff app's pollers run for a guest, and it loads fast on a weak phone.
 *
 * Security: every dynamic string is written with textContent (never innerHTML
 * with data); the inline script carries a per-response nonce under a strict
 * CSP; the route sends noindex + no-store + no-referrer. Tokens in the URL
 * (?a=) are removed from the address bar as soon as they are used.
 */
import { STRINGS, type Lang } from './i18n';

export interface GuestPageInput {
  nonce: string;
  lang: Lang;
  entry: string;        // public venue entry token (?e=), may be ''
  venueName: string;    // from the entry token when present
  businessName: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderGuestPage(i: GuestPageInput): string {
  const boot = JSON.stringify({ strings: STRINGS, lang: i.lang, entry: i.entry, venue: i.venueName, business: i.businessName })
    .replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="${i.lang}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#af4408">
<title>${esc(i.venueName || i.businessName || 'Valet')} · Valet</title>
<style>
:root{--bg:#FFF8F0;--panel:#fff;--soft:#FFF1E3;--ink:#2D1B0E;--ink2:#6B5744;--mute:#8B7355;--line:#E8D5C4;--acc:#af4408;--ok:#166534;--okbg:#DCFCE7;--warn:#92400E;--warnbg:#FEF3C7;--bad:#991B1B;--badbg:#FEE2E2}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans Devanagari",sans-serif}
header{display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
header img{width:36px;height:36px;border-radius:8px;object-fit:contain}
header .v{flex:1;min-width:0}header .v b{display:block;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}header .v span{font-size:12px;color:var(--mute)}
button{font:inherit;cursor:pointer}
.lang{border:1px solid var(--line);background:var(--soft);color:var(--ink);border-radius:999px;padding:6px 12px;font-size:14px;min-height:40px}
main{max-width:520px;margin:0 auto;padding:16px 16px 96px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:14px;box-shadow:0 1px 2px rgba(45,27,14,.05)}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px}
.tag{font-size:13px;color:var(--mute);text-transform:uppercase;letter-spacing:.08em}
.tagno{font-size:40px;font-weight:800;letter-spacing:.04em;line-height:1}
.veh{font-size:15px;color:var(--ink2)}
.pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:6px 12px;font-size:14px;font-weight:600}
.p-ok{background:var(--okbg);color:var(--ok)}.p-warn{background:var(--warnbg);color:var(--warn)}.p-info{background:var(--soft);color:var(--acc)}.p-bad{background:var(--badbg);color:var(--bad)}
h1{font-size:22px;margin:0 0 6px}h2{font-size:18px;margin:0 0 10px}p{margin:6px 0}.mute{color:var(--mute);font-size:14px}
.btn{display:block;width:100%;min-height:52px;border-radius:12px;border:0;background:var(--acc);color:#fff;font-weight:700;font-size:17px;margin-top:10px}
.btn2{display:block;width:100%;min-height:48px;border-radius:12px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font-weight:600;font-size:16px;margin-top:10px}
.btn:disabled,.btn2:disabled{opacity:.55}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.grid .btn,.grid .btn2{margin-top:0}
.big{font-size:44px;font-weight:800;letter-spacing:.12em;text-align:center;margin:8px 0;font-variant-numeric:tabular-nums}
.eta{font-size:26px;font-weight:800}
label{display:block;font-size:14px;color:var(--ink2);margin:10px 0 4px}
input,select{width:100%;min-height:48px;border:1px solid var(--line);border-radius:10px;padding:10px 12px;font:inherit;background:#fff;color:var(--ink)}
input:focus,select:focus,button:focus-visible{outline:3px solid #f5b48a;outline-offset:2px}
.err{background:var(--badbg);color:var(--bad);border-radius:10px;padding:10px 12px;margin:10px 0;font-size:15px}
.note{background:var(--soft);border-radius:10px;padding:10px 12px;margin:10px 0;font-size:15px}
#net{position:fixed;left:0;right:0;bottom:0;padding:10px 16px;background:var(--ink);color:#fff;font-size:14px;text-align:center;display:none}
.help{position:fixed;right:16px;bottom:16px;border-radius:999px;border:1px solid var(--line);background:var(--panel);padding:12px 16px;font-weight:600;min-height:48px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
a{color:var(--acc)}
</style></head>
<body>
<header><img src="/akan-logo.png" alt=""><div class="v"><b id="venue"></b><span id="sub"></span></div><button class="lang" id="langbtn" type="button"></button></header>
<main id="app" aria-live="polite"></main>
<div id="net" role="status"></div>
<script nonce="${i.nonce}">
(function(){
"use strict";
var B=${boot};
var L=localStorage.getItem('fnb_vp_lang')||B.lang||'en';
var S={data:null,sel:null,code:null,codeExp:null,lastOk:null,busy:false,err:'',info:'',entryInfo:null,lastStates:{},done:false};
var q=new URLSearchParams(location.search);var ENTRY=q.get('e')||B.entry||'';var ACT=q.get('a')||'';
function T(k,v){var s=(B.strings[L]&&B.strings[L][k])||B.strings.en[k]||k;if(v)for(var n in v)s=s.replace('{'+n+'}',v[n]);return s}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=String(text);return e}
function fmtTime(iso){try{return new Date(iso).toLocaleTimeString(L==='hi'?'hi-IN':'en-IN',{hour:'numeric',minute:'2-digit',timeZone:'Asia/Kolkata'})}catch(_){return ''}}
function secsLeft(iso){return Math.max(0,Math.round((Date.parse(iso)-Date.now())/1000))}
function mmss(s){return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
function api(path,body){return fetch(path,body?{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-valet-guest':'1'},body:JSON.stringify(body)}:{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){if(!r.ok){var e=new Error(j.error||T('err_generic'));e.status=r.status;throw e}return j})})}
function act(cmd,extra){if(S.busy)return Promise.resolve();S.busy=true;S.err='';render();var b=Object.assign({cmd:cmd},extra||{});return api('/api/valet-guest/act',b).then(function(j){S.busy=false;return poll().then(function(){return j})}).catch(function(e){S.busy=false;S.err=e.message;render()})}
function setNet(){var n=document.getElementById('net');if(S.offline){n.style.display='block';n.textContent=T('offline')+(S.lastOk?' '+T('updated')+' '+fmtTime(S.lastOk):'')}else n.style.display='none'}
function poll(){return api('/api/valet-guest/state').then(function(d){S.offline=false;S.lastOk=new Date().toISOString();var prev=S.data;S.data=d;
  if(prev&&prev.passes){prev.passes.forEach(function(p){var still=d.passes.some(function(x){return x.session_id===p.session_id});if(!still&&(p.state==='READY_AT_GATE'))S.done=true})}
  if(S.sel&&!d.passes.some(function(p){return p.session_id===S.sel}))S.sel=null;
  if(d.lang&&!localStorage.getItem('fnb_vp_lang')){L=d.lang}
  render()}).catch(function(e){S.offline=true;setNet();if(!S.data)render()})}
function pass(){var ps=(S.data&&S.data.passes)||[];if(ps.length===1)return ps[0];return ps.find(function(p){return p.session_id===S.sel})||null}
var STATE_PILL={CHECKED_IN:'p-info',PARKING:'p-info',PARKED:'p-ok',RETRIEVING:'p-warn',READY_AT_GATE:'p-ok',RELOCATING:'p-warn',HOLDING_NEAR_GATE:'p-warn'};
var STATE_ICON={CHECKED_IN:'⟳',PARKING:'⟳',PARKED:'✓',RETRIEVING:'→',READY_AT_GATE:'★',RELOCATING:'↺',HOLDING_NEAR_GATE:'◷'};
var lastKey='';
function render(){
  // Redraw ONLY when something shown has changed. A blind redraw on every poll
  // wiped a half-typed check-in form and reset the time picker mid-choice.
  var key=JSON.stringify([L,S.err,S.info,S.busy,S.sel,S.done,S.offline,S.code,S.codeFor,S.entryInfo,S.data]);
  if(key===lastKey){setNet();return}lastKey=key;
  document.documentElement.lang=L;document.getElementById('langbtn').textContent=T('lang');
  var app=document.getElementById('app');app.textContent='';setNet();
  var ps=(S.data&&S.data.passes)||[];var p=pass();
  document.getElementById('venue').textContent=(p&&p.venue_name)||(S.entryInfo&&S.entryInfo.venue_name)||B.venue||B.business||'';
  document.getElementById('sub').textContent=T('title');
  if(S.err){app.appendChild(el('div','err',S.err))}
  if(S.done&&!ps.length){var d=el('div','card');d.appendChild(el('h1',null,T('done_title')));d.appendChild(el('p',null,T('done_body')));app.appendChild(d);return}
  if(!S.data&&!S.offline){app.appendChild(el('p','mute','…'));return}
  if(!ps.length){renderNoPass(app);return}
  if(ps.length>1&&!p){var c=el('div','card');c.appendChild(el('h2',null,T('choose_car')));c.appendChild(el('p','mute',T('select_car_note')));
    ps.forEach(function(x){var b=el('button','btn2');b.type='button';b.textContent=(x.tag_code?T('tag')+' '+x.tag_code+' · ':'')+(x.vehicle||x.plate_masked)+' · '+T('st_'+x.state);b.onclick=function(){S.sel=x.session_id;S.code=null;render()};c.appendChild(b)});app.appendChild(c);return}
  renderPass(app,p,ps.length>1);
}
function renderNoPass(app){
  var pd=S.data&&S.data.pending;
  if(pd&&pd.status==='pending'&&pd.pairing_code){var c=el('div','card');c.appendChild(el('h1',null,T('pair_title')));c.appendChild(el('div','big',pd.pairing_code));c.appendChild(el('p',null,T('pair_body')));
    var t=el('p','mute');t.id='pairExp';c.appendChild(t);app.appendChild(c);tick();return}
  if(pd&&pd.status==='expired')app.appendChild(el('div','note',T('pair_expired')));
  if(ENTRY&&S.entryInfo&&S.entryInfo.ok){if(!S.entryInfo.enabled){app.appendChild(el('div','note',T('venue_off')));return}renderCheckin(app);return}
  var c2=el('div','card');c2.appendChild(el('h2',null,T('no_pass')));c2.appendChild(el('p','mute',T('no_pass_body')));app.appendChild(c2);
}
function field(f,key,name,req,type,auto){var w=document.createDocumentFragment();var lb=el('label',null,T(key)+(req?' *':''));lb.htmlFor='f_'+name;w.appendChild(lb);var i=el('input');i.id='f_'+name;i.name=name;i.type=type||'text';i.autocomplete=auto||'off';if(req)i.required=true;if(name==='plate'){i.autocapitalize='characters';i.maxLength=16}else i.maxLength=60;
  S.form=S.form||{};i.value=S.form[name]||'';i.oninput=function(){S.form[name]=i.value};w.appendChild(i);f.appendChild(w)}
function renderCheckin(app){var r=(S.entryInfo&&S.entryInfo.required)||{};var c=el('div','card');c.appendChild(el('h1',null,T('checkin_title')));
  var f=el('form');field(f,'plate','plate',true);field(f,'make','make',!!r.make);field(f,'model','model',!!r.model);field(f,'colour','colour',!!r.colour);
  field(f,'name_opt','guest_name',!!r.guest_name,'text','name');field(f,'mobile_opt','guest_mobile',!!r.guest_mobile,'tel','tel');
  var b=el('button','btn',T('checkin_go'));b.type='submit';b.disabled=S.busy;f.appendChild(b);
  f.onsubmit=function(ev){ev.preventDefault();var fd=new FormData(f);var o={e:ENTRY};fd.forEach(function(v,k){o[k]=String(v)});act('checkin',o)};
  c.appendChild(f);app.appendChild(c)}
function renderPass(app,p,multi){
  if(multi){var back=el('button','btn2','← '+T('choose_car'));back.type='button';back.onclick=function(){S.sel=null;S.code=null;render()};app.appendChild(back)}
  var c=el('div','card');var top=el('div','row');var l=el('div');l.appendChild(el('div','tag',T('tag')));l.appendChild(el('div','tagno',p.tag_code||'—'));top.appendChild(l);
  var pill=el('span','pill '+(STATE_PILL[p.state]||'p-info'));pill.appendChild(el('span',null,STATE_ICON[p.state]||'•'));pill.appendChild(el('span',null,T('st_'+p.state)));pill.setAttribute('role','status');top.appendChild(pill);c.appendChild(top);
  c.appendChild(el('p','veh',[p.vehicle,p.plate_masked].filter(Boolean).join(' · ')));app.appendChild(c);
  var pk=p.pickup;
  if(p.state==='READY_AT_GATE'){var g=el('div','card');g.appendChild(el('h1',null,T('at_gate_title')));g.appendChild(el('p',null,T('gate')+': '+p.gate));
    if(p.dwell_deadline_at){var dw=el('p','mute');dw.id='dwell';dw.dataset.at=p.dwell_deadline_at;g.appendChild(dw)}
    renderCode(g,p);app.appendChild(g)}
  else if(pk){var r=el('div','card');r.appendChild(el('div','tag',T('request_sent')+' · '+fmtTime(pk.requested_at)));
    if(pk.scheduled&&pk.state==='SCHEDULED'){r.appendChild(el('div','eta',T('scheduled_for')+' '+fmtTime(pk.target_at)));r.appendChild(el('p','mute',T('target_note')))}
    else if(pk.eta){var e=pk.eta;
      if(e.note==='no_staff')r.appendChild(el('div','eta',T('waiting_staff')));
      else if(e.note==='any_moment')r.appendChild(el('div','eta',T('any_moment')));
      else if(e.note==='parking_not_finished')r.appendChild(el('p',null,T('parking_first')));
      else if(e.low_min!=null){r.appendChild(el('div','eta',T('eta')+' '+e.low_min+'–'+e.high_min+' '+T('minutes')));if(e.basis!=='recent'&&e.basis!=='override')r.appendChild(el('p','mute',T('estimate_note')))}
      if(e.ahead!=null&&e.ahead>0)r.appendChild(el('p',null,e.ahead===1?T('ahead_one'):T('ahead_n',{n:e.ahead})))}
    r.appendChild(el('p','mute',T('gate')+': '+p.gate));
    if(pk.change_pending)r.appendChild(el('div','note',T('cancel_pending')));else if(pk.change_declined)r.appendChild(el('div','note',T('change_declined')));
    if(pk.guest_outside)r.appendChild(el('p',null,'✓ '+T('outside_done')));
    else{var ob=el('button','btn',T('outside'));ob.type='button';ob.disabled=S.busy;ob.onclick=function(){act('outside',{session_id:p.session_id})};r.appendChild(ob)}
    if(p.can_show_code)renderCode(r,p);
    if(!pk.change_pending){var cb=el('button','btn2',T('cancel'));cb.type='button';cb.disabled=S.busy;cb.onclick=function(){act('cancel',{session_id:p.session_id})};r.appendChild(cb);
      if(pk.can_change)renderOptions(r,p,'reschedule')}
    app.appendChild(r)}
  else if(p.can_request){var h=el('div','card');if(p.state==='HOLDING_NEAR_GATE'){h.appendChild(el('h2',null,T('holding_title')));h.appendChild(el('p','mute',T('holding_body')))}else h.appendChild(el('h2',null,T('get_car')));
    renderOptions(h,p,'pickup');app.appendChild(h)}
  var hb=el('button','help',T('help'));hb.type='button';hb.onclick=function(){act('help',{session_id:p.session_id}).then(function(j){S.info=T('help_sent');render()})};app.appendChild(hb);
  if(S.info){app.appendChild(el('div','note',S.info))}
  if(p.help_phone){var a=el('a',null,T('call_venue')+' '+p.help_phone);a.href='tel:'+p.help_phone.replace(/[^\\d+]/g,'');var pp=el('p');pp.appendChild(a);app.appendChild(pp)}
}
function renderOptions(box,p,cmd){var o=p.options;if(cmd==='reschedule')box.appendChild(el('p','mute',T('reschedule')+':'));var g=el('div','grid');
  function add(key,when){var b=el('button',key==='now'?'btn':'btn2',T(key));b.type='button';b.disabled=S.busy;b.onclick=function(){act(cmd,{session_id:p.session_id,when:when,idempotency_key:cmd+':'+p.session_id+':'+when+':'+Math.floor(Date.now()/60000)})};g.appendChild(b)}
  if(cmd==='pickup'&&o.now)add('now','now');if(o.in5)add('in5','in5');if(o.in10)add('in10','in10');box.appendChild(g);
  if(o.later&&o.later.length){var lb=el('label',null,T('choose_time'));lb.htmlFor='later_'+cmd;box.appendChild(lb);var s=el('select');s.id='later_'+cmd;var z=el('option',null,T('later'));z.value='';s.appendChild(z);
    o.later.forEach(function(iso){var op=el('option',null,fmtTime(iso));op.value=iso;s.appendChild(op)});
    s.onchange=function(){if(s.value)act(cmd,{session_id:p.session_id,when:'at',at:s.value,idempotency_key:cmd+':'+p.session_id+':'+s.value})};box.appendChild(s);box.appendChild(el('p','mute',T('target_note')))}}
function renderCode(box,p){var w=el('div');w.style.marginTop='12px';w.appendChild(el('p',null,T('show_code')));var b=el('div','big',S.code&&S.codeFor===p.session_id?S.code:'······');b.id='hcode';w.appendChild(b);var m=el('p','mute');m.id='hexp';w.appendChild(m);box.appendChild(w);
  if(!S.code||S.codeFor!==p.session_id||secsLeft(S.codeExp)<15)fetchCode(p)}
var codeBusy=false;function fetchCode(p){if(codeBusy)return;codeBusy=true;api('/api/valet-guest/act',{cmd:'code',session_id:p.session_id}).then(function(j){codeBusy=false;S.code=j.code;S.codeExp=j.expires_at;S.codeFor=p.session_id;var h=document.getElementById('hcode');if(h)h.textContent=j.code}).catch(function(){codeBusy=false})}
function tick(){var e=document.getElementById('hexp');if(e&&S.codeExp){var s=secsLeft(S.codeExp);e.textContent=T('code_refresh')+' '+mmss(s);if(s<15){var p=pass();if(p&&p.can_show_code)fetchCode(p)}}
  var d=document.getElementById('dwell');if(d){d.textContent='⏱ '+mmss(secsLeft(d.dataset.at))}
  var pe=document.getElementById('pairExp');var pd=S.data&&S.data.pending;if(pe&&pd){var s2=secsLeft(pd.expires_at);pe.textContent=T('pair_expires')+' '+mmss(s2)}}
document.getElementById('langbtn').onclick=function(){L=L==='hi'?'en':'hi';try{localStorage.setItem('fnb_vp_lang',L)}catch(_){};if(S.data&&S.data.passes&&S.data.passes.length)api('/api/valet-guest/act',{cmd:'lang',lang:L}).catch(function(){});render()};
function start(){var p0=ENTRY?api('/api/valet-guest/entry?e='+encodeURIComponent(ENTRY)).then(function(j){S.entryInfo=j}).catch(function(){S.entryInfo={ok:false}}):Promise.resolve();
  var p1=ACT?api('/api/valet-guest/act',{cmd:'activate',a:ACT}).catch(function(e){S.err=e.message}).then(function(){history.replaceState(null,'','/valet-pass')}):Promise.resolve();
  Promise.all([p0,p1]).then(poll)}
start();setInterval(tick,1000);
var iv=setInterval(poll,5000);document.addEventListener('visibilitychange',function(){clearInterval(iv);iv=setInterval(poll,document.hidden?20000:5000);if(!document.hidden)poll()});
window.addEventListener('online',poll);
})();
</script>
</body></html>`;
}
