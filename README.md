# Impact LED — Item Catalog & Quote Builder

A searchable parts catalog across all sign generations (G1–G5 and Video Wall), with the
ability to select items and generate a customer-ready printable quote.

**Live site:** https://sacton86.github.io/itemlist/

## For technicians

Open the live link, or open `index.html` locally. Everything runs in the browser — no
install, no server, no internet needed once loaded.

- Search by part number or description; filter by generation, category, or missing photo.
- Click any product photo to view it full-screen and copy or save it.
- Set a quantity, hit **Add**, then **Create Quote**.
- Pick **Dealer** or **End User** pricing, fill in the customer details, and either
  **Preview Quote** → Print / Save as PDF yourself, or **Send to Client for Approval**
  to email them a link where they can review the quote and sign off on it electronically.
  Once they approve, the preparer and accounting get an email with the signed PDF
  attached. See `google-apps-script/README.md` for how that backend is set up.

Discounts work per line and on the whole quote. Each one has a **% / $** button —
click it to switch between a percentage and a flat dollar amount. A dollar discount
comes off that line's **total**, not off each unit. Switching units keeps the number
you typed rather than converting it, so nothing changes price behind your back.

The pricing basis is an internal setting — it never appears on the printed quote.

## Updating prices

Prices are baked into `index.html`. Google blocks cross-origin fetches of the published
sheet, so the page cannot pull them live. After editing the Google Sheet, run:

```bash
python3 build/refresh-prices.py
```

Standard library only — no `pip install`. It downloads the sheet, reparses it, and rewrites
`index.html` and `MISSING-IMAGES.md`. It aborts without touching `index.html` if the
download fails or the sheet layout changes.

Then commit and push to update the live site.

## Adding a product photo

1. Drop the image in `images/`.
2. Add a line to `PART_IMAGE_MAP` in `build/refresh-prices.py`.
3. Re-run the script.

`MISSING-IMAGES.md` tracks which parts still need a photo — 87 of 99 at present.

## Layout

| Path | What it is |
|---|---|
| `index.html` | The app. Generated — edit `build/template.html` instead. |
| `build/template.html` | App source, with an `{{ITEM_DATA}}` placeholder. |
| `build/refresh-prices.py` | Downloads the sheet and regenerates `index.html`. |
| `MISSING-IMAGES.md` | Checklist of parts with no photo. Generated. |
| `images/` | Product photos. |
| `style template.html` | The original SOP document the visual style came from. |
| `google-apps-script/` | Backend for the client e-signature / approval-notification flow. |

## Notes on the data

- The `Cost` column is stripped at build time and never reaches `index.html`.
- Sheet7 (obsolete parts) is excluded entirely.
- A part number can carry several priced variants, and the same variant can cost
  different amounts per generation — the IBR200 service tiers are cheaper on G3/G4 than
  on G1/G2. Items are keyed on part + description + price so the right price shows for
  the right generation.
- Rows with no usable price are shown but badged **Price TBD** and cannot be quoted.
- `build/.pricelist-cache.xlsx` is gitignored: it is the raw workbook and still contains
  the Cost column.
