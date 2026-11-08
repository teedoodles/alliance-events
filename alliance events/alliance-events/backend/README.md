# Alliance University Events: Backend API

Node.js + Express + Supabase (Postgres + private photo storage). Email OTP via Resend, SMS OTP via MSG91.

## Setup (15 minutes)
1. **Supabase**: create a project. SQL Editor → paste `schema.sql` → Run. Storage → New bucket `participant-photos` (**Public OFF**).
2. `cp .env.example .env` and fill in `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (Project Settings → API → service_role; server only, never in frontend), plus `JWT_SECRET` and `OTP_SECRET` (generate commands are in `.env.example`).
3. `npm install`
4. First admin: `npm run create-admin -- "Your Name" you@alliance.edu.in "LongPassword123" super_admin`
5. `npm run dev` → http://localhost:3000/health
6. **Real OTPs**: set `OTP_MODE=live`. Resend: verify your sending domain, add `RESEND_API_KEY` and `EMAIL_FROM`. MSG91: create an OTP flow template with an `otp` variable (DLT-approved for India), add `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID`. With `OTP_MODE=console`, OTPs print in the server log (development only).
7. **Deploy** on Render (Web Service, start `npm start`, add env vars). Set `NODE_ENV=production`. If the frontend is on another domain (Vercel), set `FRONTEND_ORIGIN` to it and `COOKIE_SAMESITE=none`.

## Event validity
Each event has `valid_until` (date and time, default end of event day in IST). After it passes:
- the event disappears from `GET /api/events`
- `GET /api/events/:id` returns **410** "event has ended"
- `POST /api/register` is refused by the database itself, even for people who opened the page earlier

Admins can extend it with `PATCH /api/admin/events/:id`. Closing registration (`reg_open`), the deadline, status and capacity are enforced the same way.

## Many users at once
- Registration runs in one database transaction (`register_for_event`) that **locks the event row**, so capacity and duplicate checks cannot be beaten by simultaneous submissions. Overbooking is impossible.
- Duplicates are blocked by event, email and mobile. Check-in is a single conditional update, so two scanners can't both succeed.
- Admin sessions are stateless signed cookies, so any number of admins can be logged in together on any number of server instances.
- OTP limits are per identifier (30 s cooldown, 5 attempts), not per IP, so a whole campus on one Wi-Fi isn't blocked.

## Validation errors
Failed validation returns HTTP 400 with `{ "error": "...", "fields": { "email": "Enter a valid email address." } }`. Show each message beside its field. Other statuses: 409 duplicate/full/closed, 410 expired, 429 too many OTP attempts, 401/403 auth.

## API
Public: `GET /api/events` · `GET /api/events/:id` · `GET /api/events/:id/qr.png` · `POST /api/otp/send` `{channel,identifier}` · `POST /api/otp/verify` `{channel,identifier,otp}` → `{token}` · `POST /api/register` (multipart: eventId, name, email, mobile, org, dept, type, consent, emailToken, mobileToken, photo?) → `{registrationCode, qrUrl}` · `GET /api/registrations/:code/qr.png`

Admin (cookie session; every POST/PATCH/DELETE needs header `X-Requested-With: XMLHttpRequest`, and fetch needs `credentials:'include'`):
`POST /api/admin/auth/login|logout` · `GET /auth/me` · `GET /stats` · `GET|POST /events` · `PATCH|DELETE /events/:id` (`?hard=1` super admin) · `GET /registrations?q&eventId&from&to&verified&status&page` · `PATCH /registrations/:id/cancel` · `DELETE /registrations/:id/data` (erase) · `POST /checkin {code,eventId?}` · `GET|POST /admins` (super admin) · **`GET /export`**

Roles: `super_admin` (everything), `event_manager` (events, cancel), `checkin_staff` (check-in, view, export).

## Excel export
`GET /api/admin/export?eventId=&from=2026-12-01&to=2026-12-31&verified=1` returns a formatted `.xlsx` with sheets **Event Summary**, **Participant Details**, **Registration Statistics**. Filters match the participant table. Photos are not embedded; the sheet holds a private storage reference. Cells starting with `= + - @` are neutralised to block spreadsheet formula injection.

## Test checklist
Register with bad inputs (expect field errors) → valid register → duplicate (409) → set `valid_until` in the past (410) → fill capacity (409) → check-in twice (second is 409) → export.
