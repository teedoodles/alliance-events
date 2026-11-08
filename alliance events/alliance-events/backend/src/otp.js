const crypto = require('crypto'), jwt = require('jsonwebtoken');
const db = require('./db'), { httpError, dbCheck } = require('./util');
const hash = (id, otp) => crypto.createHmac('sha256', process.env.OTP_SECRET).update(`${id}:${otp}`).digest('hex');

async function deliver(channel, to, otp) {
  if (process.env.OTP_MODE !== 'live') return console.log(`[DEV OTP] ${channel} ${to}: ${otp}`);
  if (channel === 'email') {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to, subject: 'Your Alliance University event OTP',
        text: `Your verification code is ${otp}. It expires in 10 minutes. Do not share it with anyone.` })
    });
    if (!r.ok) throw httpError(502, 'Could not send email. Try again.');
  } else {
    const r = await fetch('https://control.msg91.com/api/v5/flow/', {
      method: 'POST', headers: { authkey: process.env.MSG91_AUTH_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_id: process.env.MSG91_TEMPLATE_ID, short_url: '0',
        recipients: [{ mobiles: (process.env.COUNTRY_CODE || '91') + to, otp }] })
    });
    if (!r.ok) throw httpError(502, 'Could not send SMS. Try again.');
  }
}

exports.issue = async (channel, identifier) => {
  const since = new Date(Date.now() - 30000).toISOString();
  const recent = dbCheck(await db.from('otp_verifications').select('id').eq('identifier', identifier).gt('created_at', since).limit(1));
  if (recent.length) throw httpError(429, 'Wait 30 seconds before requesting another OTP.');
  const otp = String(crypto.randomInt(100000, 1000000));
  dbCheck(await db.from('otp_verifications').insert({ channel, identifier, otp_hash: hash(identifier, otp), expires_at: new Date(Date.now() + 10 * 60000).toISOString() }));
  await deliver(channel, identifier, otp);
};

exports.verify = async (channel, identifier, otp) => {
  const rows = dbCheck(await db.from('otp_verifications').select('*').eq('identifier', identifier).eq('channel', channel)
    .eq('verified', false).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1));
  const row = rows[0];
  if (!row) throw httpError(400, 'OTP expired. Request a new one.');
  if (row.attempts >= 5) throw httpError(429, 'Too many attempts. Request a new OTP.');
  dbCheck(await db.from('otp_verifications').update({ attempts: row.attempts + 1 }).eq('id', row.id));
  const a = Buffer.from(row.otp_hash), b = Buffer.from(hash(identifier, otp));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw httpError(400, 'Incorrect OTP.');
  dbCheck(await db.from('otp_verifications').update({ verified: true }).eq('id', row.id));
  return jwt.sign({ ch: channel, id: identifier }, process.env.JWT_SECRET, { expiresIn: '30m' });
};

exports.checkToken = (token, channel, identifier) => {
  try { const p = jwt.verify(token, process.env.JWT_SECRET); return p.ch === channel && p.id === identifier; } catch { return false; }
};
