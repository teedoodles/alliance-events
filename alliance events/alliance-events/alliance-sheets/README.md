# Alliance University Events (Google Sheets edition)

Registration data is stored in **your own Google Sheet**. Only a person signed in to your Google account (or anyone you share the Sheet with) can open it, and the admin dashboard needs the admin password. No database, no paid hosting.

```
alliance-events-sheets/
├── apps-script/Code.gs   backend: paste into Google Apps Script
├── docs/index.html       the website (GitHub Pages)
└── .gitignore
```

## Setup (about 30 minutes)

### 1. Create the Sheet and backend
1. Go to **sheets.google.com**, start a **Blank** spreadsheet, and name it `Alliance Events Database`.
2. Click **Extensions → Apps Script**.
3. Delete the sample code, open `apps-script/Code.gs` from this repo, copy everything and paste it in. Click the save icon.
4. Click the **gear (Project Settings)** on the left. Under **Script properties** click **Add script property**:
   - name `ADMIN_PASSWORD`, value: a strong password (this is your dashboard password)
   - optional: name `STAFF_PASSWORD`, value: a second password that can only check people in and view data
5. Go back to **Editor**. In the function dropdown at the top choose **setup**, then click **Run**.
6. Google asks for permission: **Review permissions → choose your account → Advanced → Go to project (unsafe) → Allow**. This is your own script, so it's safe. The sheet now has `Events` and `Registrations` tabs, and a Drive folder `Alliance Event Photos` is created.

### 2. Publish the backend
1. Click **Deploy → New deployment**. Click the gear next to "Select type" and choose **Web app**.
2. Set **Execute as: Me** and **Who has access: Anyone**. Click **Deploy**.
3. Copy the **Web app URL** (ends in `/exec`).
4. Whenever you change `Code.gs` later: **Deploy → Manage deployments → pencil → Version: New version → Deploy**.

### 3. Connect the website
1. Open `docs/index.html`, find `const API='';` near the top of the script and paste your URL between the quotes.
2. Upload this whole folder's contents to a **public** GitHub repository.
3. **Settings → Pages → Branch: main, folder: /docs → Save.** Your site appears at `https://YOURNAME.github.io/REPO/`.

### 4. Test
Open the site, tap **Admin**, enter your password, create an event, register from another tab (an OTP email arrives from your Google account), check the person in, and open the Google Sheet to see the rows.

## Getting your data
- **Dashboard:** Participants → **Export to Excel** (formatted .xlsx, respects the filters).
- **Google Sheet:** open it directly. **File → Download → Microsoft Excel (.xlsx)** gives everything.
- Share the Sheet with other organisers using the normal **Share** button.

## Event validity date
Each event has a "Valid until" date and time. After it passes, the event disappears for participants and registration is refused by the server. Admins can extend it.

## OTP
- **Email OTP** works immediately and is sent from your Google account (limits: about 100 emails a day on a free Gmail, about 1,500 on Google Workspace).
- **Mobile OTP** needs an SMS provider. Add `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID` and `COUNTRY_CODE` (91) as script properties. Without them the site automatically skips mobile verification and records it as "Not required".

## Good to know
- Registrations are processed one at a time through a lock, so capacity and duplicate checks are safe even when many people submit together. Each takes roughly 1 to 2 seconds. A burst of several hundred people in the same few seconds may see "server busy, try again". For very large launches use the Supabase edition.
- Don't edit the header row of the sheet tabs. You may sort or filter a copy, but edit data through the dashboard.
- Never put the passwords in GitHub. They live only in Script properties.
