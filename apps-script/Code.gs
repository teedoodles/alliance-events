/**
 * Alliance University Events: Google Sheets backend (Google Apps Script)
 * Data lives in this spreadsheet (tabs: Events, Registrations). Photos go to a private Drive folder.
 * Settings (Project Settings > Script properties): ADMIN_PASSWORD (required), STAFF_PASSWORD (optional, check-in only),
 * MSG91_AUTH_KEY + MSG91_TEMPLATE_ID + COUNTRY_CODE (optional, enables SMS OTP).
 */
const SH = {
  Events: ['id','name','description','category','venue','event_date','start_time','end_time','reg_opens','reg_deadline','valid_until','capacity','status','reg_open','archived','created_at'],
  Registrations: ['reg_code','event_id','event_name','name','email','mobile','organization','department','type','email_verified','mobile_verified','status','registered_at','checked_in_at','photo_id','photo_consent']
};
const prop = (k, d) => PropertiesService.getScriptProperties().getProperty(k) || d || '';
const smsOn = () => !!(prop('MSG91_AUTH_KEY') && prop('MSG91_TEMPLATE_ID'));
const fail = (status, error, fields) => { throw { status: status, error: error, fields: fields }; };
const W = data => ({ data: data });
const istDate = d => Utilities.formatDate(d, 'Asia/Kolkata', 'yyyy-MM-dd');

/** Run once from the editor (Run > setup) to create the tabs, text formatting and photo folder. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(SH).forEach(n => {
    const s = ss.getSheetByName(n) || ss.insertSheet(n), cols = SH[n].length;
    s.getRange(1, 1, 1, cols).setValues([SH[n]]).setFontWeight('bold').setBackground('#1d3a6b').setFontColor('#ffffff');
    s.getRange(2, 1, s.getMaxRows() - 1, cols).setNumberFormat('@');   // plain text: keeps phone numbers and dates exact
    s.setFrozenRows(1);
  });
  const P = PropertiesService.getScriptProperties();
  if (!prop('TOKEN_SECRET')) P.setProperty('TOKEN_SECRET', Utilities.getUuid() + Utilities.getUuid());
  if (!prop('PHOTO_FOLDER_ID')) P.setProperty('PHOTO_FOLDER_ID', DriveApp.createFolder('Alliance Event Photos').getId());
  if (!prop('ADMIN_PASSWORD')) throw new Error('Add ADMIN_PASSWORD under Project Settings > Script properties, then run setup again.');
  Logger.log('Setup complete.');
}

// ---------- sheet helpers ----------
const sheet = n => SpreadsheetApp.getActive().getSheetByName(n);
function rowsOf(n) {
  const v = sheet(n).getDataRange().getValues(), h = v.shift();
  return v.map((r, i) => { const o = { _row: i + 2 }; h.forEach((k, j) => o[k] = String(r[j] == null ? '' : r[j])); return o; }).filter(o => o[h[0]]);
}
function addRow(n, obj) {
  const s = sheet(n), r = s.getLastRow() + 1, rng = s.getRange(r, 1, 1, SH[n].length);
  rng.setNumberFormat('@'); rng.setValues([SH[n].map(k => obj[k] == null ? '' : String(obj[k]))]);
}
const setCell = (n, row, col, val) => { const c = sheet(n).getRange(row, SH[n].indexOf(col) + 1); c.setNumberFormat('@'); c.setValue(String(val)); };

// ---------- tokens (stateless: every admin session and every OTP check is a signed token) ----------
const sig = s => Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, prop('TOKEN_SECRET')));
const same = (a, b) => { a = String(a); b = String(b); let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; };
const mint = (parts, ttl) => { const b = parts.concat([Date.now() + ttl]).join('|'); return Utilities.base64EncodeWebSafe(b) + '.' + sig(b); };
function readToken(t) {
  try {
    const x = String(t).split('.'), b = Utilities.newBlob(Utilities.base64DecodeWebSafe(x[0])).getDataAsString();
    if (!same(sig(b), x[1])) return null;
    const p = b.split('|'); return +p[p.length - 1] < Date.now() ? null : p.slice(0, -1);
  } catch (e) { return null; }
}
const who = t => { const p = readToken(t); if (!p || p[0] !== 'adm') fail(401, 'Sign in required.'); return p[1]; };

function login(b) {
  const c = CacheService.getScriptCache(), n = +(c.get('fails') || 0), pw = String(b.password || '');
  if (n >= 10) fail(429, 'Too many failed attempts. Try again in 15 minutes.');
  let role = null;
  if (pw && same(pw, prop('ADMIN_PASSWORD'))) role = 'super_admin';
  else if (pw && prop('STAFF_PASSWORD') && same(pw, prop('STAFF_PASSWORD'))) role = 'checkin_staff';
  if (!role) { c.put('fails', String(n + 1), 900); fail(401, 'Incorrect password.'); }
  c.remove('fails');
  return { data: { name: role === 'super_admin' ? 'Admin' : 'Check-in staff', role: role }, token: mint(['adm', role], 8 * 3600e3) };
}

// ---------- OTP ----------
function normId(b) {
  const ch = b.channel, id = String(b.identifier || '').trim().toLowerCase();
  if (ch !== 'email' && ch !== 'mobile') fail(400, 'Invalid channel.');
  if (ch === 'email' && (!/^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(id) || id.length > 120)) fail(400, 'Enter a valid email address.');
  if (ch === 'mobile' && !/^[6-9]\d{9}$/.test(id)) fail(400, 'Enter a valid 10-digit mobile number.');
  if (ch === 'mobile' && !smsOn()) fail(400, 'Mobile OTP is not enabled.');
  return { ch: ch, id: id };
}
const hashOtp = (ch, id, code) => sig(ch + '|' + id + '|' + code);
function otpSend(b) {
  const x = normId(b), c = CacheService.getScriptCache(), k = x.ch + ':' + x.id;
  if (c.get('t:' + k)) fail(429, 'Wait 30 seconds before requesting another OTP.');
  const code = String(parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 8), 16) % 900000 + 100000);
  c.put('o:' + k, JSON.stringify({ h: hashOtp(x.ch, x.id, code), n: 0 }), 600);
  c.put('t:' + k, '1', 30);
  if (x.ch === 'email') {
    try { MailApp.sendEmail({ to: x.id, subject: 'Your Alliance University event OTP', name: 'Alliance University Events', body: 'Your verification code is ' + code + '. It expires in 10 minutes. Do not share it with anyone.' }); }
    catch (e) { c.remove('t:' + k); fail(502, 'Could not send email. Check the address and try again.'); }
  } else {
    const r = UrlFetchApp.fetch('https://control.msg91.com/api/v5/flow/', { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { authkey: prop('MSG91_AUTH_KEY') },
      payload: JSON.stringify({ template_id: prop('MSG91_TEMPLATE_ID'), short_url: '0', recipients: [{ mobiles: prop('COUNTRY_CODE', '91') + x.id, otp: code }] }) });
    if (r.getResponseCode() >= 300) { c.remove('t:' + k); fail(502, 'Could not send SMS. Try again.'); }
  }
  return { sent: true };
}
function otpVerify(b) {
  const x = normId(b), c = CacheService.getScriptCache(), k = 'o:' + x.ch + ':' + x.id, raw = c.get(k);
  if (!raw) fail(400, 'OTP expired. Request a new one.');
  const o = JSON.parse(raw);
  if (o.n >= 5) fail(429, 'Too many attempts. Request a new OTP.');
  o.n++; c.put(k, JSON.stringify(o), 600);
  if (!same(o.h, hashOtp(x.ch, x.id, String(b.otp || '')))) fail(400, 'Incorrect OTP.');
  c.remove(k);
  return { token: mint(['ver', x.ch, x.id], 30 * 60e3) };
}
const verified = (t, ch, id) => { const p = readToken(t); return !!p && p[0] === 'ver' && p[1] === ch && p[2] === id; };

// ---------- events ----------
const evOut = e => ({ id: e.id, name: e.name, description: e.description, category: e.category, venue: e.venue, event_date: e.event_date, start_time: e.start_time, end_time: e.end_time,
  reg_opens: e.reg_opens, reg_deadline: e.reg_deadline, valid_until: e.valid_until, capacity: +e.capacity, status: e.status, reg_open: e.reg_open === 'TRUE', archived: e.archived === 'TRUE' });
function withStats(e, regs) {
  const all = regs.filter(r => r.event_id === e.id), a = all.filter(r => r.status !== 'Cancelled'), o = evOut(e);
  o.registered = a.length; o.verified = a.length; o.checked_in = all.filter(r => r.checked_in_at).length;
  o.cancelled = all.length - a.length; o.expired = new Date(e.valid_until) < new Date(); o.seats_left = Math.max(0, o.capacity - a.length);
  return o;
}
function publicEvents() {
  const regs = rowsOf('Registrations');
  return rowsOf('Events').filter(e => e.archived !== 'TRUE' && e.status !== 'Cancelled').map(e => withStats(e, regs)).filter(e => !e.expired)
    .sort((a, b) => a.event_date < b.event_date ? -1 : 1);
}
function oneEvent(id) {
  const e = rowsOf('Events').find(x => x.id === id && x.archived !== 'TRUE');
  if (!e) fail(404, 'Event not found.');
  const s = withStats(e, rowsOf('Registrations'));
  if (s.expired) fail(410, 'This event has ended and registration is no longer available.');
  return s;
}
function createEvent(B) {
  const fe = {}, D = /^\d{4}-\d{2}-\d{2}$/, T = /^\d{2}:\d{2}$/;
  if (!B.name || String(B.name).trim().length < 3) fe.name = 'Event name must be at least 3 characters.';
  if (!B.event_date || !D.test(B.event_date)) fe.event_date = 'Event date is required (YYYY-MM-DD).';
  if (!(+B.capacity >= 1) || +B.capacity > 100000) fe.capacity = 'Capacity must be at least 1.';
  ['start_time', 'end_time'].forEach(k => { if (B[k] && !T.test(B[k])) fe[k] = 'Use the format HH:MM.'; });
  ['reg_opens', 'reg_deadline'].forEach(k => { if (B[k] && !D.test(B[k])) fe[k] = 'Use the format YYYY-MM-DD.'; });
  if (B.start_time && B.end_time && B.end_time <= B.start_time) fe.end_time = 'End time must be after start time.';
  if (B.reg_opens && B.reg_deadline && B.reg_opens > B.reg_deadline) fe.reg_deadline = 'Registration deadline must be on or after the opening date.';
  const vu = B.valid_until || (B.event_date + 'T23:59:59+05:30'), vd = new Date(vu);
  if (!fe.event_date) { if (isNaN(vd)) fe.valid_until = 'Enter a valid date and time.'; else if (vd <= new Date()) fe.valid_until = 'Validity date must be in the future.'; }
  if (Object.keys(fe).length) fail(400, 'Please fix the highlighted fields.', fe);
  const e = { id: Utilities.getUuid(), name: String(B.name).trim(), description: B.description || '', category: B.category || 'General', venue: B.venue || '', event_date: B.event_date,
    start_time: B.start_time || '', end_time: B.end_time || '', reg_opens: B.reg_opens || '', reg_deadline: B.reg_deadline || '', valid_until: vd.toISOString(), capacity: +B.capacity,
    status: 'Upcoming', reg_open: 'TRUE', archived: 'FALSE', created_at: new Date().toISOString() };
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try { addRow('Events', e); } finally { lock.releaseLock(); }
  return evOut(e);
}
function patchEvent(id, B) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const e = rowsOf('Events').find(x => x.id === id);
    if (!e) fail(404, 'Event not found.');
    if ('reg_open' in B) setCell('Events', e._row, 'reg_open', B.reg_open ? 'TRUE' : 'FALSE');
    if (B.valid_until) { const d = new Date(B.valid_until); if (isNaN(d)) fail(400, 'Enter a valid date and time.', { valid_until: 'Enter a valid date and time.' }); setCell('Events', e._row, 'valid_until', d.toISOString()); }
    if (B.status && ['Upcoming', 'Active', 'Completed', 'Cancelled'].indexOf(B.status) >= 0) setCell('Events', e._row, 'status', B.status);
    if (B.archive) { setCell('Events', e._row, 'archived', 'TRUE'); setCell('Events', e._row, 'reg_open', 'FALSE'); }
  } finally { lock.releaseLock(); }
  return { ok: true };
}

// ---------- registration (serialised by a lock: capacity and duplicates cannot be beaten by simultaneous users) ----------
function register(d) {
  const g = k => String(d[k] == null ? '' : d[k]).trim(), fe = {}, name = g('name'), email = g('email').toLowerCase(), mb = g('mobile'), type = g('type');
  if (name.length < 2) fe.name = 'Full name must be at least 2 characters.';
  else if (name.length > 120 || !/^[\p{L}][\p{L} .'-]*$/u.test(name)) fe.name = 'Name can only contain letters, spaces, dots, hyphens and apostrophes.';
  if (!/^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(email)) fe.email = 'Enter a valid email address.';
  if (!/^[6-9]\d{9}$/.test(mb)) fe.mobile = 'Enter a valid 10-digit mobile number.';
  if (['Student', 'Faculty', 'Guest', 'Alumni'].indexOf(type) < 0) fe.type = 'Choose a participant type.';
  if (Object.keys(fe).length) fail(400, 'Please fix the highlighted fields.', fe);
  const mo = smsOn();
  if (!verified(g('emailToken'), 'email', email)) fail(400, 'Verify your email with the OTP.', { email: 'Verify your email with the OTP.' });
  if (mo && !verified(g('mobileToken'), 'mobile', mb)) fail(400, 'Verify your mobile number with the OTP.', { mobile: 'Verify your mobile number with the OTP.' });
  let bytes = null; const photo = d.photoId ? assemblePhoto(d.photoId, d.photoN) : String(d.photo || '');
  if (photo) {
    if (g('consent') !== 'true') fail(400, 'Photo consent is required to store a photograph.');
    const m = photo.match(/^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/);
    if (!m || m[1].length > 4e6) fail(400, 'Photo must be a JPG image under 3 MB.');
    bytes = Utilities.base64Decode(m[1]);
    if (bytes[0] !== -1 || bytes[1] !== -40) fail(400, 'Photo must be a JPG image.');
  }
  const lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (e) { fail(503, 'The server is busy. Please try again in a moment.'); }
  try {
    const ev = rowsOf('Events').find(x => x.id === g('eventId') && x.archived !== 'TRUE');
    if (!ev) fail(404, 'Event not found.');
    if (new Date(ev.valid_until) < new Date()) fail(410, 'This event has ended and registration is no longer available.');
    const today = istDate(new Date());
    if (ev.reg_open !== 'TRUE' || ev.status === 'Completed' || ev.status === 'Cancelled' || (ev.reg_deadline && today > ev.reg_deadline) || (ev.reg_opens && today < ev.reg_opens))
      fail(409, 'Registration is closed for this event.');
    const regs = rowsOf('Registrations'), act = regs.filter(r => r.event_id === ev.id && r.status !== 'Cancelled');
    if (act.length >= +ev.capacity) fail(409, 'This event is full.');
    if (act.some(r => r.email === email || r.mobile === mb)) fail(409, 'You are already registered for this event.');
    let pid = '';
    if (bytes) pid = DriveApp.getFolderById(prop('PHOTO_FOLDER_ID')).createFile(Utilities.newBlob(bytes, 'image/jpeg', 'p-' + Utilities.getUuid() + '.jpg')).getId();
    let code; do { code = 'AU' + Utilities.getUuid().replace(/-/g, '').slice(0, 6).toUpperCase(); } while (regs.some(r => r.reg_code === code));
    addRow('Registrations', { reg_code: code, event_id: ev.id, event_name: ev.name, name: name, email: email, mobile: mb, organization: g('org'), department: g('dept'), type: type,
      email_verified: 'TRUE', mobile_verified: mo ? 'TRUE' : 'N/A', status: 'Registered', registered_at: new Date().toISOString(), checked_in_at: '', photo_id: pid, photo_consent: g('consent') === 'true' ? 'TRUE' : 'FALSE' });
    return { registrationCode: code };
  } finally { lock.releaseLock(); }
}

// ---------- admin data ----------
function filtered(Q) {
  const q = String(Q.q || '').toLowerCase(), from = Q.from, to = Q.to;
  return rowsOf('Registrations').filter(r => {
    const day = istDate(new Date(r.registered_at));
    return (!q || (r.name + ' ' + r.email + ' ' + r.mobile + ' ' + r.reg_code).toLowerCase().indexOf(q) >= 0) && (!Q.eventId || r.event_id === Q.eventId) &&
      (!Q.status || r.status === Q.status) && Q.verified !== '0' && (!from || day >= from) && (!to || day <= to);
  }).reverse();
}
const regOut = r => ({ id: r.reg_code, reg_code: r.reg_code, status: r.status, email_verified: true, mobile_verified: true, registered_at: r.registered_at, checked_in_at: r.checked_in_at || null,
  event_id: r.event_id, events: { name: r.event_name }, participants: { full_name: r.name, email: r.email, mobile: r.mobile }, photoId: r.photo_id || null, photoUrl: null });
const photoUrl = id => 'data:image/jpeg;base64,' + Utilities.base64Encode(DriveApp.getFileById(id).getBlob().getBytes());
function exportData(Q) {
  const regs = rowsOf('Registrations'), evs = rowsOf('Events').filter(e => e.archived !== 'TRUE' && (!Q.eventId || e.id === Q.eventId)).map(e => withStats(e, regs)), list = filtered(Q);
  const ist = (iso, f) => iso ? Utilities.formatDate(new Date(iso), 'Asia/Kolkata', f) : '';
  const cell = v => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) ? "'" + v : v;   // blocks spreadsheet formula injection
  const clean = o => { Object.keys(o).forEach(k => o[k] = cell(o[k])); return o; };
  return {
    events: evs.map(e => clean({ 'Event ID': e.id, 'Event Name': e.name, Category: e.category, Venue: e.venue, 'Event Date': e.event_date, 'Valid Until (IST)': ist(e.valid_until, 'dd/MM/yyyy HH:mm'), Status: e.expired ? 'Expired' : e.status, Capacity: e.capacity, Registered: e.registered })),
    details: list.map(r => clean({ 'Registration ID': r.reg_code, 'Event ID': r.event_id, 'Event Name': r.event_name, 'Participant Name': r.name, 'Email Address': r.email, 'Mobile Number': r.mobile,
      Organization: r.organization, Department: r.department, Type: r.type, 'Email Verification': 'Verified', 'Mobile Verification': r.mobile_verified === 'TRUE' ? 'Verified' : 'Not required',
      'Registration Date': ist(r.registered_at, 'dd/MM/yyyy'), 'Registration Time': ist(r.registered_at, 'HH:mm:ss'), Status: r.checked_in_at ? 'Checked in' : r.status, 'Check-in Time': ist(r.checked_in_at, 'dd/MM/yyyy HH:mm'), Photograph: r.photo_id ? 'On file (Drive)' : 'None' })),
    stats: evs.map(e => ({ Event: e.name, Registered: e.registered, 'Checked In': e.checked_in, Cancelled: e.cancelled, Capacity: e.capacity, 'Fill %': Math.round(e.registered / e.capacity * 100) }))
  };
}
function checkin(B) {
  const code = String(B.code || '').trim().toUpperCase();
  if (!/^AU[0-9A-F]{6}$/.test(code)) fail(400, 'Invalid registration code.', { code: 'Invalid registration code.' });
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const r = rowsOf('Registrations').find(x => x.reg_code === code);
    if (!r) fail(404, 'Invalid code. No registration found.');
    if (r.status === 'Cancelled') fail(409, 'This registration was cancelled.');
    if (r.checked_in_at) fail(409, r.name + ' is already checked in.');
    const now = new Date().toISOString(); setCell('Registrations', r._row, 'checked_in_at', now);
    return { name: r.name, event: r.event_name, checkedInAt: now, photoUrl: r.photo_id ? photoUrl(r.photo_id) : null };
  } finally { lock.releaseLock(); }
}

// ---------- router ----------
function route(q) {
  const p = String(q.path || ''), M = q.method || 'GET', Q = q.query || {}, D = q.data || {}; let m;
  if (p === '/api/config') return W({ mobileOtp: smsOn() });
  if (p === '/api/events') return W(publicEvents());
  if ((m = p.match(/^\/api\/events\/([\w-]+)$/))) return W(oneEvent(m[1]));
  if (p === '/api/otp/send') return W(otpSend(D));
  if (p === '/api/otp/verify') return W(otpVerify(D));
  if (p === '/api/register') return W(register(D));
  if (p === '/api/photo-chunk') return W(photoChunk(D));
  if (p === '/api/admin/auth/login') return login(D);
  if (p === '/api/admin/auth/logout') return { data: { ok: true }, token: '' };
  const role = who(q.token), mgr = () => { if (role !== 'super_admin') fail(403, 'Your role cannot do this.'); };
  if (p === '/api/admin/auth/me') return W({ name: role === 'super_admin' ? 'Admin' : 'Check-in staff', role: role });
  if (p === '/api/admin/stats') {
    const regs = rowsOf('Registrations'), L = rowsOf('Events').filter(e => e.archived !== 'TRUE').map(e => withStats(e, regs)), n = k => L.reduce((a, e) => a + e[k], 0);
    return W({ totalEvents: L.length, upcoming: L.filter(e => e.status === 'Upcoming' && !e.expired).length, completed: L.filter(e => e.status === 'Completed' || e.expired).length,
      registrations: n('registered'), verified: n('verified'), checkedIn: n('checked_in'), perEvent: L });
  }
  if (p === '/api/admin/events' && M === 'GET') { const regs = rowsOf('Registrations'); return W(rowsOf('Events').filter(e => e.archived !== 'TRUE').map(e => withStats(e, regs)).reverse()); }
  if (p === '/api/admin/events' && M === 'POST') { mgr(); return W(createEvent(D)); }
  if ((m = p.match(/^\/api\/admin\/events\/([\w-]+)$/))) { mgr(); return W(patchEvent(m[1], M === 'DELETE' ? { archive: true } : D)); }
  if (p === '/api/admin/registrations') {
    const L = filtered(Q), pg = Math.max(1, +(Q.page || 1)); return W({ total: L.length, page: pg, rows: L.slice((pg - 1) * 50, pg * 50).map(regOut) });
  }
  if ((m = p.match(/^\/api\/admin\/registrations\/([\w-]+)\/cancel$/))) {
    mgr(); const lock = LockService.getScriptLock(); lock.waitLock(20000);
    try { const r = rowsOf('Registrations').find(x => x.reg_code === m[1]); if (!r) fail(404, 'Registration not found.'); setCell('Registrations', r._row, 'status', 'Cancelled'); } finally { lock.releaseLock(); }
    return W({ ok: true });
  }
  if (p === '/api/admin/photo') { const r = rowsOf('Registrations').find(x => x.photo_id && x.photo_id === String(Q.id)); if (!r) fail(404, 'Photo not found.'); return W({ photoUrl: photoUrl(r.photo_id) }); }
  if (p === '/api/admin/checkin') return W(checkin(D));
  if (p === '/api/admin/export-data') return W(exportData(Q));
  fail(404, 'Not found.');
}
// Photos arrive in small pieces because browsers send everything as GET requests (Google's redirect breaks cross-site POST).
function photoChunk(d) {
  const id = String(d.id || ''), i = +d.i, n = +d.n, part = String(d.part || '');
  if (!/^[a-z0-9]{12,40}$/.test(id) || !(i >= 0 && i < n && n <= 40) || part.length > 4000 || !/^[A-Za-z0-9+\/=:;,\-]*$/.test(part)) fail(400, 'Invalid photo upload.');
  CacheService.getScriptCache().put('ph:' + id + ':' + i, part, 600);
  return { ok: true };
}
function assemblePhoto(id, n) {
  id = String(id || ''); n = +n;
  if (!/^[a-z0-9]{12,40}$/.test(id) || !(n >= 1 && n <= 40)) fail(400, 'Invalid photo upload.');
  const c = CacheService.getScriptCache(); let s = '';
  for (let i = 0; i < n; i++) { const p = c.get('ph:' + id + ':' + i); if (p == null) fail(400, 'Photo upload incomplete. Please retake the photo or skip it.'); s += p; }
  return s;
}
function respond(fn) {
  let out;
  try { out = fn(); }
  catch (x) { out = (x && x.status) ? { error: x.error, status: x.status, fields: x.fields } : (console.error(x), { error: 'Something went wrong. Try again.', status: 500 }); }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
function doGet(e) {
  if (!e || !e.parameter || !e.parameter.d) return ContentService.createTextOutput('Alliance Events API is running.');
  return respond(() => route(JSON.parse(e.parameter.d)));
}
function doPost(e) { return respond(() => route(JSON.parse(e.postData.contents))); }
