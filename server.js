'use strict';
/* ArchNest Studio — tiny zero-dependency server: serves the website, stores bookings/quotes,
   and protects the admin panel (/admin) with email + password. Needs Node 18+.  Run:  node server.js */
const http = require('http'), https = require('https'), net = require('net'), tls = require('tls'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = +process.env.PORT || 3000, ROOT = __dirname, DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data'), DBF = path.join(DATA, 'db.json');
const SECURE = process.env.COOKIE_SECURE === '1';           // set COOKIE_SECURE=1 when the site is served over https
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
fs.mkdirSync(DATA, { recursive: true });
/* ---------- tiny JSON database ---------- */
let db = { admin: null, bookings: [], quotes: [], profiles: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DBF, 'utf8'))) } catch (e) { }
let saving = false, dirty = false;
function save() { if (saving) { dirty = true; return } saving = true; const tmp = DBF + '.tmp'; fs.writeFile(tmp, JSON.stringify(db, null, 1), err => { if (!err) fs.rename(tmp, DBF, () => { saving = false; if (dirty) { dirty = false; save() } }); else saving = false }) }
const hash = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
function setAdmin(email, pw) { const salt = crypto.randomBytes(16).toString('hex'); db.admin = { email: String(email).trim().toLowerCase(), salt, hash: hash(pw, salt) }; save() }
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && String(process.env.ADMIN_PASSWORD).length < 8) { console.log('\n  ERROR: ADMIN_PASSWORD must be at least 8 characters.\n'); process.exit(1) }
if (process.env.ADMIN_RESET === '1' && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) { db.admin = null; console.log('Admin login reset') }
if (!db.admin) {
  const e = process.env.ADMIN_EMAIL, p = process.env.ADMIN_PASSWORD;
  if (e && p && p.length >= 8) { setAdmin(e, p); console.log('Admin account created for', e) }
  else { const gen = crypto.randomBytes(9).toString('base64url'); setAdmin(e || 'admin@archnest.local', gen); console.log('\n  No ADMIN_EMAIL / ADMIN_PASSWORD set. A first-run admin was created:\n    email:    ' + db.admin.email + '\n    password: ' + gen + '\n  Log in at /admin and change the password immediately.\n') }
}
/* ---------- helpers ---------- */
const sessions = new Map(), tries = new Map(), posts = new Map();
const now = () => Date.now(), uid = p => p + '-' + now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
const ip = r => (r.headers['x-forwarded-for'] || '').split(',')[0].trim() || r.socket.remoteAddress || '';
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n || 200);
const locOf = l => { l = l || {}; const la = l.lat === null || l.lat === undefined || l.lat === '' ? NaN : +l.lat, ln = l.lng === null || l.lng === undefined || l.lng === '' ? NaN : +l.lng, ok = isFinite(la) && isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180; let url = clean(l.url, 300); if (!/^https:\/\/(www\.google\.com\/maps|maps\.google\.com|maps\.app\.goo\.gl|goo\.gl\/maps)/.test(url)) url = ''; const text = clean(l.text, 300); return ok || url || text ? { lat: ok ? la : null, lng: ok ? ln : null, url, text } : null };
const money = n => { n = Math.round(+n); return isFinite(n) && n >= 0 && n < 1e10 ? n : 0 };
function limit(map, key, max, win) { const t = now(), a = (map.get(key) || []).filter(x => t - x < win); if (a.length >= max) { map.set(key, a); return false } a.push(t); map.set(key, a); return true }
function send(res, code, obj, extra) { const b = typeof obj == 'string' ? obj : JSON.stringify(obj); res.writeHead(code, Object.assign({ 'Content-Type': typeof obj == 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store' }, extra || {})); res.end(b) }
function body(req, max, raw) { return new Promise((ok, no) => { let n = 0, c = []; req.on('data', d => { n += d.length; if (n > (max || 2e5)) { no(new Error('too large')); req.destroy() } else c.push(d) }); req.on('end', () => { try { const t = Buffer.concat(c).toString(); ok(raw ? t : JSON.parse(t || '{}')) } catch (e) { no(new Error('bad json')) } }); req.on('error', no) }) }
const cookie = r => Object.fromEntries((r.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(a => a[0]).map(a => [a[0], a.slice(1).join('=')]));
function authed(r) { const t = cookie(r).an_admin, s = t && sessions.get(t); if (!s) return null; if (s.exp < now()) { sessions.delete(t); return null } s.exp = now() + 8 * 36e5; return t }
const paid = q => (q.payments || []).reduce((a, p) => a + p.amount, 0);
function stat(q) { const p = paid(q); return p <= 0 ? 'Pending' : p >= q.total ? 'Paid' : 'Partial' }
/* ---------- optional e-mail (SMTP) — set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, NOTIFY_TO ---------- */
const SMTP = { host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 465, user: process.env.SMTP_USER, pass: process.env.SMTP_PASS, from: process.env.MAIL_FROM || process.env.SMTP_USER, owner: process.env.NOTIFY_TO || process.env.SMTP_USER, plain: process.env.SMTP_TLS === 'none' };
const mailOn = () => !!(SMTP.host && SMTP.from);
const hdr = s => String(s || '').replace(/[\r\n]+/g, ' ').slice(0, 200), b64 = s => Buffer.from(s).toString('base64'), isMail = e => /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(e || '');
function smtpSend(to, subject, text) {
  return new Promise((ok, no) => {
    let sock, buf = '', step = 0, done = false, secure = SMTP.port == 465 && !SMTP.plain; const q = [];
    const fin = (e) => { if (done) return; done = true; try { sock && sock.destroy() } catch (x) { } e ? no(e) : ok() };
    const msg = ['From: ' + hdr(SMTP.from), 'To: ' + hdr(to), 'Subject: =?UTF-8?B?' + b64(hdr(subject)) + '?=', 'Date: ' + new Date().toUTCString(), 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(text).replace(/(.{76})/g, '$1\r\n')].join('\r\n');
    const cmds = []; const fromAddr = (SMTP.from.match(/<([^>]+)>/) || [0, SMTP.from])[1];
    const flow = () => { cmds.length = 0; if (SMTP.user && SMTP.pass) cmds.push(['AUTH LOGIN', 334], [b64(SMTP.user), 334], [b64(SMTP.pass), 235]); cmds.push(['MAIL FROM:<' + fromAddr + '>', 250], ['RCPT TO:<' + to + '>', 250], ['DATA', 354], [msg + '\r\n.', 250], ['QUIT', 221]) };
    const onLine = l => {
      const c = +l.slice(0, 3); if (l[3] == '-') return;
      if (step == 0) { if (c != 220) return fin(new Error('SMTP greeting ' + l)); step = 1; sock.write('EHLO archnest\r\n'); return }
      if (step == 1) { if (c != 250) return fin(new Error('EHLO ' + l)); if (!secure && !SMTP.plain) { step = 2; sock.write('STARTTLS\r\n'); return } flow(); step = 10; nxt(); return }
      if (step == 2) { if (c != 220) return fin(new Error('STARTTLS ' + l)); const t = tls.connect({ socket: sock, servername: SMTP.host }, () => { sock = t; secure = true; buf = ''; t.on('data', onData); t.on('error', fin); step = 3; t.write('EHLO archnest\r\n') }); return }
      if (step == 3) { if (c != 250) return fin(new Error('EHLO2 ' + l)); flow(); step = 10; nxt(); return }
      if (step >= 10) { const exp = cmds[step - 10][1]; if (c != exp) return fin(new Error('SMTP ' + l)); step++; if (step - 10 >= cmds.length) return fin(); nxt() }
    };
    const nxt = () => sock.write(cmds[step - 10][0] + '\r\n');
    const onData = d => { buf += d; let i; while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); onLine(l) } };
    const open = () => { sock.setEncoding('utf8'); sock.on('data', onData); sock.on('error', fin) };
    sock = secure ? tls.connect({ host: SMTP.host, port: SMTP.port, servername: SMTP.host }, open) : net.connect({ host: SMTP.host, port: SMTP.port }, open);
    setTimeout(() => fin(new Error('SMTP timeout')), 20000)
  })
}
function notify(to, subject, text) { if (!mailOn() || !isMail(to)) return; smtpSend(to, subject, text).catch(e => console.log('mail failed:', e.message)) }
const inr = n => 'Rs. ' + Math.round(n).toLocaleString('en-IN');
/* ---------- optional online payment (Razorpay payment links) ---------- */
const RZ = { id: process.env.RAZORPAY_KEY_ID, secret: process.env.RAZORPAY_KEY_SECRET, hook: process.env.RAZORPAY_WEBHOOK_SECRET, api: process.env.RAZORPAY_API || 'https://api.razorpay.com' };
const payOn = () => !!(RZ.id && RZ.secret);
function rzPost(p, obj) {
  return new Promise((ok, no) => {
    const u = new URL(RZ.api + p), mod = u.protocol == 'http:' ? http : https, d = JSON.stringify(obj);
    const r = mod.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d), Authorization: 'Basic ' + Buffer.from(RZ.id + ':' + RZ.secret).toString('base64') } }, res => { let t = ''; res.on('data', c => t += c); res.on('end', () => { try { const j = JSON.parse(t); res.statusCode < 300 ? ok(j) : no(new Error((j.error && j.error.description) || 'Payment provider error')) } catch (e) { no(new Error('Payment provider error')) } }) }); r.on('error', () => no(new Error('Payment provider unreachable'))); r.setTimeout(15000, () => r.destroy()); r.end(d)
  })
}
const SLOTS = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
function slotsFor(date) { if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return []; const d = new Date(date + 'T00:00:00Z'); if (d.getUTCDay() == 0) return []; const taken = db.bookings.filter(b => b.date == date && b.slot && b.status != 'Cancelled').map(b => b.slot); return SLOTS.filter(s => !taken.includes(s)) }
/* ---------- API ---------- */
async function api(req, res, u) {
  const m = req.method, p = u.pathname;
  if (m == 'POST' && !/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON only' });
  /* public: booking + quote requests from the website */
  if (m == 'POST' && (p == '/api/bookings' || p == '/api/quotes')) {
    if (!limit(posts, ip(req), 20, 36e5)) return send(res, 429, { error: 'Too many requests, try later' });
    const b = await body(req);
    if (p == '/api/bookings') {
      const r = { id: uid('BK'), at: new Date().toISOString(), who: clean(b.who), name: clean(b.name, 100), phone: clean(b.phone, 30), email: clean(b.email, 120), date: clean(b.date, 20), slot: SLOTS.includes(b.slot) ? b.slot : '', type: clean(b.type, 60), msg: clean(b.msg, 1000), loc: locOf(b.loc), status: 'New', note: '' };
      if (!r.name || !(r.phone || r.email)) return send(res, 400, { error: 'Name and phone or email required' }); if (r.slot && r.date && !slotsFor(r.date).includes(r.slot)) return send(res, 409, { error: 'That time slot was just taken. Please pick another.' }); db.bookings.unshift(r); save();
      notify(SMTP.owner, 'New booking ' + r.id + ' — ' + r.name, 'Name: ' + r.name + '\nPhone: ' + r.phone + '\nEmail: ' + r.email + '\nWith: ' + r.who + '\nType: ' + r.type + '\nDate: ' + r.date + ' ' + r.slot + '\nMessage: ' + r.msg);
      notify(r.email, 'We received your request — ' + r.id, 'Hello ' + r.name + ',\n\nThank you for contacting ArchNest Studio. Your reference is ' + r.id + (r.date ? ' (preferred: ' + r.date + ' ' + r.slot + ')' : '') + '. We will call you shortly.\n\nTrack it any time on our website.'); return send(res, 201, { id: r.id })
    }
    const c = b.client || {}, q = {
      id: uid('QT'), at: new Date().toISOString(), client: { name: clean(c.name, 100), phone: clean(c.phone, 30), email: clean(c.email, 120), address: clean(c.address, 300), loc: locOf(c.loc), project: clean(c.project, 120), gstin: clean(c.gstin, 20) }, budget: money(b.budget), subtotal: money(b.subtotal), fee: money(b.fee), gst: money(b.gst), total: money(b.total),
      lines: (Array.isArray(b.lines) ? b.lines : []).slice(0, 80).map(l => [clean(l[0], 120), money(l[1])]), status: 'Quote', payments: [], note: '', files: []
    };
    if (!q.client.name || !(q.client.phone || q.client.email) || !q.total) return send(res, 400, { error: 'Client name, phone/email and a total are required' }); db.quotes.unshift(q); save();
    notify(SMTP.owner, 'New quote ' + q.id + ' — ' + q.client.name, 'Client: ' + q.client.name + '\nPhone: ' + q.client.phone + '\nEmail: ' + q.client.email + '\nProject: ' + q.client.project + '\nTotal: ' + inr(q.total));
    notify(q.client.email, 'Your ArchNest estimate ' + q.id, 'Hello ' + q.client.name + ',\n\nWe received your estimate request (' + q.id + ') for ' + (q.client.project || 'your project') + ': total ' + inr(q.total) + '.\nKeep this reference to track progress on our website.'); return send(res, 201, { id: q.id })
  }
  /* admin login */
  if (p == '/api/admin/login' && m == 'POST') {
    const k = ip(req); if (!limit(tries, k, 5, 9e5)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    const b = await body(req), okE = clean(b.email, 120).toLowerCase() === db.admin.email, h = hash(b.password || '', db.admin.salt), good = okE && crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(db.admin.hash, 'hex'));
    if (!good) return send(res, 401, { error: 'Wrong email or password' }); tries.delete(k); const t = crypto.randomBytes(32).toString('hex'); sessions.set(t, { exp: now() + 8 * 36e5 });
    return send(res, 200, { ok: 1 }, { 'Set-Cookie': `an_admin=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${SECURE ? '; Secure' : ''}` })
  }
  if (m == 'POST' && p == '/api/profile') {
    if (!limit(posts, 'f' + ip(req), 40, 36e5)) return send(res, 429, { error: 'Too many requests' }); const b = await body(req); db.profiles = db.profiles || [];
    const id = /^CL-[\w]{6,24}$/.test(b.id || '') ? b.id : uid('CL'), f = b.fav || {}, arr = (a, n) => (Array.isArray(a) ? a : []).slice(0, n).map(x => clean(x, 100)).filter(Boolean);
    const rec = { id, at: new Date().toISOString(), name: clean(b.name, 100), phone: clean(b.phone, 30), email: clean(b.email, 120), address: clean(b.address, 300), loc: locOf(b.loc), more: (m => ({ city: clean(m.city, 80), ptype: clean(m.ptype, 40), budget: clean(m.budget, 40), notes: clean(m.notes, 500) }))(b.more || {}), fav: { items: arr(f.items, 40), styles: arr(f.styles, 20) }, refs: arr(b.refs, 8).map(x => x.toUpperCase()) };
    if (!rec.name || !(rec.phone || rec.email)) return send(res, 400, { error: 'Name and phone or email required' });
    const i = db.profiles.findIndex(x => x.id == id); if (i >= 0) { rec.at = db.profiles[i].at; rec.upd = new Date().toISOString(); db.profiles[i] = rec } else { db.profiles.unshift(rec); if (db.profiles.length > 2000) db.profiles.pop() } save(); return send(res, 200, { id })
  }
  if (m == 'GET' && p == '/api/config') return send(res, 200, { pay: payOn(), mail: mailOn() });
  if (m == 'GET' && p == '/api/slots') { if (!limit(posts, 's' + ip(req), 200, 36e5)) return send(res, 429, { error: 'Too many requests' }); return send(res, 200, { slots: slotsFor(u.searchParams.get('date') || '') }) }
  let pq; if (m == 'POST' && (pq = p.match(/^\/api\/pay\/([\w-]{6,40})$/))) {
    if (!payOn()) return send(res, 503, { error: 'Online payment is not set up yet' }); if (!limit(posts, 'p' + ip(req), 10, 36e5)) return send(res, 429, { error: 'Too many requests' });
    const q = db.quotes.find(x => x.id == pq[1].toUpperCase()); if (!q || q.status == 'Cancelled') return send(res, 404, { error: 'Not found' }); const b = await body(req), rem = q.total - paid(q); if (rem <= 0) return send(res, 400, { error: 'Nothing pending — already paid' });
    const adv = Math.max(0, Math.ceil(q.total * .3) - paid(q)), amt = Math.min(rem, b.kind == 'balance' || adv <= 0 ? rem : adv); if (amt < 1) return send(res, 400, { error: 'Nothing to pay' });
    const j = await rzPost('/v1/payment_links', { amount: amt * 100, currency: 'INR', description: ('ArchNest ' + (q.client.project || 'project') + ' (' + q.id + ')').slice(0, 200), reference_id: (q.id + '-' + now().toString(36)).slice(0, 40), customer: { name: q.client.name, contact: q.client.phone, email: isMail(q.client.email) ? q.client.email : undefined }, notes: { quote: q.id }, reminder_enable: false });
    return send(res, 200, { url: j.short_url, amount: amt })
  }
  if (m == 'POST' && p == '/api/razorpay/webhook') {
    const raw = await body(req, 2e5, true); if (!RZ.hook) return send(res, 503, { error: 'Webhook secret not set' }); const sig = String(req.headers['x-razorpay-signature'] || ''), exp = crypto.createHmac('sha256', RZ.hook).update(raw).digest('hex');
    if (sig.length != exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return send(res, 400, { error: 'Bad signature' });
    let ev; try { ev = JSON.parse(raw) } catch (e) { return send(res, 400, { error: 'bad json' }) }
    if (ev.event == 'payment_link.paid' || ev.event == 'payment.captured') {
      const pl = ev.payload && ev.payload.payment_link && ev.payload.payment_link.entity, py = ev.payload && ev.payload.payment && ev.payload.payment.entity, qid = String((pl && pl.notes && pl.notes.quote) || (py && py.notes && py.notes.quote) || '').toUpperCase(), x = db.quotes.find(i => i.id == qid);
      if (x && py && !(x.payments || []).some(i => i.ref == py.id)) {
        x.payments = x.payments || []; x.payments.push({ id: uid('PY'), ref: clean(py.id, 40), date: new Date().toISOString().slice(0, 10), amount: money(py.amount / 100), method: 'Razorpay', note: clean(py.id, 40) }); save();
        notify(SMTP.owner, 'Payment received ' + x.id, inr(py.amount / 100) + ' received online from ' + x.client.name + ' for ' + x.id + '.'); notify(x.client.email, 'Payment received — ' + x.id, 'Hello ' + x.client.name + ',\n\nWe received ' + inr(py.amount / 100) + ' for ' + (x.client.project || x.id) + '. Thank you!')
      }
    }
    return send(res, 200, { ok: 1 })
  }
  let tr; if (m == 'GET' && (tr = p.match(/^\/api\/track\/([\w-]{6,40})$/))) {
    if (!limit(posts, 't' + ip(req), 60, 36e5)) return send(res, 429, { error: 'Too many requests' }); const id = tr[1].toUpperCase(), q = db.quotes.find(x => x.id == id);
    if (q) { const rc = paid(q); return send(res, 200, { type: 'quote', id: q.id, status: q.status, project: q.client.project, received: rc, total: q.total, paidPct: q.total ? Math.min(100, Math.round(rc / q.total * 100)) : 0, pay: stat(q) }) }
    const b = db.bookings.find(x => x.id == id); if (b) return send(res, 200, { type: 'booking', id: b.id, status: b.status }); return send(res, 404, { error: 'Not found' })
  }
  if (!p.startsWith('/api/admin/')) return send(res, 404, { error: 'Not found' });
  const tok = authed(req); if (!tok) return send(res, 401, { error: 'Login required' });
  if (m != 'GET' && req.headers['x-requested-with'] !== 'admin') return send(res, 403, { error: 'Bad request' });
  if (p == '/api/admin/logout') { sessions.delete(tok); return send(res, 200, { ok: 1 }, { 'Set-Cookie': 'an_admin=; HttpOnly; Path=/; Max-Age=0' }) }
  if (p == '/api/admin/me') return send(res, 200, { email: db.admin.email });
  if (p == '/api/admin/data' && m == 'GET') return send(res, 200, { profiles: db.profiles || [], bookings: db.bookings, quotes: db.quotes.map(q => Object.assign({}, q, { received: paid(q), pending: Math.max(0, q.total - paid(q)), pay: stat(q) })) });
  if (p == '/api/admin/password' && m == 'POST') {
    const b = await body(req); if (hash(b.current || '', db.admin.salt) !== db.admin.hash) return send(res, 400, { error: 'Current password is wrong' }); if (String(b.next || '').length < 8) return send(res, 400, { error: 'New password needs at least 8 characters' });
    setAdmin(clean(b.email || db.admin.email, 120), b.next); return send(res, 200, { ok: 1 })
  }
  let r;
  if (m == 'DELETE' && (r = p.match(/^\/api\/admin\/profiles\/([\w-]+)$/))) { db.profiles = (db.profiles || []).filter(i => i.id != r[1]); save(); return send(res, 200, { ok: 1 }) }
  const UP = path.join(DATA, 'uploads'), EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  if (m == 'POST' && (r = p.match(/^\/api\/admin\/(quotes|bookings)\/([\w-]+)\/files$/))) {
    const x = (r[1] == 'quotes' ? db.quotes : db.bookings).find(i => i.id == r[2]); if (!x) return send(res, 404, { error: 'Not found' }); const b = await body(req, 3.2e6), ext = EXT[b.type]; if (!ext) return send(res, 400, { error: 'Only PDF, JPG, PNG or WEBP files' });
    const buf = Buffer.from(String(b.data || ''), 'base64'); if (!buf.length || buf.length > 2.2e6) return send(res, 400, { error: 'File must be under 2 MB' });
    const ok = ext == 'pdf' ? buf.slice(0, 4).toString() == '%PDF' : ext == 'png' ? buf[0] == 0x89 && buf[1] == 0x50 : ext == 'jpg' ? buf[0] == 0xff && buf[1] == 0xd8 : buf.slice(0, 4).toString() == 'RIFF'; if (!ok) return send(res, 400, { error: 'File content does not match its type' });
    fs.mkdirSync(UP, { recursive: true }); const fid = crypto.randomBytes(8).toString('hex'); fs.writeFileSync(path.join(UP, fid + '.' + ext), buf); x.files = x.files || []; x.files.push({ id: fid, ext, name: clean(b.name, 80).replace(/[\\\/"<>:|?*]/g, '_') || ('file.' + ext), size: buf.length, at: new Date().toISOString() }); save(); return send(res, 201, x)
  }
  if (m == 'GET' && (r = p.match(/^\/api\/admin\/file\/([a-f0-9]{16})$/))) {
    const x = [...db.quotes, ...db.bookings].find(i => (i.files || []).some(f => f.id == r[1])), f = x && x.files.find(f => f.id == r[1]); if (!f) return send(res, 404, { error: 'Not found' });
    const mt = Object.keys(EXT).find(k => EXT[k] == f.ext); res.writeHead(200, { 'Content-Type': mt, 'Content-Disposition': 'attachment; filename="' + f.name.replace(/[^\w.\- ]/g, '_') + '"', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); return fs.createReadStream(path.join(UP, f.id + '.' + f.ext)).pipe(res)
  }
  if (m == 'DELETE' && (r = p.match(/^\/api\/admin\/(quotes|bookings)\/([\w-]+)\/files\/([a-f0-9]{16})$/))) { const x = (r[1] == 'quotes' ? db.quotes : db.bookings).find(i => i.id == r[2]); if (!x) return send(res, 404, { error: 'Not found' }); const f = (x.files || []).find(f => f.id == r[3]); if (f) { try { fs.unlinkSync(path.join(UP, f.id + '.' + f.ext)) } catch (e) { } x.files = x.files.filter(i => i.id != f.id); save() } return send(res, 200, x) }
  if (m == 'PATCH' && (r = p.match(/^\/api\/admin\/bookings\/([\w-]+)$/))) {
    const x = db.bookings.find(i => i.id == r[1]); if (!x) return send(res, 404, { error: 'Not found' }); const b = await body(req);
    const was = x.status; if (['New', 'Confirmed', 'Completed', 'Cancelled'].includes(b.status)) x.status = b.status; if ('note' in b) x.note = clean(b.note, 500); save(); if (x.status != was) notify(x.email, 'Update on your booking ' + x.id, 'Hello ' + x.name + ',\n\nYour booking ' + x.id + ' is now: ' + x.status + '.\n\n— ArchNest Studio'); return send(res, 200, x)
  }
  if (m == 'DELETE' && (r = p.match(/^\/api\/admin\/bookings\/([\w-]+)$/))) { db.bookings = db.bookings.filter(i => i.id != r[1]); save(); return send(res, 200, { ok: 1 }) }
  if (m == 'POST' && p == '/api/admin/quotes') {
    const b = await body(req), c = b.client || {}, q = { id: uid('QT'), at: new Date().toISOString(), client: { name: clean(c.name, 100), phone: clean(c.phone, 30), email: clean(c.email, 120), address: '', project: clean(c.project, 120), gstin: '' }, budget: 0, subtotal: money(b.total), fee: 0, gst: 0, total: money(b.total), lines: [], status: 'Approved', payments: [] };
    if (!q.client.name || !q.total) return send(res, 400, { error: 'Client name and total required' }); db.quotes.unshift(q); save(); return send(res, 201, q)
  }
  if (m == 'PATCH' && (r = p.match(/^\/api\/admin\/quotes\/([\w-]+)$/))) {
    const x = db.quotes.find(i => i.id == r[1]); if (!x) return send(res, 404, { error: 'Not found' }); const b = await body(req);
    const was = x.status; if (['Quote', 'Approved', 'In progress', 'Completed', 'Cancelled'].includes(b.status)) x.status = b.status; if ('note' in b) x.note = clean(b.note, 1000); save(); if (x.status != was) notify(x.client.email, 'Project update — ' + x.id, 'Hello ' + x.client.name + ',\n\nYour project ' + (x.client.project || x.id) + ' is now: ' + x.status + '.\nPaid so far: ' + inr(paid(x)) + ' of ' + inr(x.total) + '.\n\n— ArchNest Studio'); return send(res, 200, x)
  }
  if (m == 'DELETE' && (r = p.match(/^\/api\/admin\/quotes\/([\w-]+)$/))) { db.quotes = db.quotes.filter(i => i.id != r[1]); save(); return send(res, 200, { ok: 1 }) }
  if (m == 'POST' && (r = p.match(/^\/api\/admin\/quotes\/([\w-]+)\/payments$/))) {
    const x = db.quotes.find(i => i.id == r[1]); if (!x) return send(res, 404, { error: 'Not found' }); const b = await body(req), a = money(b.amount);
    if (!a) return send(res, 400, { error: 'Enter an amount' }); x.payments = x.payments || []; x.payments.push({ id: uid('PY'), date: clean(b.date, 20) || new Date().toISOString().slice(0, 10), amount: a, method: clean(b.method, 30) || 'Cash', note: clean(b.note, 200) }); save(); notify(x.client.email, 'Payment received — ' + x.id, 'Hello ' + x.client.name + ',\n\nWe received ' + inr(a) + ' for ' + (x.client.project || x.id) + '. Balance pending: ' + inr(Math.max(0, x.total - paid(x))) + '.\n\nThank you — ArchNest Studio'); return send(res, 201, x)
  }
  if (m == 'DELETE' && (r = p.match(/^\/api\/admin\/quotes\/([\w-]+)\/payments\/([\w-]+)$/))) { const x = db.quotes.find(i => i.id == r[1]); if (!x) return send(res, 404, { error: 'Not found' }); x.payments = (x.payments || []).filter(i => i.id != r[2]); save(); return send(res, 200, x) }
  if (m == 'GET' && (r = p.match(/^\/api\/admin\/export\/(bookings|payments)\.csv$/))) {
    const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'; let rows;
    if (r[1] == 'bookings') rows = [['ID', 'Date', 'Name', 'Phone', 'Email', 'With', 'Type', 'Preferred date', 'Status', 'Message', 'Note'], ...db.bookings.map(b => [b.id, b.at, b.name, b.phone, b.email, b.who, b.type, b.date, b.status, b.msg, b.note])];
    else rows = [['Quote', 'Date', 'Client', 'Phone', 'Email', 'Project', 'Total', 'Received', 'Pending', 'Payment status', 'Project status'], ...db.quotes.map(x => [x.id, x.at, x.client.name, x.client.phone, x.client.email, x.client.project, x.total, paid(x), Math.max(0, x.total - paid(x)), stat(x), x.status])];
    return send(res, 200, rows.map(a => a.map(q).join(',')).join('\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${r[1]}.csv"` })
  }
  send(res, 404, { error: 'Not found' })
}
/* ---------- static files ---------- */
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https://images.unsplash.com; media-src 'self' blob:; connect-src 'self' https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com; frame-ancestors 'none'";
function serve(req, res, u) {
  let p = decodeURIComponent(u.pathname); if (p == '/admin' || p == '/admin/') p = '/admin.html'; if (p.endsWith('/')) p += 'index.html'; if (p == '') p = '/index.html';
  if (!(p == '/index.html' || p == '/admin.html' || p.startsWith('/assets/'))) return send(res, 404, 'Not found');
  const f = path.normalize(path.join(ROOT, p)); if (!f.startsWith(path.join(ROOT, 'assets') + path.sep) && f !== path.join(ROOT, 'index.html') && f !== path.join(ROOT, 'admin.html')) return send(res, 403, 'Forbidden');
  fs.stat(f, (e, s) => {
    if (e || !s.isFile()) return send(res, 404, 'Not found'); const ext = path.extname(f).toLowerCase(); if (!MIME[ext]) return send(res, 403, 'Forbidden');
    const h = { 'Content-Type': MIME[ext], 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': CSP, 'Cache-Control': ext == '.html' ? 'no-cache' : 'public, max-age=86400' };
    if (p == '/admin.html') h['Cache-Control'] = 'no-store';
    const rg = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (rg && (ext == '.mp4' || ext == '.webm')) {
      let a = rg[1] ? +rg[1] : 0, b = rg[2] ? +rg[2] : s.size - 1; if (a > b || a >= s.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + s.size }); return res.end() } b = Math.min(b, s.size - 1);
      res.writeHead(206, Object.assign(h, { 'Content-Range': `bytes ${a}-${b}/${s.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': b - a + 1 })); return fs.createReadStream(f, { start: a, end: b }).pipe(res)
    }
    h['Content-Length'] = s.size; h['Accept-Ranges'] = 'bytes'; res.writeHead(200, h); fs.createReadStream(f).pipe(res)
  })
}
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) return api(req, res, u).catch(e => send(res, 400, { error: e.message || 'Bad request' }));
  if (req.method != 'GET' && req.method != 'HEAD') return send(res, 405, 'Method not allowed'); serve(req, res, u)
}).listen(PORT, () => console.log('ArchNest running:  http://localhost:' + PORT + '   admin: http://localhost:' + PORT + '/admin'));
