# Job Application Management System

Candidates apply through a job-specific link (for example from LinkedIn's "apply on external website" option). Their details go into a Google Sheet, their resumes into Google Drive, and administrators review everything from a password-protected dashboard.

There is no separate database. Google Sheets is the data store and Google Drive is the file store.

## Contents

- [How it works](#how-it-works)
- [Run it locally](#run-it-locally)
- [Connect Google](#connect-google)
- [Environment variables](#environment-variables)
- [Deploy to a server](#deploy-to-a-server)
- [Using the app](#using-the-app)
- [Data layout in Google](#data-layout-in-google)
- [Security](#security)
- [Testing](#testing)
- [Limits and known trade-offs](#limits-and-known-trade-offs)

## How it works

The site is a React app and the backend is one Node.js process. They can be hosted together, or separately: the site as static files in a sub-folder of an existing domain and the backend on its own port.

| Part | Technology | Location |
| --- | --- | --- |
| Screens (candidate form, admin dashboard) | React + Vite + Tailwind CSS | `src/` |
| API, auth, Google access | Node.js + Express | `server/` |
| Validation rules and types used by both | TypeScript | `shared/` |
| Google setup and connection check | Node scripts | `scripts/` |

Google credentials exist only on the server. The browser never receives a Google token, a Drive link, or anything else that would let it reach Google directly; resumes are always fetched through the server, which checks the admin session first.

**Submitting an application** runs in this order:

1. Validate every field and the resume (type, size and file signature) on the server.
2. Upload the resume to the job's Drive folder.
3. Write the answers, the application and an activity entry to the sheet in a single all-or-nothing request.

The application row is the commit point. If step 3 fails, the uploaded resume is moved to the Drive trash, so there is never a record without a file or a half-written record. If Google's reply is lost but the row was in fact written, the app detects that and treats the application as saved instead of writing it twice.

**Rows and columns are never addressed by position.** Every update looks up the row by its ID and the column by its header text in a fresh read taken immediately before writing. Administrators can sort the sheet, reorder columns and add columns of their own.

## Run it locally

Requires Node.js 20.12 or newer.

```bash
npm install
```

```bash
cp .env.example .env.local
```

Edit `.env.local`:

- set `ADMIN_PASSWORD` (at least 12 characters) and `SESSION_SECRET` (generate one with `openssl rand -hex 32`);
- set `APP_BASE_URL=http://localhost:3000` and `PORT=3000`, and leave `VITE_BASE_PATH` and `VITE_BASE_API_URL` empty;
- leave `STORAGE_BACKEND=local` for now.

```bash
npm run dev
```

Open http://localhost:3000/admin and sign in.

With `STORAGE_BACKEND=local` the app keeps data in files under `.data/` instead of Google. This is a stand-in for trying the app and for automated tests, not a place for real candidate data; the admin screens show a banner while it is on. To fill it with sample jobs and candidates:

```bash
npm run seed:demo
```

## Connect Google

The server signs in to Google in one of two ways. Both keep the credentials on the server only.

| | Service account | OAuth |
| --- | --- | --- |
| Acts as | a robot account (`...@...iam.gserviceaccount.com`) | a real Google user |
| Reaches | only what is shared with it | that user's Drive |
| Folder in a **Shared Drive** | works | works |
| Folder in someone's **My Drive** | spreadsheet works, **saving resumes fails** | works |
| Upkeep | none | none for Workspace "Internal" apps; see the note on expiry below |

The My Drive limit is Google's: a service account has no Drive storage of its own, and a file saved into a My Drive folder would have to count against it. If your folder is in My Drive, use OAuth, or move the folder into a Shared Drive.

`npm run google:check` tells you definitively which case you are in.

### Before either

1. In the Google Cloud project, open **APIs & Services → Library** and enable **Google Drive API** and **Google Sheets API**.
2. Put the folder and spreadsheet IDs in your env file. They are the long codes in the web addresses:

```
GOOGLE_DRIVE_ROOT_FOLDER_ID=<from https://drive.google.com/drive/folders/THIS_PART>
GOOGLE_SHEET_ID=<from https://docs.google.com/spreadsheets/d/THIS_PART/edit>
```

The spreadsheet can be empty. The app adds its four worksheets and their headers.

### Option A: service account

1. Share the Recruitment System folder with the service account's email as **Editor** (the spreadsheet inside inherits this).
2. In Google Cloud Console open **IAM & Admin → Service Accounts →** your account **→ Keys → Add key → Create new key → JSON**. A file downloads. Treat it like a password.
3. Save it as `secrets/google-service-account.json` in the project (that folder is ignored by git), and restrict it:

```bash
chmod 600 secrets/google-service-account.json
```

4. In the env file:

```
STORAGE_BACKEND=google
GOOGLE_AUTH_MODE=service_account
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=secrets/google-service-account.json
```

5. Verify:

```bash
npm run google:check
```

On a server, prefer an absolute path outside the project folder, readable only by the user the app runs as. Where files are awkward, set `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` instead of the file.

### Option B: OAuth

1. **Consent screen** (**APIs & Services → OAuth consent screen**, shown as **Google Auth Platform** in newer consoles): choose **Internal** if the account belongs to a Google Workspace organisation. Otherwise choose **External** and publish the app to production.
2. **Client:** use an OAuth client of type **Desktop app**. A **Web application** client also works if you add `http://127.0.0.1:53682/oauth2callback` to its Authorized redirect URIs.
3. Give setup the client. Either point it at the JSON file downloaded from the Credentials page ("Download JSON"), which copies the ID and secret into your env file without displaying them:

```bash
npm run google:setup -- --client-file "/path/to/client_secret_....json"
```

or put them in the env file yourself:

```
GOOGLE_AUTH_MODE=oauth
GOOGLE_CLIENT_ID=<client ID>
GOOGLE_CLIENT_SECRET=<client secret>
```

4. Run this on a computer with a web browser, and sign in as the Google user who owns the folder:

```bash
npm run google:setup
```

Setup first asks Google whether the client and return address are acceptable, and stops with the exact fix if not (for example a missing redirect URI), rather than sending you to a Google error page.

It saves `GOOGLE_REFRESH_TOKEN` into the env file, prepares the worksheets and sets `STORAGE_BACKEND=google`.

5. Verify:

```bash
npm run google:check
```

Which permission is requested depends on your settings:

- **A folder or spreadsheet ID is already set:** full Drive access (`drive`) for the signed-in user, because items that already exist were not created by this app.
- **No IDs set:** only files this app creates (`drive.file`). Setup then creates the folder and spreadsheet itself and saves their IDs. This is the narrowest option.

> An External app left in "Testing" status issues refresh tokens that expire after 7 days. The app would then stop working with a "credentials rejected" error until you run `npm run google:setup -- --reauth`. Internal apps and published apps do not have this limit.

Setup options: `--client-file <path>` imports the client, `--reauth` signs in again, `--port <n>` changes the local port, `--env <path>` chooses the env file (default `.env.local`, otherwise `.env`).

### What the check does

`npm run google:check` signs in, opens the folder (and reports whether it is in a Shared Drive or My Drive), reads the worksheets, then exercises appending, updating, uploading and downloading using a scratch worksheet and a scratch folder that it removes afterwards. Your real data is only read. Every line should say `PASS`; a `FAIL` line says what to fix.

To move the connection to a server, copy the `GOOGLE_*` values into the server's env file (and the key file, for a service account).

### Keeping the credentials safe

- **Never in the site's files.** Only settings whose names start with `VITE_` are built into the frontend, and none of the Google settings do. The browser never receives a Google token, a key, or a Drive link.
- **Never in git.** `.env`, `.env.*`, `secrets/`, `*service-account*.json`, `client_secret*.json`, `*.pem` and `*.key` are all ignored. Do not rename the key file to something outside those patterns.
- **Never in logs.** Errors are logged without credentials or request data.
- **If a key or secret is ever exposed** (pasted into a chat, emailed, committed): delete that key in Google Cloud Console and create a new one. For OAuth, reset the client secret and run setup again.

### Who can open resumes

- **In the dashboard:** anyone who knows the admin password.
- **Directly in Google Drive:** only the people the folder is shared with. The app never adds sharing permissions and never creates public links.

## Environment variables

`.env.example` lists every setting with comments. The backend reads `.env.local` and then `.env` from the folder it is started in; real environment variables take priority over both.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ADMIN_PASSWORD` | yes | – | Shared admin password, 12+ characters. Sign-in is disabled without it. |
| `SESSION_SECRET` | in production | random per start in development | Signs session cookies and form tokens. 32+ characters. |
| `APP_BASE_URL` | yes on a server | request host | Public address of the site including its sub-folder, e.g. `https://dev.aiassistant.co/job-applicants-review`. Used for application links, and it is the only address allowed to call the backend from a browser. |
| `VITE_BASE_PATH` | build time | empty | Sub-folder the site is served from, e.g. `job-applicants-review`. Must match the folder in `APP_BASE_URL`. |
| `VITE_BASE_API_URL` | build time | empty | How the browser reaches the backend, e.g. `dev.aiassistant.co:8799`. Empty means "same address as the site". |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | no | – | Serve HTTPS directly from the backend port when no web server sits in front of it. |
| `COMPANY_NAME` | no | `Careers` | Shown in headers and page titles. |
| `PORT` | no | `3000` | Port the backend listens on, e.g. `8799`. |
| `TRUST_PROXY` | behind a proxy | `0` | Number of reverse proxies in front of the backend. `1` behind nginx or Apache, `0` when browsers connect to it directly. |
| `STORAGE_BACKEND` | no | `google` | `google` or `local`. |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID`, `GOOGLE_SHEET_ID` | for Google | – | The Recruitment System folder and the Applicants spreadsheet. |
| `GOOGLE_AUTH_MODE` | for Google | inferred | `service_account` or `oauth`. |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | service account | – | Path to the JSON key file. Or set `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth | – | OAuth client from Google Cloud. |
| `GOOGLE_REFRESH_TOKEN`, `GOOGLE_OAUTH_SCOPE` | OAuth | – | Written by `npm run google:setup`. |
| `MAX_RESUME_SIZE_MB` | no | `5` | Largest resume accepted. |
| `DEFAULT_CURRENCY` | no | `INR` | Currency preselected on the form. |
| `APP_TIMEZONE` | no | `Asia/Kolkata` | Time zone for dates in the dashboard, date filters and exports. |
| `SUBMISSIONS_PER_IP_PER_HOUR` | no | `10` | Stored applications allowed per network address per hour. |
| `LOGIN_ATTEMPTS_PER_15_MIN` | no | `10` | Wrong passwords allowed per address per 15 minutes. |
| `SESSION_HOURS` | no | `12` | How long an admin stays signed in. |

The two `VITE_` settings are read when the site is built (`npm run build`) and are baked into the site's files. Changing them means building and uploading the site again. Everything else is read when the backend starts.

Changing `ADMIN_PASSWORD` or `SESSION_SECRET` signs every administrator out.

## Deploy to a server

### Simplest: one pm2 process behind your web server

The backend serves the site and the API together under the sub-folder, so the web server needs a single forwarding rule and nothing has to be uploaded separately. This is the layout for `https://dev.aiassistant.co/job-applicants-review` with the app on port `8799`.

Needs Node.js 20.19 or newer (22 recommended) and pm2 on the server.

**1. Get the code and settings onto the server.**

```bash
git clone https://github.com/Smart-Assistant-ai/job-review.git && cd job-review
```

Put your settings in a file named `.env` in that folder (see [Environment variables](#environment-variables)), with at least:

```
APP_BASE_URL=https://dev.aiassistant.co/job-applicants-review
PORT=8799
VITE_BASE_PATH=job-applicants-review
VITE_BASE_API_URL=
TRUST_PROXY=1
```

```bash
chmod 600 .env
```

**2. Install, build and start.**

```bash
npm ci && npm run build
```

Run this from inside the project folder, so the app finds its `.env`:

```bash
pm2 start dist/server.js --name job-applicants-review && pm2 save
```

The built server runs in production mode by default. Keep it to a single instance (no `-i`): rate limits, duplicate-submission locks and download progress live in memory.

Check it: `curl http://127.0.0.1:8799/job-applicants-review/api/health` should print `{"ok":true}`, and `pm2 logs job-applicants-review` should show "Storage is ready."

**3. Forward the sub-folder from the web server.** In the nginx `server` block for the domain (the one with `listen 443 ssl`):

```nginx
location /job-applicants-review/ {
    proxy_pass http://127.0.0.1:8799;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 6m;          # slightly above MAX_RESUME_SIZE_MB
    proxy_buffering off;              # let large ZIP downloads stream
    proxy_read_timeout 900s;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Apache equivalent: `ProxyPass /job-applicants-review/ http://127.0.0.1:8799/job-applicants-review/` with a matching `ProxyPassReverse`, plus `RequestHeader set X-Forwarded-Proto "https"`.

Port 8799 does not need to be opened to the internet in this layout.

**Updating later:**

```bash
git pull && npm ci && npm run build && pm2 reload job-applicants-review
```

After changing `.env` only, `pm2 reload job-applicants-review` is enough, unless you changed a `VITE_` setting, which needs the build again.

### Site in a sub-folder, backend on its own port

Use this instead if the site's files must be hosted separately from the backend, with browsers calling the backend port directly.

This is the layout for `https://dev.aiassistant.co/job-applicants-review` with the backend on port `8799` of the same domain.

**1. Settings.** In `.env` on the machine where you build and run:

```
APP_BASE_URL=https://dev.aiassistant.co/job-applicants-review
PORT=8799
VITE_BASE_PATH=job-applicants-review
VITE_BASE_API_URL=dev.aiassistant.co:8799
```

plus `ADMIN_PASSWORD`, `SESSION_SECRET`, `COMPANY_NAME` and the `GOOGLE_*` values.

**2. Build.**

```bash
npm ci && npm run build
```

This produces the site in `dist/client/` and the backend in `dist/server.js`. (`npm run build:client` and `npm run build:server` build them separately.)

**3. Publish the site.** Copy everything inside `dist/client/`, including the hidden `.htaccess` file, into the folder your web server serves at `/job-applicants-review/`.

**4. Start the backend** from the project folder, and keep it running with pm2 or systemd:

```bash
npm start
```

If `dist/client/` is not next to `dist/server.js`, the backend serves only the API. If it is, the same site is also available on the backend port, which does no harm.

**5. Two things the server has to provide.**

- **HTTPS on the backend port.** The site is loaded over HTTPS, and browsers refuse to let an HTTPS page talk to a plain `http://` backend. Use one of:
  - *Your web server terminates HTTPS on 8799* and forwards to the backend on an internal port (set `PORT` to that internal port and `TRUST_PROXY=1`).
  - *The backend serves HTTPS itself:* set `TLS_CERT_FILE` and `TLS_KEY_FILE` to the domain's certificate and key, and open port 8799 in the firewall.
  - *No public port at all:* forward `/job-applicants-review/api/` on the main site to the backend (rules below), leave `VITE_BASE_API_URL` empty and rebuild. The site and backend then share one address, which is the simplest and safest arrangement.
- **Page links must open the app.** A link such as `/job-applicants-review/apply/k7m2x9q4ab` is a page inside the React app, not a file on disk, so the web server must answer it with `index.html`.
  - Apache: the included `.htaccess` does this (requires `mod_rewrite` and `AllowOverride` for the folder, which shared hosting normally has).
  - nginx: add the `try_files` line below.

Check this before posting a link on LinkedIn: open an application link in a private window. If you see the form, both points are working.

nginx, forwarding the API through the main site:

```nginx
location /job-applicants-review/api/ {
    proxy_pass http://127.0.0.1:8799;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 6m;          # slightly above MAX_RESUME_SIZE_MB
    proxy_buffering off;              # let large ZIP downloads stream
    proxy_read_timeout 900s;
}
location /job-applicants-review/ {
    try_files $uri $uri/ /job-applicants-review/index.html;
}
```

Apache equivalent for the API (in the site's virtual host):

```apache
ProxyPass        /job-applicants-review/api/ http://127.0.0.1:8799/job-applicants-review/api/
ProxyPassReverse /job-applicants-review/api/ http://127.0.0.1:8799/job-applicants-review/api/
```

When a web server forwards requests to the backend, set `TRUST_PROXY=1`. `X-Forwarded-For` is deliberately set to `$remote_addr` (overwriting anything the visitor sent) so rate limits cannot be dodged with a forged header.

### Everything from one process

With `VITE_BASE_PATH` and `VITE_BASE_API_URL` empty and `APP_BASE_URL` set to the site's own address, `npm run build && npm start` serves the site and the API together on `PORT` at the root of a domain. Put a reverse proxy with HTTPS in front of it.

### Production checklist

- `STORAGE_BACKEND=google` and `npm run google:check` passes.
- `APP_BASE_URL` is the public `https://` address including the sub-folder. This also makes the session cookie HTTPS-only.
- The folder in `VITE_BASE_PATH` matches the folder in `APP_BASE_URL` (the backend prints a warning at startup if they differ).
- `ADMIN_PASSWORD` is long and unique; `SESSION_SECRET` is random.
- `TRUST_PROXY` matches the number of proxies in front of the backend.
- Run one backend instance only (see [Limits](#limits-and-known-trade-offs)).
- `GET /api/health` on the backend returns `{"ok":true}` for uptime monitoring.

## Using the app

**Administrators** (`<site address>/admin`)

- **Jobs:** create, edit, publish, close and reopen jobs. Each job has a title, description, responsibilities, requirements, experience criteria and its own application questions (short answer, paragraph, dropdown, yes/no; required or optional).
- **Application link:** every published job has a unique link such as `https://dev.aiassistant.co/job-applicants-review/apply/k7m2x9q4ab`. Use **Copy link** and paste it into LinkedIn's external application field. The link stays the same when the job is edited.
- **Candidates:** search by name, email, phone, location, job title, notes or application ID. Filter by job, status, experience, application date and CTC. Sort by any column. 25, 50 or 100 rows per page.
- **Review:** open a candidate to see every answer, preview a PDF resume in the page, change status (New, Under Review, Shortlisted, Rejected, Hired), and keep internal notes. Status can also be changed straight from the table.
- **Bulk actions:** tick candidates (or select all that match the filters) to change status together, download their resumes as a ZIP, or export them as CSV.
- **Downloads:** with a job selected, **All resumes** and **Shortlisted resumes** download a ZIP for that job. **Export CSV** exports whatever the current filters show, including each custom answer as its own column.

ZIP downloads are prepared in two steps: the dashboard first asks the backend for the selection (so problems such as "nothing matches" appear as a normal message), then the browser fetches the file with a one-time link and saves it with its own download bar. Each ZIP contains a `_download-report.txt` listing how many resumes were included and naming any that could not be (for example a file deleted from Drive).

**Candidates** (`<site address>/apply/<job id>`)

A three-step form: basic details, professional details (including the job's own questions), and resume upload with a review of what was entered. Choosing an experience range such as "3–5 years" reveals a second dropdown for the exact completed years (3, 4 or 5). Entries are kept when moving between steps, and each problem is shown next to the field it belongs to.

## Data layout in Google

```
Recruitment System/
├── Applicants                      (Google Sheet)
└── Jobs/
    └── <Job title> [<job id>]/
        └── <Candidate name> - <application id>.pdf
```

Worksheets in **Applicants**:

| Worksheet | One row per | Notes |
| --- | --- | --- |
| Jobs | job | Questions are stored as JSON in one cell. |
| Applications | application | ID, job, candidate details, CTC, experience, LinkedIn, resume file ID and name, timestamp, status, notes. |
| Application Answers | answer to a custom question | Includes the question text as it was when answered. |
| Application Activity | event | Submission, status changes, note edits. Append-only. |

Working in the sheet directly is fine:

- Sorting, filtering, reordering columns and adding your own columns are all safe.
- Editing Status or Internal Notes by hand works; the dashboard picks changes up within about 15 seconds.
- Do not rename the app's header cells. If one is renamed or deleted, the app adds a fresh column with the original header and treats the old one as yours.
- Do not edit the ID columns. Deleting an application row removes it from the dashboard; its resume stays in Drive.

All candidate text is stored as plain text, so input such as `=IMPORTXML(...)` is never run as a formula. CSV exports apply the same protection by prefixing cells that start with `=`, `+`, `-` or `@` with an apostrophe (this is why exported phone numbers beginning with `+` show a leading `'`).

## Security

- **Admin access:** one shared password, compared in constant time. Sessions are signed, HTTP-only, SameSite cookies that expire after `SESSION_HOURS`. Wrong-password attempts are rate limited.
- **Authorization:** every `/api/admin/*` route except sign-in sits behind a session check applied to the whole router, so a new admin route cannot be added without it. A test walks every admin endpoint and confirms it rejects requests without a session.
- **Cross-site requests:** state-changing requests whose `Origin` is another site are rejected, in addition to SameSite cookies. When the site and backend are on different addresses, only the address in `APP_BASE_URL` may call the backend from a browser.
- **Shared domain:** if other apps live on the same domain (for example other folders of `dev.aiassistant.co`), browsers treat their pages as the same site as this one. A script-injection flaw in any of them could act with a signed-in administrator's session. Giving this app its own subdomain removes that exposure.
- **Uploads:** only PDF, DOC and DOCX, checked by extension, size and file signature (the browser's claimed type is ignored). Files are renamed on the server. Downloads are served with a fixed content type from an allow-list, `nosniff`, and as attachments.
- **Spam:** per-address rate limits, a hidden honeypot field, and a signed form token that rejects submissions sent without loading the form or within three seconds of loading it.
- **Duplicates:** one application per email address per job. The same person can apply to other jobs.
- **Headers:** a Content Security Policy that allows scripts only from the site itself, plus the standard hardening headers from Helmet.
- **Logs:** request bodies and candidate details are never logged. Storage errors are logged without data.
- **Errors:** candidates see a generic message when storage fails; administrators see the specific cause (for example that Google authorization has expired) but never credentials.

Because the password is shared, the activity log records "Admin" rather than a person's name. If you later need per-person accountability, replace the password check in `server/auth.ts` with individual sign-in.

## Testing

```bash
npm test
```

```bash
npm run typecheck
```

The suite starts the real server against the local stand-in storage and drives it over HTTP. It covers:

- creating, editing, publishing, closing and reopening jobs, and the public job link;
- submitting applications, including the exact rows written to each worksheet and where the resume is stored;
- the experience follow-up rules for every range;
- validation of every field, resume type, disguised file content, size limits;
- duplicate and concurrent submissions (six identical submissions at once produce exactly one record);
- failed uploads, failed sheet writes, lost replies, rate-limited Google calls and retries;
- admin authentication, session invalidation, sign-in throttling, cross-site request blocking;
- search, every filter, sorting, pagination, status changes, notes, bulk updates, activity history;
- updating the correct row after the sheet has been sorted and had columns inserted by hand;
- single resume download, ZIP of selected / all / shortlisted resumes, missing files, duplicate file names, a 300-resume ZIP, cancelled downloads;
- CSV export with custom answers and formula neutralisation;
- hosting in a sub-folder with the backend on another address: links, cross-address sign-in and requests, and refusal of other websites.

The Google adapter itself (`server/storage/google.ts`) cannot be covered by offline tests. Verify it against your account with `npm run google:check` after connecting.

Manual check after deploying:

1. Sign in at `/admin`, create a job with one question, publish it, copy the link.
2. Open the link in a private window on a phone and on a desktop. Submit an application with a PDF.
3. Confirm the row in the **Applications** worksheet and the file under `Recruitment System/Jobs/<job>/` in Drive.
4. In the dashboard, open the candidate, preview and download the resume, change the status, add a note, refresh the page.
5. Select the candidate and use **Download resumes** and **Export CSV**.

## Limits and known trade-offs

- **Run a single instance.** Rate limits, write ordering, duplicate-submission locks and download progress live in memory. Running several copies behind a load balancer would weaken those guarantees.
- **Google quotas.** The Sheets API allows roughly 60 reads and 60 writes per minute per user. Each submission costs one write and the dashboard caches reads for 15 seconds, so this comfortably handles a busy job posting but not thousands of submissions per minute. Rate-limited calls are retried with backoff.
- **Scale of the sheet.** The dashboard loads the Applications worksheet into memory to search and filter. This is fast for tens of thousands of rows; beyond that a real database would be the right tool.
- **A very small race remains when updating rows.** Row positions are resolved from a fresh read immediately before writing, but Google Sheets has no "update where ID equals" operation. If someone sorts the sheet in the fraction of a second between that read and the write, the update could land on a different row.
- **Resume preview** is available for PDFs. Word documents are downloaded instead.
- **CTC filters** compare raw amounts. Choose a currency in the filter to compare like with like.
- **Editing questions** on a job that already has applications is safe: earlier answers keep the question text they were given under.
