// Сервер push-уведомлений для «Карти тривог».
// Опрашивает источники тревог и шлёт Web Push тем, кто подписан на этот район.
const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const POLL = +process.env.POLL_MS || 20000;
const FILE = path.join(process.env.DATA_DIR || __dirname, 'subs.json');
const PUB = process.env.VAPID_PUBLIC, PRIV = process.env.VAPID_PRIVATE;
const UP = process.env.UPSTASH_REDIS_REST_URL, UT = process.env.UPSTASH_REDIS_REST_TOKEN;

const norm = s => {
  s = String(s || '').toLowerCase();
  if (s.includes('крим')) return 'крим';
  return s.replace(/територіальна громада|автономна республіка|область|район|обл\.|м\./g, '').replace(/[^а-яіїєґa-z0-9]/g, '');
};
const typeOf = t => { t = String(t || '').toLowerCase(); return t.startsWith('dist') || t === 'raion' ? 'district' : t.startsWith('comm') || t === 'hromada' ? 'community' : 'state'; };
const kindOf = t => { t = String(t || '').toLowerCase(); if (/chem|хім/.test(t)) return 'chem'; if (/nucl|radi|радіац/.test(t)) return 'rad'; if (/urban|street|fight|вулич/.test(t)) return 'street'; return null; };

function where(n) {
  if (n === 'м. Київ') return 'в м. Києві';
  if (/Крим/.test(n)) return 'в Автономній Республіці Крим';
  let m;
  if (m = n.match(/^(.+) район$/)) {
    if (/ий$/.test(m[1])) return 'в ' + m[1].replace(/ий$/, 'ому') + ' районі';
    if (/ій$/.test(m[1])) return 'в ' + m[1].replace(/ій$/, 'ьому') + ' районі';
  }
  if (m = n.match(/^(.+) область$/)) { if (/а$/.test(m[1])) return 'в ' + m[1].replace(/а$/, 'ій') + ' області'; }
  if (m = n.match(/^(.+) територіальна громада$/)) {
    const ws = m[1].split(' '), cj = w => /^(та|і|й)$/i.test(w);
    if (ws.every(w => cj(w) || (!/^м\./.test(w) && /(ька|ична|ова|на)$/.test(w)))) return 'в ' + ws.map(w => cj(w) ? w : w.replace(/а$/, 'ій')).join(' ') + ' територіальній громаді';
  }
  return '— ' + n;
}
const OK = { street: 'вуличні бої', chem: 'хімічна небезпека', rad: 'радіаційна небезпека' };
const MSG = {
  yellow: n => '🟡 Увага! повітряна тривога (жовтий рівень, загроза БпЛА) ' + where(n) + '. Будьте обережні, при потребі прямуйте в укриття.',
  red: n => '🔴 Увага! повітряна тривога (червоний рівень) ' + where(n) + '. Негайно прямуйте в укриття!',
  up: n => '🔴 Увага! тривога посилилась до червоного рівня ' + where(n) + '. Негайно в укриття!',
  down: n => '🟡 Увага! рівень тривоги знизився до жовтого ' + where(n) + '. Тривога триває, залишайтесь в укритті.',
  clear: n => '🟢 Увага! відбій повітряної тривоги ' + where(n),
  street: n => '🟣 Увага! загроза вуличних боїв ' + where(n) + '. Залишайтесь у приміщенні, не виходьте на вулицю.',
  chem: n => '☣️ Увага! хімічна небезпека ' + where(n) + '. Зачиніть вікна й двері, залишайтесь у приміщенні.',
  rad: n => '☢️ Увага! радіаційна небезпека ' + where(n) + '. Залишайтесь у приміщенні, зачиніть вікна й двері.',
  oclear: (k, n) => '🟢 Увага! відбій загрози (' + OK[k] + ') ' + where(n)
};

/* ---------- источники ---------- */
async function getJSON(u) {
  const r = await fetch(u, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'alert-push/1.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
let regs = null;
async function srcTryvoha() {
  if (!regs) { const j = await getJSON('https://tryvoha.online/api/v1/regions'); const m = {}; (j.regions || j).forEach(r => m[r.slug] = r); regs = m; }
  const j = await getJSON('https://tryvoha.online/api/v1/alerts');
  return (j.alerts || j).map(a => {
    const r = regs[a.slug] || {}, ob = regs[r.oblast_slug] || {};
    return { id: r.id, name: r.name_uk || a.name_uk || a.name, type: typeOf(r.type || a.type), oblast: ob.name_uk || '', level: a.level === 'yellow' ? 'yellow' : 'red' };
  }).filter(e => e.name);
}
function srcSiren(j) {
  const out = [];
  (Array.isArray(j) ? j : (j.alerts || [])).forEach(it => {
    const act = (it.activeAlerts || []).filter(a => !a.type || a.type === 'AIR');
    if (!act.length) return;
    const lv = act.flatMap(a => (a.activeAlertLevels || []).map(x => String(x.alertLevel || '').toLowerCase()));
    out.push({ id: it.regionId, name: it.regionName, type: typeOf(it.regionType), oblast: '', level: lv.includes('red') || !lv.includes('yellow') ? 'red' : 'yellow' });
  });
  return out;
}
function othersFrom(j) {
  const out = [];
  (Array.isArray(j) ? j : (j.alerts || [])).forEach(it => (it.activeAlerts || []).forEach(a => { const k = kindOf(a.type); if (k) out.push({ id: it.regionId, name: it.regionName, kind: k }); }));
  return out;
}
async function srcUbilling() {
  const j = await getJSON('https://ubilling.net.ua/aerialalerts/'), st = j.states || j, out = [];
  for (const n in st) if (st[n] && st[n].alertnow) out.push({ name: n, type: 'state', level: 'red' });
  return out;
}
async function getData() {
  let siren = null, entries = null;
  try { siren = await getJSON('https://siren.pp.ua/api/v3/alerts'); } catch (e) {}
  try { entries = await srcTryvoha(); } catch (e) {}
  if (!entries && siren) entries = srcSiren(siren);
  if (!entries) { try { entries = await srcUbilling(); } catch (e) {} }
  if (!entries) return null;
  return { entries, others: siren ? othersFrom(siren) : [] };
}

/* ---------- статус региона ---------- */
function statusFor(item, entries, others) {
  let lvl = 0;
  const hit = e => { lvl = Math.max(lvl, e.level === 'yellow' ? 1 : 2); };
  const nn = norm(item.name), no = norm(item.ob);
  for (const e of entries) {
    const en = norm(e.name);
    if (item.t === 'd') {
      if (e.type === 'district' && en === nn && (e.id == item.id || !e.oblast || norm(e.oblast) === no)) hit(e);
      else if (e.type === 'state' && en === no) hit(e);
    } else if (item.t === 'c') {
      if (e.type === 'community' && e.id == item.id && en === nn) hit(e);
      else if (e.type === 'district' && en === norm(item.pname) && (e.id == item.pid || !e.oblast || norm(e.oblast) === no)) hit(e);
      else if (e.type === 'state' && en === no) hit(e);
    } else {
      if (e.type === 'state' && en === nn) hit(e);
      else if (e.type !== 'state' && e.oblast && norm(e.oblast) === nn) hit(e);
    }
  }
  const kinds = new Set();
  for (const o of others) { if (norm(o.name) === nn && (item.t !== 'c' || o.id == item.id)) kinds.add(o.kind); }
  return { lvl, kinds };
}

/* ---------- подписки ---------- */
let subs = {};
async function loadSubs() {
  try {
    if (UP) { const r = await fetch(UP, { method: 'POST', headers: { Authorization: 'Bearer ' + UT }, body: JSON.stringify(['GET', 'subs']) }); const j = await r.json(); return j.result ? JSON.parse(j.result) : {}; }
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) { return {}; }
}
let saveT = null;
function saveSubs() {
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    const s = JSON.stringify(subs);
    try {
      if (UP) await fetch(UP, { method: 'POST', headers: { Authorization: 'Bearer ' + UT }, body: JSON.stringify(['SET', 'subs', s]) });
      else fs.writeFileSync(FILE, s);
    } catch (e) { console.error('save failed', e.message); }
  }, 500);
}

async function notify(eps, text, tag, urgent) {
  const payload = JSON.stringify({ title: 'Карта тривог', body: text, tag, urgent });
  await Promise.all(eps.map(async ep => {
    const s = subs[ep]; if (!s) return;
    try { await webpush.sendNotification(s.sub, payload, { TTL: urgent ? 900 : 300, urgency: 'high' }); }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { delete subs[ep]; saveSubs(); }
      else console.error('push error', e.statusCode || e.message);
    }
  }));
}

const G = {};
async function tick() {
  const data = await getData();
  if (!data) return;
  const watch = new Map();
  for (const [ep, s] of Object.entries(subs)) for (const it of s.items || []) {
    const key = it.t + ':' + it.id + ':' + norm(it.name);
    let w = watch.get(key); if (!w) watch.set(key, w = { item: it, eps: [] });
    w.eps.push(ep);
  }
  for (const key of Object.keys(G)) if (!watch.has(key)) delete G[key];
  for (const [key, w] of watch) {
    const cur = statusFor(w.item, data.entries, data.others), n = w.item.n || w.item.name;
    let st = G[key];
    if (!st) { G[key] = { lvl: cur.lvl, pend: 0, ok: Object.fromEntries([...cur.kinds].map(k => [k, 1])) }; continue; }
    const send = (text, tag, urgent) => notify(w.eps, text, key + tag, urgent);
    if (cur.lvl === st.lvl) st.pend = 0;
    else if (cur.lvl > st.lvl) {
      const text = st.lvl === 0 ? (cur.lvl === 1 ? MSG.yellow(n) : MSG.red(n)) : MSG.up(n);
      await send(text, 'air', true); st.lvl = cur.lvl; st.pend = 0;
    } else if (++st.pend >= 2) {
      await send(cur.lvl === 0 ? MSG.clear(n) : MSG.down(n), 'air', cur.lvl !== 0);
      st.lvl = cur.lvl; st.pend = 0;
    }
    for (const k of ['street', 'chem', 'rad']) {
      const on = cur.kinds.has(k), was = !!st.ok[k];
      if (on && !was) { st.ok[k] = 1; await send(MSG[k](n), k, true); }
      else if (!on && was) { st.ok[k] = 0; await send(MSG.oclear(k, n), k, false); }
    }
  }
}

/* ---------- HTTP ---------- */
function start() {
  if (!PUB || !PRIV) {
    const k = webpush.generateVAPIDKeys();
    console.log('Не заданы VAPID_PUBLIC / VAPID_PRIVATE. Вот новая пара, добавь её в переменные окружения:\nVAPID_PUBLIC=' + k.publicKey + '\nVAPID_PRIVATE=' + k.privateKey);
    process.exit(1);
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', PUB, PRIV);
  const app = express();
  app.use((req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.get('/health', (q, r) => r.send('ok'));
  app.get('/api/vapid', (q, r) => r.json({ key: PUB }));
  app.post('/api/sub', (q, r) => {
    const { sub, items } = q.body || {};
    if (!sub || !sub.endpoint || !sub.keys || !Array.isArray(items)) return r.sendStatus(400);
    if (!subs[sub.endpoint] && Object.keys(subs).length > 5000) return r.sendStatus(503);
    const clean = items.slice(0, 20).filter(i => i && ['d', 'c', 'o'].includes(i.t) && i.name).map(i => ({
      t: i.t, id: i.id, name: String(i.name).slice(0, 120), n: String(i.n || i.name).slice(0, 140),
      ob: String(i.ob || '').slice(0, 120), pid: i.pid, pname: String(i.pname || '').slice(0, 120)
    }));
    subs[sub.endpoint] = { sub, items: clean, t: Date.now() };
    saveSubs(); r.json({ ok: true, items: clean.length });
  });
  app.post('/api/unsub', (q, r) => { const ep = q.body && q.body.endpoint; if (ep && subs[ep]) { delete subs[ep]; saveSubs(); } r.json({ ok: true }); });
  const files = { '/': 'index.html', '/index.html': 'index.html', '/sw.js': 'sw.js', '/manifest.json': 'manifest.json', '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png' };
  app.get(Object.keys(files), (q, r) => r.sendFile(path.join(__dirname, files[q.path])));
  loadSubs().then(s => {
    subs = s;
    app.listen(PORT, () => console.log('listening', PORT, 'subs', Object.keys(subs).length));
    const loop = async () => { try { await tick(); } catch (e) { console.error('tick', e.message); } setTimeout(loop, POLL); };
    loop();
  });
}
if (require.main === module) start();
module.exports = { statusFor, norm, MSG, where };
