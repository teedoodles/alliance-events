const router = require('express').Router(), { z } = require('zod'), multer = require('multer');
const QRCode = require('qrcode'), crypto = require('crypto'), rateLimit = require('express-rate-limit');
const db = require('../db'), otp = require('../otp'), { h, httpError, dbCheck } = require('../util');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1 } });
const otpLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 120, message: { error: 'Too many OTP requests. Try again later.' } });
const COLS = 'id,name,description,category,venue,event_date,start_time,end_time,reg_opens,reg_deadline,capacity,status,reg_open,registered,valid_until,expired';
const png = (res, text) => QRCode.toBuffer(text, { width: 400, margin: 2 }).then(b => res.type('png').send(b));
const imgKind = b => (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) ? 'jpg' : (b.length > 4 && b.readUInt32BE(0) === 0x89504E47) ? 'png' : null;
const mobileRx = /^[6-9]\d{9}$/;

router.get('/events', h(async (_q, res) => {
  const rows = dbCheck(await db.from('event_stats').select(COLS).eq('archived', false).eq('expired', false).neq('status', 'Cancelled').order('event_date'));
  res.json(rows.map(e => ({ ...e, seats_left: Math.max(0, e.capacity - e.registered) })));
}));
router.get('/events/:id', h(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) throw httpError(404, 'Event not found.');
  const e = dbCheck(await db.from('event_stats').select(COLS).eq('id', req.params.id).eq('archived', false).maybeSingle());
  if (!e) throw httpError(404, 'Event not found.');
  if (e.expired) throw httpError(410, 'This event has ended and registration is no longer available.');
  res.json({ ...e, seats_left: Math.max(0, e.capacity - e.registered) });
}));
// Event QR encodes only the public registration link.
router.get('/events/:id/qr.png', h(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) throw httpError(404, 'Event not found.');
  await png(res, `${process.env.FRONTEND_URL.replace(/\/$/, '')}/#event-${req.params.id}`);
}));
// Participant QR encodes only the registration code.
router.get('/registrations/:code/qr.png', h(async (req, res) => {
  if (!/^AU[0-9A-F]{6}$/.test(req.params.code)) throw httpError(404, 'Not found.');
  await png(res, req.params.code);
}));

const idSchema = z.object({ channel: z.enum(['email', 'mobile']), identifier: z.string().trim().toLowerCase().max(120) });
const normalise = b => {
  const v = idSchema.parse(b);
  if (v.channel === 'email' && !z.string().email().safeParse(v.identifier).success) throw httpError(400, 'Enter a valid email address.');
  if (v.channel === 'mobile' && !mobileRx.test(v.identifier)) throw httpError(400, 'Enter a valid 10-digit mobile number.');
  return v;
};
router.post('/otp/send', otpLimit, h(async (req, res) => { const v = normalise(req.body); await otp.issue(v.channel, v.identifier); res.json({ sent: true }); }));
router.post('/otp/verify', otpLimit, h(async (req, res) => {
  const v = normalise(req.body), code = z.string().regex(/^\d{6}$/).parse(req.body.otp);
  res.json({ token: await otp.verify(v.channel, v.identifier, code) });
}));

const regSchema = z.object({
  eventId: z.string({ required_error: 'Event is missing.' }).uuid('Invalid event.'), name: z.string({ required_error: 'Full name is required.' }).trim().min(2, 'Full name must be at least 2 characters.').max(120, 'Full name is too long.').regex(/^[\p{L}][\p{L} .'-]*$/u, 'Name can only contain letters, spaces, dots, hyphens and apostrophes.'),
  email: z.string({ required_error: 'Email is required.' }).trim().toLowerCase().email('Enter a valid email address.'), mobile: z.string({ required_error: 'Mobile number is required.' }).regex(mobileRx, 'Enter a valid 10-digit mobile number.'),
  org: z.string().trim().max(150).default(''), dept: z.string().trim().max(150).default(''),
  type: z.enum(['Student', 'Faculty', 'Guest', 'Alumni'], { errorMap: () => ({ message: 'Choose a participant type.' }) }), consent: z.enum(['true', 'false']).default('false'),
  emailToken: z.string({ required_error: 'Verify your email with the OTP.' }), mobileToken: z.string({ required_error: 'Verify your mobile number with the OTP.' })
});
const MSG = { EVENT_NOT_FOUND: [404, 'Event not found.'], REGISTRATION_CLOSED: [409, 'Registration is closed for this event.'], EVENT_EXPIRED: [410, 'This event has ended and registration is no longer available.'], EVENT_FULL: [409, 'This event is full.'], DUPLICATE: [409, 'You are already registered for this event.'] };

router.post('/register', otpLimit, upload.single('photo'), h(async (req, res) => {
  const b = regSchema.parse(req.body);
  if (!otp.checkToken(b.emailToken, 'email', b.email) || !otp.checkToken(b.mobileToken, 'mobile', b.mobile))
    throw httpError(400, 'Verify both your email and mobile number first.');
  let photoRef = null;
  if (req.file) {
    if (b.consent !== 'true') throw httpError(400, 'Photo consent is required to store a photograph.');
    const kind = imgKind(req.file.buffer);
    if (!kind) throw httpError(400, 'Photo must be a JPG or PNG image.');
    photoRef = `${b.eventId}/${crypto.randomUUID()}.${kind}`;
    const up = await db.storage.from(process.env.PHOTO_BUCKET || 'participant-photos').upload(photoRef, req.file.buffer, { contentType: kind === 'jpg' ? 'image/jpeg' : 'image/png' });
    if (up.error) { console.error(up.error); throw httpError(500, 'Photo upload failed. Try again or skip the photo.'); }
  }
  const { data, error } = await db.rpc('register_for_event', { p_event: b.eventId, p_name: b.name, p_email: b.email, p_mobile: b.mobile,
    p_org: b.org, p_dept: b.dept, p_type: b.type, p_photo: photoRef, p_consent: b.consent === 'true' });
  if (error) {
    if (photoRef) await db.storage.from(process.env.PHOTO_BUCKET || 'participant-photos').remove([photoRef]);
    const hit = Object.keys(MSG).find(k => error.message.includes(k));
    if (hit) throw httpError(...MSG[hit]);
    console.error(error); throw httpError(500, 'Registration failed. Try again.');
  }
  res.status(201).json({ registrationCode: data.reg_code, qrUrl: `/api/registrations/${data.reg_code}/qr.png` });
}));
module.exports = router;
