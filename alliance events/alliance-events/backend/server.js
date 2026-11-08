require('dotenv').config();
const express = require('express'), helmet = require('helmet'), cors = require('cors');
const cookieParser = require('cookie-parser'), rateLimit = require('express-rate-limit');
const { ZodError } = require('zod');

for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'JWT_SECRET', 'OTP_SECRET', 'FRONTEND_URL']) {
  if (!process.env[k]) { console.error(`Missing env var ${k}. Copy .env.example to .env and fill it in.`); process.exit(1); }
}
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: (process.env.FRONTEND_ORIGIN || '').split(',').filter(Boolean), credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 3000 }));

app.get('/health', (_q, s) => s.json({ ok: true }));
app.use('/api', require('./src/routes/public'));
app.use('/api/admin', require('./src/routes/admin'));

app.use((err, _q, s, _n) => {
  if (err instanceof ZodError) { const fields = {}; err.issues.forEach(i => { const k = i.path.join('.') || 'form'; fields[k] = fields[k] || i.message; }); return s.status(400).json({ error: 'Please fix the highlighted fields.', fields }); }
  if (err.code === 'LIMIT_FILE_SIZE') return s.status(400).json({ error: 'Photo must be under 3 MB.' });
  const status = err.status || 500;
  if (status === 500) console.error(err);
  s.status(status).json({ error: status === 500 ? 'Something went wrong. Try again.' : err.message });
});
app.listen(process.env.PORT || 3000, () => console.log('API running on port ' + (process.env.PORT || 3000)));
