const router = require('express').Router(), { z } = require('zod'), bcrypt = require('bcryptjs'), rateLimit = require('express-rate-limit');
const ExcelJS = require('exceljs'), db = require('../db'), { h, httpError, dbCheck } = require('../util');
const { setSession, clearSession, csrf, requireRole } = require('../auth');
const ANY = requireRole(), MGR = requireRole('super_admin', 'event_manager'), SUPER = requireRole('super_admin');
const BUCKET = process.env.PHOTO_BUCKET || 'participant-photos';
router.use(csrf);

// ---------- auth ----------
const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, message: { error: 'Too many sign-in attempts. Try again later.' } });
const DUMMY = bcrypt.hashSync('not-a-real-password', 12);
router.post('/auth/login', loginLimit, h(async (req, res) => {
  const b = z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email.'), password: z.string().min(1, 'Password is required.') }).parse(req.body);
  const a = dbCheck(await db.from('admins').select('*').eq('email', b.email).maybeSingle());
  const ok = await bcrypt.compare(b.password, a ? a.password_hash : DUMMY);
  if (!a || !ok) throw httpError(401, 'Incorrect email or password.');
  setSession(res, a); res.json({ name: a.name, role: a.role });
}));
router.post('/auth/logout', (_q, res) => { clearSession(res); res.json({ ok: true }); });
router.get('/auth/me', ANY, (req, res) => res.json({ name: req.admin.name, role: req.admin.role }));

router.get('/admins', SUPER, h(async (_q, res) => res.json(dbCheck(await db.from('admins').select('id,name,email,role,created_at').order('created_at')))));
router.post('/admins', SUPER, h(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2), email: z.string().trim().toLowerCase().email(),
    password: z.string().min(10, 'Password must be at least 10 characters.'), role: z.enum(['super_admin', 'event_manager', 'checkin_staff']) }).parse(req.body);
  const { data, error } = await db.from('admins').insert({ name: b.name, email: b.email, role: b.role, password_hash: await bcrypt.hash(b.password, 12) }).select('id,name,email,role').single();
  if (error) throw httpError(error.code === '23505' ? 409 : 500, error.code === '23505' ? 'An admin with this email already exists.' : 'Database error');
  res.status(201).json(data);
}));

// ---------- events ----------
const blank = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === '' ? undefined : v]));
const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.');
const T = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use the format HH:MM.');
const evShape = z.object({
  name: z.string({ required_error: 'Event name is required.' }).trim().min(3, 'Event name must be at least 3 characters.').max(150),
  description: z.string().max(2000).optional(), category: z.string().trim().max(60).optional(), venue: z.string().trim().max(200).optional(),
  event_date: D, start_time: T.optional(), end_time: T.optional(), reg_opens: D.optional(), reg_deadline: D.optional(),
  valid_until: z.string().datetime({ offset: true, message: 'Use an ISO date and time, e.g. 2026-12-05T18:00:00+05:30.' }).optional(),
  capacity: z.coerce.number({ invalid_type_error: 'Capacity must be a number.' }).int().min(1, 'Capacity must be at least 1.').max(100000),
  status: z.enum(['Upcoming', 'Active', 'Completed', 'Cancelled']).optional(), reg_open: z.boolean().optional()
});
const rules = (v, ctx, creating) => {
  const bad = (path, message) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (v.start_time && v.end_time && v.end_time <= v.start_time) bad('end_time', 'End time must be after start time.');
  if (v.reg_opens && v.reg_deadline && v.reg_opens > v.reg_deadline) bad('reg_deadline', 'Registration deadline must be on or after the opening date.');
  if (v.valid_until && v.reg_opens && new Date(v.valid_until) < new Date(v.reg_opens)) bad('valid_until', 'Validity must be after registration opens.');
  if (creating && v.valid_until && new Date(v.valid_until) <= new Date()) bad('valid_until', 'Validity date must be in the future.');
  if (creating && !v.valid_until && v.event_date < new Date().toISOString().slice(0, 10)) bad('event_date', 'Event date cannot be in the past.');
};
const createSchema = evShape.superRefine((v, c) => rules(v, c, true));
const patchSchema = evShape.partial().superRefine((v, c) => rules(v, c, false));
const uuid = z.string().uuid('Invalid id.');

router.get('/events', ANY, h(async (req, res) => {
  let q = db.from('event_stats').select('*').order('event_date', { ascending: false });
  if (req.query.archived !== '1') q = q.eq('archived', false);
  res.json(dbCheck(await q));
}));
router.post('/events', MGR, h(async (req, res) => {
  const v = createSchema.parse(blank(req.body));
  v.valid_until = v.valid_until || `${v.event_date}T23:59:59+05:30`; // default: event day ends at midnight IST
  res.status(201).json(dbCheck(await db.from('events').insert(v).select().single()));
}));
router.patch('/events/:id', MGR, h(async (req, res) => {
  const id = uuid.parse(req.params.id), v = patchSchema.parse(blank(req.body));
  if (!Object.keys(v).length) throw httpError(400, 'Nothing to update.');
  const row = dbCheck(await db.from('events').update(v).eq('id', id).select().maybeSingle());
  if (!row) throw httpError(404, 'Event not found.'); res.json(row);
}));
router.delete('/events/:id', MGR, h(async (req, res) => {
  const id = uuid.parse(req.params.id);
  if (req.query.hard === '1') { if (req.admin.role !== 'super_admin') throw httpError(403, 'Only a super admin can permanently delete.'); dbCheck(await db.from('events').delete().eq('id', id)); }
  else dbCheck(await db.from('events').update({ archived: true, reg_open: false }).eq('id', id));
  res.json({ ok: true });
}));

// ---------- stats ----------
router.get('/stats', ANY, h(async (_q, res) => {
  const ev = dbCheck(await db.from('event_stats').select('id,name,status,expired,capacity,registered,verified,checked_in,cancelled').eq('archived', false));
  const sum = k => ev.reduce((n, e) => n + Number(e[k]), 0);
  res.json({ totalEvents: ev.length, upcoming: ev.filter(e => e.status === 'Upcoming' && !e.expired).length, completed: ev.filter(e => e.status === 'Completed' || e.expired).length,
    registrations: sum('registered'), verified: sum('verified'), checkedIn: sum('checked_in'), perEvent: ev });
}));

// ---------- registrations ----------
const filterSchema = z.object({
  q: z.string().max(80).optional(), eventId: uuid.optional(), from: D.optional(), to: D.optional(),
  verified: z.enum(['0', '1']).optional(), status: z.enum(['Registered', 'Cancelled']).optional(),
  page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50)
});
const SEL = 'id,reg_code,status,email_verified,mobile_verified,registered_at,checked_in_at,event_id,events(name,event_date),participants!inner(full_name,email,mobile,organization,department,participant_type,photo_ref)';
const build = f => {
  let q = db.from('registrations').select(SEL, { count: 'exact' }).order('registered_at', { ascending: false });
  if (f.eventId) q = q.eq('event_id', f.eventId);
  if (f.status) q = q.eq('status', f.status);
  if (f.from) q = q.gte('registered_at', `${f.from}T00:00:00+05:30`);
  if (f.to) q = q.lte('registered_at', `${f.to}T23:59:59+05:30`);
  if (f.verified === '1') q = q.eq('email_verified', true).eq('mobile_verified', true);
  if (f.verified === '0') q = q.or('email_verified.eq.false,mobile_verified.eq.false');
  const s = (f.q || '').replace(/[^\p{L}\p{N}@.+ _-]/gu, '').trim();
  if (s) q = q.or(`full_name.ilike.%${s}%,email.ilike.%${s}%,mobile.ilike.%${s}%`, { referencedTable: 'participants' });
  return q;
};
const withPhotos = async rows => {
  const paths = rows.map(r => r.participants.photo_ref).filter(Boolean);
  const map = {};
  if (paths.length) (await db.storage.from(BUCKET).createSignedUrls(paths, 3600)).data?.forEach(x => { if (x.path) map[x.path] = x.signedUrl; });
  return rows.map(r => ({ ...r, photoUrl: map[r.participants.photo_ref] || null }));
};
router.get('/registrations', ANY, h(async (req, res) => {
  const f = filterSchema.parse(req.query), from = (f.page - 1) * f.limit;
  const { data, error, count } = await build(f).range(from, from + f.limit - 1);
  if (error) { console.error(error); throw httpError(500, 'Database error'); }
  res.json({ total: count, page: f.page, rows: await withPhotos(data) });
}));
router.patch('/registrations/:id/cancel', MGR, h(async (req, res) => {
  const r = dbCheck(await db.from('registrations').update({ status: 'Cancelled' }).eq('id', uuid.parse(req.params.id)).select('id').maybeSingle());
  if (!r) throw httpError(404, 'Registration not found.'); res.json({ ok: true });
}));
// Privacy: permanently erase a participant, their registrations and stored photo.
router.delete('/registrations/:id/data', SUPER, h(async (req, res) => {
  const r = dbCheck(await db.from('registrations').select('participant_id,participants(photo_ref)').eq('id', uuid.parse(req.params.id)).maybeSingle());
  if (!r) throw httpError(404, 'Registration not found.');
  if (r.participants.photo_ref) await db.storage.from(BUCKET).remove([r.participants.photo_ref]);
  dbCheck(await db.from('participants').delete().eq('id', r.participant_id)); res.json({ ok: true });
}));

// ---------- check-in (atomic: two scanners can never both succeed) ----------
router.post('/checkin', ANY, h(async (req, res) => {
  const b = z.object({ code: z.string().trim().toUpperCase().regex(/^AU[0-9A-F]{6}$/, 'Invalid registration code.'), eventId: uuid.optional() }).parse(req.body);
  const r = dbCheck(await db.from('registrations').select('id,status,event_id,checked_in_at,events(name),participants(full_name,photo_ref)').eq('reg_code', b.code).maybeSingle());
  if (!r) throw httpError(404, 'Invalid code. No registration found.');
  if (r.status === 'Cancelled') throw httpError(409, 'This registration was cancelled.');
  if (b.eventId && b.eventId !== r.event_id) throw httpError(409, `Wrong event. This pass is for ${r.events.name}.`);
  const upd = dbCheck(await db.from('registrations').update({ checked_in_at: new Date().toISOString(), checked_in_by: req.admin.sub })
    .eq('id', r.id).eq('status', 'Registered').is('checked_in_at', null).select('checked_in_at'));
  if (!upd.length) throw httpError(409, `${r.participants.full_name} is already checked in.`);
  const [withUrl] = await withPhotos([{ participants: r.participants }]);
  res.json({ name: r.participants.full_name, event: r.events.name, checkedInAt: upd[0].checked_in_at, photoUrl: withUrl.photoUrl });
}));

// ---------- Excel export ----------
const safe = v => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) ? "'" + v : v;       // blocks spreadsheet formula injection
const ist = (iso, opt) => iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', ...opt }) : '';
const sheet = (wb, name, cols, rows) => {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
  rows.forEach(r => ws.addRow(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, safe(v)]))));
  const hd = ws.getRow(1); hd.font = { bold: true, color: { argb: 'FFFFFFFF' } }; hd.height = 22;
  hd.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D3A6B' } }; c.alignment = { vertical: 'middle' }; });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  return ws;
};
router.get('/export', ANY, h(async (req, res) => {
  const f = filterSchema.omit({ page: true, limit: true }).parse(req.query), rows = [];
  for (let from = 0; ; from += 1000) {                         // page through so large events export fully
    const { data, error } = await build(f).range(from, from + 999);
    if (error) { console.error(error); throw httpError(500, 'Database error'); }
    rows.push(...data); if (data.length < 1000) break;
  }
  let sq = db.from('event_stats').select('*').eq('archived', false).order('event_date'); if (f.eventId) sq = sq.eq('id', f.eventId);
  const events = dbCheck(await sq);
  const wb = new ExcelJS.Workbook(); wb.creator = 'Alliance University Events'; wb.created = new Date();
  sheet(wb, 'Event Summary', [['Event ID', 'id', 38], ['Event Name', 'name', 30], ['Category', 'cat', 16], ['Venue', 'venue', 28], ['Event Date', 'date', 14], ['Valid Until (IST)', 'vu', 22], ['Status', 'status', 12], ['Capacity', 'cap', 10], ['Registered', 'reg', 12]],
    events.map(e => ({ id: e.id, name: e.name, cat: e.category, venue: e.venue, date: e.event_date, vu: ist(e.valid_until), status: e.expired ? 'Expired' : e.status, cap: e.capacity, reg: Number(e.registered) })));
  sheet(wb, 'Participant Details', [['Registration ID', 'code', 16], ['Event ID', 'eid', 38], ['Event Name', 'ev', 28], ['Participant Name', 'name', 26], ['Email Address', 'em', 32], ['Mobile Number', 'mb', 15],
    ['Organization', 'org', 24], ['Department', 'dep', 20], ['Type', 'type', 12], ['Email Verification', 'evs', 16], ['Mobile Verification', 'mvs', 16], ['Registration Date', 'rd', 14], ['Registration Time', 'rt', 14],
    ['Status', 'st', 12], ['Check-in Time', 'ci', 20], ['Photograph Reference', 'ph', 44]],
    rows.map(r => ({ code: r.reg_code, eid: r.event_id, ev: r.events?.name, name: r.participants.full_name, em: r.participants.email, mb: r.participants.mobile, org: r.participants.organization, dep: r.participants.department,
      type: r.participants.participant_type, evs: r.email_verified ? 'Verified' : 'Pending', mvs: r.mobile_verified ? 'Verified' : 'Pending',
      rd: ist(r.registered_at, { day: '2-digit', month: '2-digit', year: 'numeric' }), rt: ist(r.registered_at, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
      st: r.status, ci: ist(r.checked_in_at), ph: r.participants.photo_ref ? `${BUCKET}/${r.participants.photo_ref}` : '' })));
  sheet(wb, 'Registration Statistics', [['Event', 'n', 30], ['Registered', 'r', 12], ['Verified', 'v', 12], ['Checked In', 'c', 12], ['Cancelled', 'x', 12], ['Capacity', 'cap', 12], ['Fill %', 'p', 10]],
    events.map(e => ({ n: e.name, r: Number(e.registered), v: Number(e.verified), c: Number(e.checked_in), x: Number(e.cancelled), cap: e.capacity, p: Math.round(Number(e.registered) / e.capacity * 100) })));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="registrations-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
}));
module.exports = router;
