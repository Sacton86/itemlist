# "Refresh Website" button (price list sheet)

Lets anyone with edit access to the price list Google Sheet kick off the site
rebuild — no terminal, no GitHub login — by triggering the repo's
[`refresh-prices` GitHub Action](../../.github/workflows/refresh-prices.yml).

This is a separate, much smaller Apps Script project from the one in the
parent `google-apps-script/` folder (which backs the quote e-signature flow
on a different sheet). This one is bound directly to the price list sheet
and only calls the GitHub API — nothing else.

## One-time setup

1. **Open the price list Google Sheet**, then **Extensions → Apps Script**.
2. Delete the default `Code.gs` boilerplate and paste in the contents of
   [`Code.gs`](Code.gs) from this folder.
3. Open **Project Settings** (gear icon, left sidebar) → check
   **"Show appsscript.json manifest file"** → paste the contents of
   [`appsscript.json`](appsscript.json) into it, replacing what's there.
4. **Generate a GitHub token** so the script is allowed to trigger the
   Action:
   - Go to <https://github.com/settings/personal-access-tokens/new>
     (fine-grained token).
   - Resource owner: **Sacton86**.
   - Repository access: **Only select repositories** → `itemlist`.
   - Permissions → Repository permissions → **Actions: Read and write**.
   - Generate, then copy the token (starts with `github_pat_...`) — GitHub
     only shows it once.
5. Back in the Apps Script editor, **Project Settings → Script Properties →
   Add script property**: name it `GITHUB_TOKEN`, paste the token as the
   value, and save. (Script Properties are per-project storage, not visible
   in the sheet or to anyone else — this is the right place for the token,
   not in the code itself.)
6. Reload the Google Sheet. A **Price List** menu now appears in the menu
   bar with a **Refresh Website** item.
7. Click it once — Google will show an authorization prompt ("This app
   isn't verified...") since the script calls an external API. Click
   **Advanced → Go to (project name) → Allow**. This is a one-time prompt
   per Google account.

## Optional: an actual clickable button

The menu item above works on its own, but for a more obvious button on the
sheet itself:

1. **Insert → Drawing**, draw a simple rectangle/label (e.g. "Refresh
   Website"), click **Save and Close**.
2. Click the new image once to select it, click the **⋮** (three dots) in
   its top-right corner → **Assign script**.
3. Type `refreshWebsite` (the function name in `Code.gs`) → **OK**.

Now that shape acts as a real button — clicking it runs the same refresh.

## Notes

- Triggering the button only starts the GitHub Action; the live site
  updates roughly 30–60 seconds later. Progress can be checked at
  <https://github.com/Sacton86/itemlist/actions>.
- If the token is later revoked or expires, the button shows an alert
  telling you to generate a new one (step 4) and update the Script
  Property (step 5) — no code changes needed.
- Anyone with **edit** access to the sheet can click the button, but none
  of them ever see the GitHub token — it lives only in this script
  project's properties.
