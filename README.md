# Alliance University Events

Event registration with OTP-verified sign-up, QR passes, optional photo, admin dashboard, QR check-in, event validity dates and Excel export. Data is stored in your own Google Sheet.

```
index.html            the website (served by GitHub Pages from the repository root)
apps-script/Code.gs   the backend (paste into Google Apps Script)
.nojekyll             tells GitHub Pages to serve the files as they are
.gitignore
```

## 1. Backend (Google Sheet + Apps Script)
1. Create a blank Google Sheet. **Extensions → Apps Script**. Replace all code with `apps-script/Code.gs`, then **Ctrl + S**.
2. **Project Settings (gear) → Script properties → Add**: `ADMIN_PASSWORD` = your dashboard password. Optional `STAFF_PASSWORD` for check-in-only staff.
3. In the editor choose the function **setup** (not `prop`) and click **Run**. Allow the permissions. The Sheet now has `Events` and `Registrations` tabs.
4. **Deploy → New deployment → Web app**. Execute as **Me**, Who has access **Anyone**. Copy the Web app URL (ends in `/exec`).
5. Every time `Code.gs` changes: **Deploy → Manage deployments → pencil → Version: New version → Deploy**.
6. Test: open `YOUR_URL?d=%7B%22path%22%3A%22%2Fapi%2Fevents%22%7D` in a browser. It should show `{"data":[]}`.

## 2. Website (GitHub Pages)
1. Open `index.html`, find `const API='...'` near the top of the script and make sure it holds your Web app URL.
2. Upload these files to the root of a public repository.
3. **Settings → Pages → Branch main, folder / (root) → Save.** Your site: `https://USERNAME.github.io/REPO/`.

## 3. Use it
Tap **Admin**, enter `ADMIN_PASSWORD`, create an event (set the "Valid until" date), then register from another tab. Rows appear in your Google Sheet. **Participants → Export to Excel** downloads a formatted .xlsx.

## Notes
- Email OTP is sent from your Google account (about 100 a day on free Gmail, about 1,500 on Workspace). SMS OTP needs `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID`, `COUNTRY_CODE` as script properties. Without them, mobile verification is skipped and recorded as "Not required".
- Registrations are processed one at a time, so capacity and duplicate checks stay correct. A burst of several hundred sign-ups in a few seconds may show "server busy, try again".
- With `const API=''` the page runs in demo mode (data stays in the browser).

## Troubleshooting
- **"Cannot reach the server"**: run step 1.6. If it shows `Alliance Events API is running.` instead of `{"data":[]}`, the old code is still deployed (step 1.5). If it shows a sign-in page, set access to Anyone.
- **404 on the site**: Pages must use branch `main`, folder `/ (root)`, and `index.html` must be in the root of the repository.
