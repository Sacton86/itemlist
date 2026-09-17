#!/usr/bin/env python3
"""
Impact LED price-list refresh.

Downloads the published Google Sheet, parses it, and rewrites ../index.html
with the current pricing baked in. Also rewrites ../MISSING-IMAGES.md.

Usage:  python3 refresh-prices.py            (download the live sheet)
        python3 refresh-prices.py FILE.xlsx  (use a local file instead)

Stdlib only -- no pip install required.
"""

import json
import os
import re
import sys
import zipfile
from collections import OrderedDict
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TEMPLATE = os.path.join(HERE, "template.html")
OUT_HTML = os.path.join(ROOT, "index.html")
OUT_MISSING = os.path.join(ROOT, "MISSING-IMAGES.md")
IMAGE_DIR = os.path.join(ROOT, "images")

SHEET_URL = (
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vT3vKmVSiZoPefFNLOGWaGCQ"
    "_h8lWKxNfxzZt-klJw0X_HRBpiV5PEbAW_A07YWEW7ryn9LP6Risl-T/pub?output=xlsx"
)

# Sheets to import, in display order. Anything not listed here is ignored --
# notably Sheet7, which is the obsolete-parts archive.
SHEETS = ["G1", "G2", "G3", "G4", "G5", "Video Wall"]

# Part Number and Part Description are always the first two columns in every
# sheet. Type/Cost/Wholesale/MSRP are resolved per sheet from the header row
# (see sheet_price_columns) rather than hardcoded -- not every tab has been
# updated with the newer Type column (e.g. Video Wall, as of 2026-09).
COL_PART, COL_DESC = 0, 1

ITEM_TYPES = {"ITEM", "SERVICE", "HYBRID"}


def item_type(value):
    """Normalize the Type column. Falls back to ITEM (processed like normal) on a
    blank or unrecognized value, with a warning so a sheet typo doesn't silently
    change how a line is billed."""
    text = cell_text(value).strip().upper()
    if text in ITEM_TYPES:
        return text
    if text:
        print(f"  WARNING: unrecognized item type '{text}', defaulting to ITEM")
    return "ITEM"


def sheet_price_columns(header_row):
    """Map 'type'/'cost'/'wholesale'/'msrp' to column index from a sheet's own
    header row. 'type' may be absent on a tab that hasn't been updated yet --
    that's fine, item_type(None) defaults such rows to ITEM."""
    index = {}
    for i, cell in enumerate(header_row):
        name = cell_text(cell).strip().lower()
        if name in ("type", "cost", "wholesale", "msrp"):
            index[name] = i
    missing = [name for name in ("cost", "wholesale", "msrp") if name not in index]
    if missing:
        raise SystemExit(f"ERROR: sheet header is missing column(s) {missing}: {header_row}")
    return index

# Sanity floor. The sheet has ~168 priced rows; a parse well below that means
# the layout changed and we should not clobber a working index.html.
MIN_EXPECTED_ROWS = 120

# ---------------------------------------------------------------------------
# Part number -> image filename in images/.
#
# Filenames do not follow a scheme (REC - I5A75E.png is part REC-5A75E), so
# this mapping is explicit. ADD NEW PHOTOS HERE, then re-run this script.
#
# ---------------------------------------------------------------------------
PART_IMAGE_MAP = {
    "1123 (C3Pro) Controller": "CONTROLLER - 1123.png",
    "4G Cradlepoint IBR200": "4G - IBR200.png",
    "4G-S400": "4G - S400.png",
    "4G-DIGIWR11XT": "4G - DIGI.png",
    "HUB-40A": "HUB - 40A.png",
    "HUB-P16-320": "HUB - P16320.png",
    "LRS-350-5": "POWER - LRS-350-5.png",
    "REC-907": "REC - i5-907.png",
    "REC-5A75E": "REC - I5A75E.png",
    "REC-i5A": "REC - I5A.png",
    "REC-i5+": "REC - i5+.png",
    "WIFI-Ubiquity Radio": "WIFI - NANOSTATIONM2.png",
    "L-D-1-16-R-20x20": "MODULE - G1 16mm RGB.png",
}

# Image files in images/ that are deliberately NOT mapped: they show obsolete
# parts that are not quoted, so they should stop appearing as open questions in
# MISSING-IMAGES.md. Delete an entry here if a part ever comes back.
IGNORED_IMAGES = {
    "REC - MRV210.png":        "obsolete receiver, not quoted",
    "REC - XC160.png":         "obsolete receiver, not quoted",
    "RECEIVE - MRV300.png":    "obsolete, Sheet7 only",
    "RECEIVE - MRV336.png":    "obsolete, Sheet7 only",
    "SEND - MSD300.png":       "obsolete, Sheet7 only",
    "CONTROLLER - PSD100.png": "obsolete, Sheet7 only",
    "CONTROLLER - IFC6309.png": "obsolete, Sheet7 only",
    "MODULE - G1 16mm RGB (rear).png": "rear view of L-D-1-16-R-20x20; catalog only shows one photo per part",
}

# ---------------------------------------------------------------------------
# Category assignment. First matching rule wins, so order matters -- the
# specific entries sit above the broad prefix matches.
# ---------------------------------------------------------------------------
CATEGORY_RULES = [
    (r"^ETHERNET-SURGE-PROTECTOR", "Cabling"),
    (r"^SURGE-PROTECTOR-G3", "Power"),
    (r"^POWER-BREAKER-G3", "Power"),
    (r"^POWER-DSP-", "Power"),
    (r"^CB-G[45]-(CONTROLLER|CTRL)", "Controllers"),
    (r"^CB-G[45]-(COMMUNICATION|COM)", "Controllers"),
    (r"^CBR-G5", "Controllers"),
    (r"^CONTROLLER", "Controllers"),
    (r"Controller$", "Controllers"),
    (r"^(M-G\d|M-G4-VCAB|L-D-)", "Modules"),
    (r"^REC", "Receivers"),
    (r"^HUB", "Hubs"),
    (r"^(PB-|PWR-|POWER|LRS-|CLOUDPS|Power Supply)", "Power"),
    (r"^(Ethernet -|CABLE|USBA-USBB|USB-MENCOM|POE-BOX)", "Cabling"),
    (r"^(4G|WIFI)", "Cellular & WiFi"),
    (r"^(LIGHTSENSOR|TEMPSENSOR)", "Sensors"),
    (r"^(MOD-TOOL|MAGNET-TOOL|TERM-BLOCK|BAG-PARTS|Guide -)", "Tools & Misc"),
]

CATEGORY_ORDER = [
    "Modules", "Receivers", "Controllers", "Hubs", "Power",
    "Cabling", "Cellular & WiFi", "Sensors", "Tools & Misc",
]


def categorize(part):
    for pattern, name in CATEGORY_RULES:
        if re.search(pattern, part, re.IGNORECASE):
            return name
    return "Tools & Misc"


# ---------------------------------------------------------------------------
# Minimal xlsx reader (stdlib only)
# ---------------------------------------------------------------------------
NS_MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
NS_REL_DOC = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
NS_REL_PKG = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def _col_index(cell_ref):
    """'BC12' -> 54 (zero-based column index)."""
    letters = "".join(c for c in cell_ref if c.isalpha())
    idx = 0
    for ch in letters:
        idx = idx * 26 + (ord(ch.upper()) - 64)
    return idx - 1


def read_workbook(path):
    """Return {sheet_name: [[cell, ...], ...]} with cells as str/float/None."""
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.findall(f"{NS_MAIN}si"):
                shared.append("".join(t.text or "" for t in si.iter(f"{NS_MAIN}t")))

        rels = {}
        rel_root = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        for rel in rel_root.findall(f"{NS_REL_PKG}Relationship"):
            rels[rel.get("Id")] = rel.get("Target").lstrip("/")

        sheets = {}
        wb_root = ET.fromstring(z.read("xl/workbook.xml"))
        for sh in wb_root.find(f"{NS_MAIN}sheets"):
            name = sh.get("name")
            target = rels[sh.get(f"{NS_REL_DOC}id")]
            if not target.startswith("xl/"):
                target = "xl/" + target
            sheets[name] = _read_sheet(z.read(target), shared)
        return sheets


def _read_sheet(xml_bytes, shared):
    rows = []
    root = ET.fromstring(xml_bytes)
    data = root.find(f"{NS_MAIN}sheetData")
    if data is None:
        return rows
    for row_el in data.findall(f"{NS_MAIN}row"):
        cells = []
        for c in row_el.findall(f"{NS_MAIN}c"):
            idx = _col_index(c.get("r", "A1"))
            while len(cells) <= idx:
                cells.append(None)
            cells[idx] = _cell_value(c, shared)
        rows.append(cells)
    return rows


def _cell_value(c, shared):
    ctype = c.get("t")
    if ctype == "inlineStr":
        is_el = c.find(f"{NS_MAIN}is")
        return "".join(t.text or "" for t in is_el.iter(f"{NS_MAIN}t")) if is_el is not None else None
    v = c.find(f"{NS_MAIN}v")
    if v is None or v.text is None:
        return None
    raw = v.text
    if ctype == "s":
        i = int(raw)
        return shared[i] if i < len(shared) else None
    if ctype in ("str", "e"):
        return raw
    if ctype == "b":
        return raw == "1"
    try:
        return float(raw)
    except ValueError:
        return raw


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------
def cell_text(value):
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def price(value):
    """Numeric price, or None for blank / '?' / 'OBSOLETE' / zero.

    Rounds half-up, not banker's. The sheet stores the same price at different
    precision depending on the tab (G1 has 32.18, G2 has 32.175); half-up makes
    those agree so they don't look like two different prices.
    """
    if value is None or isinstance(value, bool):
        return None
    try:
        raw = value if isinstance(value, (int, float)) else str(value).strip().replace("$", "").replace(",", "")
        cents = Decimal(str(float(raw))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (ValueError, ArithmeticError):
        return None
    return float(cents) or None


def slugify(text):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", text.lower())).strip("-")


def build_items(sheets):
    """Collapse rows into SKUs.

    A part number can repeat across generations and can have several priced
    variants under one part number, so the SKU identity is
    (part, description, dealer, enduser) and generation is a multi-valued tag.

    Including price in the key matters: the IBR200 service tiers genuinely cost
    less on G3/G4 than on G1/G2. Merging on (part, description) alone would put
    the G1 price on a G3 quote.
    """
    grouped = OrderedDict()   # (part, desc) -> [ {gen, dealer, enduser, cost, type}, ... ]
    row_count = 0

    for sheet_name in SHEETS:
        if sheet_name not in sheets:
            raise SystemExit(f"ERROR: expected sheet '{sheet_name}' is missing from the workbook.")
        sheet_rows = sheets[sheet_name]
        if not sheet_rows:
            raise SystemExit(f"ERROR: sheet '{sheet_name}' has no rows.")
        cols = sheet_price_columns(sheet_rows[0])

        for row in sheet_rows:
            part = cell_text(row[COL_PART] if len(row) > COL_PART else None)
            if not part or part.lower() == "part number":
                continue
            row_count += 1

            desc = cell_text(row[COL_DESC] if len(row) > COL_DESC else None) or part
            type_cell = row[cols["type"]] if "type" in cols and len(row) > cols["type"] else None
            grouped.setdefault((part, desc), []).append({
                "gen": sheet_name,
                "dealer": price(row[cols["wholesale"]] if len(row) > cols["wholesale"] else None),
                "enduser": price(row[cols["msrp"]] if len(row) > cols["msrp"] else None),
                "cost": price(row[cols["cost"]] if len(row) > cols["cost"] else None),
                "type": item_type(type_cell),
            })

    items = []
    for (part, desc), rows in grouped.items():
        priced = [r for r in rows if r["dealer"] is not None or r["enduser"] is not None]

        # Split into one SKU per distinct price pair, preserving first-seen order.
        # cost/type ride along with the variant's first-seen row -- they don't
        # vary by generation the way dealer/enduser price can.
        variants = OrderedDict()
        for r in (priced or rows):
            key = (r["dealer"], r["enduser"])
            variants.setdefault(key, {"gens": [], "cost": r["cost"], "type": r["type"]})
            if r["gen"] not in variants[key]["gens"]:
                variants[key]["gens"].append(r["gen"])

        # A row with no price at all is a placeholder for the priced row of the
        # same part (e.g. HUB-A3-G4-VCAB is listed three times in Video Wall,
        # priced once). Fold its generation in -- but only when that is
        # unambiguous, i.e. there is exactly one priced variant.
        if priced and len(variants) == 1:
            gens = next(iter(variants.values()))["gens"]
            for r in rows:
                if r["gen"] not in gens:
                    gens.append(r["gen"])

        for (dealer, enduser), variant in variants.items():
            gens = variant["gens"]
            image = PART_IMAGE_MAP.get(part)
            items.append({
                "id": slugify(f"{part}-{desc}") or slugify(part),
                "part": part,
                "desc": desc,
                "type": variant["type"],
                "cost": variant["cost"],
                "gens": [g for g in SHEETS if g in gens],
                "cat": categorize(part),
                "dealer": dealer,
                "enduser": enduser,
                "image": f"images/{image}" if image else None,
            })

    _ensure_unique_ids(items)
    return items, row_count


def _ensure_unique_ids(items):
    seen = {}
    for item in items:
        base = item["id"]
        if base in seen:
            seen[base] += 1
            item["id"] = f"{base}-{seen[base]}"
        else:
            seen[base] = 1


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
def check_images(items):
    """Warn if a mapped image file is not actually on disk."""
    missing_files = []
    for part, filename in sorted(PART_IMAGE_MAP.items()):
        if not os.path.isfile(os.path.join(IMAGE_DIR, filename)):
            missing_files.append((part, filename))
    return missing_files


def write_missing_images(items):
    by_gen = {}
    for item in items:
        if item["image"]:
            continue
        by_gen.setdefault(item["gens"][0], []).append(item)

    total_parts = len({i["part"] for i in items})
    with_image = len({i["part"] for i in items if i["image"]})
    missing_parts = sorted({i["part"] for i in items if not i["image"]})

    lines = [
        "# Items Missing an Image",
        "",
        f"_Generated by `build/refresh-prices.py` on {date.today().isoformat()}._",
        "",
        f"**{len(missing_parts)} of {total_parts} part numbers have no photo.** "
        f"{with_image} are covered.",
        "",
        "To add one: drop the file in `images/`, add a line to `PART_IMAGE_MAP` in",
        "`build/refresh-prices.py`, then re-run the script.",
        "",
    ]

    for sheet_name in SHEETS:
        rows = by_gen.get(sheet_name, [])
        if not rows:
            continue
        lines.append(f"## {sheet_name} ({len(rows)})")
        lines.append("")
        lines.append("| | Part Number | Description | Used in |")
        lines.append("|---|---|---|---|")
        for item in sorted(rows, key=lambda r: r["part"].lower()):
            gens = " / ".join(g.replace("Video Wall", "VW") for g in item["gens"])
            desc = item["desc"] if item["desc"] != item["part"] else "—"
            lines.append(f"| [ ] | `{item['part']}` | {desc} | {gens} |")
        lines.append("")

    mapped = set(PART_IMAGE_MAP.values())
    on_disk = sorted(os.listdir(IMAGE_DIR)) if os.path.isdir(IMAGE_DIR) else []
    unclaimed = [f for f in on_disk if f not in mapped and f not in IGNORED_IMAGES]

    lines += [
        "## Photos on hand that still need a part number",
        "",
        "These sit in `images/` but match no part in the price list. Once you know",
        "the part number, add it to `PART_IMAGE_MAP` and re-run the script:",
        "",
    ]
    lines += [f"- `{f}`" for f in unclaimed] or ["- _none_"]
    lines += [
        "",
        "## Photos intentionally not mapped",
        "",
        "Obsolete parts that are not quoted. Listed here so they are not",
        "re-investigated; remove from `IGNORED_IMAGES` if a part comes back.",
        "",
    ]
    lines += [f"- `{f}` — {why}" for f, why in sorted(IGNORED_IMAGES.items())]
    lines.append("")

    with open(OUT_MISSING, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


def render_html(items):
    with open(TEMPLATE, encoding="utf-8") as fh:
        template = fh.read()

    if "{{ITEM_DATA}}" not in template:
        raise SystemExit("ERROR: build/template.html has no {{ITEM_DATA}} placeholder.")

    payload = {
        "generated": date.today().isoformat(),
        "generations": SHEETS,
        "categories": [c for c in CATEGORY_ORDER if any(i["cat"] == c for i in items)],
        "items": items,
    }
    # </script> inside the JSON would close the tag early.
    blob = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")

    html = template.replace("{{ITEM_DATA}}", blob)
    html = html.replace("{{GENERATED_DATE}}", date.today().strftime("%B %-d, %Y"))

    with open(OUT_HTML, "w", encoding="utf-8") as fh:
        fh.write(html)


def download(url):
    dest = os.path.join(HERE, ".pricelist-cache.xlsx")
    print(f"Downloading price list...")
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 (impact-pricelist-refresh)"})
    with urlopen(req, timeout=60) as resp:
        data = resp.read()
    if not data.startswith(b"PK"):
        raise SystemExit(
            "ERROR: the download did not return a spreadsheet.\n"
            "Check that the sheet is still published to the web, then try again.\n"
            "index.html was left untouched."
        )
    with open(dest, "wb") as fh:
        fh.write(data)
    print(f"  {len(data):,} bytes")
    return dest


def main():
    if len(sys.argv) > 1:
        source = sys.argv[1]
        if not os.path.isfile(source):
            raise SystemExit(f"ERROR: no such file: {source}")
        print(f"Reading local file: {source}")
    else:
        try:
            source = download(SHEET_URL)
        except SystemExit:
            raise
        except Exception as exc:
            raise SystemExit(
                f"ERROR: could not download the price list ({exc}).\n"
                "Check your internet connection and try again.\n"
                "index.html was left untouched."
            )

    sheets = read_workbook(source)
    items, row_count = build_items(sheets)

    if row_count < MIN_EXPECTED_ROWS:
        raise SystemExit(
            f"ERROR: only {row_count} price rows parsed (expected at least {MIN_EXPECTED_ROWS}).\n"
            "The sheet layout may have changed. index.html was left untouched."
        )

    broken = check_images(items)
    for part, filename in broken:
        print(f"  WARNING: images/{filename} (mapped to {part}) is not on disk")

    write_missing_images(items)
    render_html(items)

    parts = {i["part"] for i in items}
    with_image = {i["part"] for i in items if i["image"]}
    unpriced = [i for i in items if i["dealer"] is None and i["enduser"] is None]

    print()
    print(f"  {row_count} price rows  ->  {len(items)} SKUs  ({len(parts)} unique part numbers)")
    for sheet_name in SHEETS:
        n = sum(1 for i in items if sheet_name in i["gens"])
        print(f"      {sheet_name:<12} {n:>3} SKUs")
    print(f"  images:   {len(with_image)} parts covered, {len(parts) - len(with_image)} missing")
    print(f"  unpriced: {len(unpriced)} SKUs flagged Price TBD")
    print()
    print(f"  wrote {os.path.relpath(OUT_HTML, ROOT)}")
    print(f"  wrote {os.path.relpath(OUT_MISSING, ROOT)}")


if __name__ == "__main__":
    main()
