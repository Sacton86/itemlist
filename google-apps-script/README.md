# Quote approval backend (Google Apps Script)

Backs the "Send to Client for Approval" button on the quote page. Since the price-list
site is static (GitHub Pages), this Apps Script project is the only server-side piece:
it emails the client a signing link, serves the signing page, and — once the client
draws a signature and approves — converts the quote to a signed PDF and emails it to
the preparer and accounting.

See the root [README.md](../README.md) for how this fits into the site as a whole.

## Files

| File | What it does |
|---|---|
| `Code.gs` | `doPost`/`doGet` handlers, PDF generation, email sending. |
| `Signing.html` | The page a client sees when they open their signing link — renders the quote, captures a drawn signature. |
| `appsscript.json` | Web app manifest (enables the Advanced Drive Service, sets execute-as/access). |

## One-time setup

1. **Install `clasp`** (Google's Apps Script CLI), if you don't have it:
   ```bash
   npm install -g @google/clasp
   ```
2. **Log in** with the Google Workspace account this should run under:
   ```bash
   clasp login
   ```
3. **Create the Apps Script project**, from inside this `google-apps-script/` folder:
   ```bash
   cd google-apps-script
   clasp create --type webapp --title "Impact LED Quote Approvals" --rootDir .
   ```
   This writes a local `.clasp.json` with the new `scriptId` — it's gitignored since it's
   an environment pointer, not code.
4. **Create the Google Sheet** that logs quotes ("Quotes Log" or similar name), and copy
   its ID from the URL (`https://docs.google.com/spreadsheets/d/<THIS PART>/edit`).
5. **Create the Drive folder** that stores signed PDFs ("Signed Quotes" or similar), and
   copy its ID the same way from its URL.
6. **Edit `Code.gs`** and fill in the three constants at the top:
   ```js
   var SHEET_ID = '...';           // from step 4
   var SIGNED_FOLDER_ID = '...';   // from step 5
   var ACCOUNTING_EMAIL = '...';   // who gets CC'd on every signed-quote notification
   ```
7. **Push the code** to Apps Script:
   ```bash
   clasp push
   ```
8. In the Apps Script editor (`clasp open`), go to **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Deploy, then copy the `.../exec` URL it gives you.
9. Enable the **Advanced Drive Service**: in the Apps Script editor, Services (+) →
   Drive API → Add. (Already declared in `appsscript.json`, but Google also wants it
   turned on for the linked Cloud project the first time.)
10. Paste the `.../exec` URL into `APPS_SCRIPT_URL` near the top of the script in
    `../build/template.html`, then mirror the same value into `../index.html` (or just
    re-run `python3 ../build/refresh-prices.py`, which regenerates `index.html` from
    `template.html`).

## Redeploying after code changes

Editing `Code.gs` or `Signing.html` and running `clasp push` updates the project, but an
existing Web App deployment keeps serving the **old** code until you publish a new
version: **Deploy → Manage deployments → edit (pencil) → New version → Deploy**. The
`/exec` URL stays the same, so no site changes are needed.

## How it works

1. The quote page POSTs two things to this Web App: the rendered quote HTML (same as
   `buildQuoteDoc()` produces for Preview) for on-screen display, and the underlying
   structured data (line items, totals, terms) for PDF generation.
2. `Code.gs` stores both in the "Quotes" sheet under a random token and emails the client
   a link: `<web app url>?token=<uuid>`.
3. `doGet` serves `Signing.html` for that token — an iframe of the exact quote HTML plus
   a signature pad. What the client sees is untouched by anything below.
4. On approval, `Code.gs` builds a *separate*, simplified HTML document from the
   structured data (`buildPdfHtml_`) — same Impact LED branding, but plain tables and
   inline colors instead of the on-screen page's gradients/flexbox/web fonts, since
   Google's HTML-to-PDF conversion (a temporary Google Doc import → export) doesn't
   preserve those well. The signature gets embedded into that document, which is then
   converted to PDF, saved to the Drive folder, and emailed to the preparer (cc:
   accounting) with the quote details laid out in the email body.

## Security note

The Web App has to allow "Anyone" access since clients won't have Google logins — the
random per-quote token in the link is the only access control. This is a simple,
non-legally-binding approval flow (a drawn signature + timestamp for internal record
keeping), not an ESIGN-compliant e-signature. Don't reuse this pattern for anything more
sensitive without adding real authentication.
