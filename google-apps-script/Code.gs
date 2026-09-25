/**
 * Impact LED Signs — quote e-signature & approval-notification backend.
 *
 * Deployed as a Web App (Deploy > New deployment > Web app), executed as
 * "Me", accessible to "Anyone". The static price-list site (GitHub Pages)
 * calls this over fetch() to email a client a signing link; the client's
 * browser calls it again (via Signing.html) once they approve.
 *
 * Setup: fill in the three constants below, then see README.md in this
 * folder for the full deploy walkthrough.
 */

// ---- fill these in before deploying --------------------------------------
var SHEET_ID = '1_S98X5Pkcu2GFlW8T5q3y1BF8RFdLzOv2_hU97IQVgE';
var SIGNED_FOLDER_ID = '1PG4sqUJiSmHE0WjHfyRNK_Kq5DM0VtGz';
var ACCOUNTING_EMAIL = 'accounting@impactledsigns.com';
// ----------------------------------------------------------------------------

var COMPANY_NAME = 'Impact LED Signs';
var SHEET_NAME = 'Quotes';
var HEADERS = [
  'token', 'status', 'createdAt', 'signedAt',
  'company', 'contact', 'email', 'phone',
  'number', 'ticket', 'projectName', 'date', 'validUntil',
  'preparer', 'preparerEmail', 'total',
  'html', 'pdfUrl', 'dataJson'
];

// ---------------------------------------------------------------- entry points

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ ok: false, error: 'Malformed request.' });
  }
  if (body.action === 'create') return handleCreate_(body);
  if (body.action === 'sign') return handleSign_(body);
  if (body.action === 'status') return handleStatus_(body);
  return jsonOut_({ ok: false, error: 'Unknown action.' });
}

function doGet(e) {
  var token = e.parameter && e.parameter.token;
  if (!token) {
    return HtmlService.createHtmlOutput(
      '<p style="font-family:sans-serif;padding:40px;">Missing quote link.</p>'
    );
  }

  var rowIdx = findRowIndex_(token);
  if (!rowIdx) {
    return HtmlService.createHtmlOutput(
      '<p style="font-family:sans-serif;padding:40px;">This quote link is invalid or has expired.</p>'
    );
  }

  var record = rowToRecord_(getSheet_().getRange(rowIdx, 1, 1, HEADERS.length).getValues()[0]);
  if (record.status === 'signed') {
    return HtmlService.createHtmlOutput(
      '<p style="font-family:sans-serif;padding:40px;">This quote was already approved on ' +
      esc_(record.signedAt) + '. Contact ' + esc_(record.preparer) + ' if you need a new copy.</p>'
    );
  }

  var tmpl = HtmlService.createTemplateFromFile('Signing');
  tmpl.token = token;
  tmpl.quoteHtml = record.html;
  tmpl.number = record.number;
  // Signing.html renders inside a *.googleusercontent.com sandbox iframe, so
  // window.location.href there is NOT this web app's URL -- pass the real
  // one down explicitly for the client to POST back to.
  tmpl.webAppUrl = ScriptApp.getService().getUrl();
  return tmpl.evaluate()
    .setTitle('Approve Quote ' + record.number)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

// ---------------------------------------------------------------- actions

function handleCreate_(body) {
  if (!body.email || !body.preparerEmail || !body.html) {
    return jsonOut_({ ok: false, error: 'Missing required quote fields.' });
  }

  var token = Utilities.getUuid();
  var dataJson = JSON.stringify({
    lines: body.lines || [],
    totals: body.totals || {},
    terms: body.terms || '',
    // Addresses ride in dataJson rather than new sheet columns, so rows
    // written before they existed still line up with HEADERS.
    billing: body.billing || {},
    shipping: body.shipping || {},
    shipSameAsBilling: !!body.shipSameAsBilling
  });
  getSheet_().appendRow([
    token, 'sent', new Date().toISOString(), '',
    body.company || '', body.contact || '', body.email || '', body.phone || '',
    body.number || '', body.ticket || '', body.projectName || '', body.date || '', body.validUntil || '',
    body.preparer || '', body.preparerEmail || '', body.total || 0,
    body.html || '', '', dataJson
  ]);

  var signUrl = ScriptApp.getService().getUrl() + '?token=' + encodeURIComponent(token);
  var htmlBody =
    '<p>Hi ' + esc_(body.contact || body.company) + ',</p>' +
    '<p>' + esc_(body.preparer) + ' at ' + COMPANY_NAME + ' has prepared quote <strong>' +
    esc_(body.number) + '</strong> for your review. Open the link below to review the quote ' +
    'and approve it:</p>' +
    '<p><a href="' + signUrl + '">Review &amp; approve quote ' + esc_(body.number) + '</a></p>' +
    '<p>Quote total: <strong>' + moneyFmt_(body.total) + '</strong>' +
    (body.validUntil ? '<br>Valid until: ' + esc_(body.validUntil) : '') + '</p>' +
    '<p style="color:#888;font-size:12px;">If the link above doesn\'t work, copy this URL into ' +
    'your browser:<br>' + signUrl + '</p>';

  MailApp.sendEmail({
    to: body.email,
    subject: 'Quote ' + body.number + ' from ' + COMPANY_NAME + ' — please review & approve',
    htmlBody: htmlBody
  });

  return jsonOut_({ ok: true, token: token });
}

function handleSign_(body) {
  if (!body.token || !body.signaturePng) {
    return jsonOut_({ ok: false, error: 'Missing signature data.' });
  }

  var sheet = getSheet_();
  var rowIdx = findRowIndex_(body.token);
  if (!rowIdx) return jsonOut_({ ok: false, error: 'Quote not found.' });

  var record = rowToRecord_(sheet.getRange(rowIdx, 1, 1, HEADERS.length).getValues()[0]);
  if (record.status === 'signed') {
    return jsonOut_({ ok: false, error: 'This quote was already signed.' });
  }

  var signedAt = new Date();
  var pngBase64 = String(body.signaturePng).split(',').pop();

  // Build a separate, simplified template for the PDF from the structured
  // line-item/totals data (not record.html) -- Google's HTML-to-PDF
  // conversion doesn't preserve the on-screen quote's richer CSS well, so
  // this uses plain tables/inline colors that survive that conversion, in
  // the same Impact LED branding. The on-screen quote and signing page are
  // unaffected -- they still use record.html directly.
  var pdfHtml = buildPdfHtml_(record, {
    name: body.signerName || record.contact,
    dateStr: signedAt.toLocaleString(),
    dataUri: 'data:image/png;base64,' + pngBase64
  });

  var safeNumber = String(record.number || 'quote').replace(/[^A-Za-z0-9\-_. ]/g, '');
  var pdf = htmlToPdf_(pdfHtml, 'Quote ' + safeNumber + ' - Signed');

  sheet.getRange(rowIdx, HEADERS.indexOf('status') + 1).setValue('signed');
  sheet.getRange(rowIdx, HEADERS.indexOf('signedAt') + 1).setValue(signedAt.toISOString());
  sheet.getRange(rowIdx, HEADERS.indexOf('pdfUrl') + 1).setValue(pdf.url);

  // The quote is already recorded as signed at this point (PDF exists) --
  // a failure sending the internal notification shouldn't make this whole
  // request look like the client's approval never went through. Log it
  // instead (Apps Script editor > Executions) so it can be noticed and the
  // notification resent by hand if it ever fails.
  try {
    notifyApproval_(record, pdf.blob, signedAt, body.signerName);
  } catch (notifyErr) {
    Logger.log('notifyApproval_ failed for token ' + body.token + ': ' + notifyErr);
  }

  return jsonOut_({ ok: true });
}

// Lets the signing page double-check what actually happened when its own
// submit request's response failed to load (a known Apps Script redirect
// quirk) without risking a duplicate submission.
function handleStatus_(body) {
  var rowIdx = findRowIndex_(body.token);
  if (!rowIdx) return jsonOut_({ ok: false, error: 'Quote not found.' });
  var record = rowToRecord_(getSheet_().getRange(rowIdx, 1, 1, HEADERS.length).getValues()[0]);
  return jsonOut_({ ok: true, status: record.status });
}

function notifyApproval_(record, pdfBlob, signedAt, signerName) {
  var data = {};
  try { data = JSON.parse(record.dataJson || '{}'); } catch (e) {}
  var shipTo = data.shipSameAsBilling ? 'Same as billing' : addressLines_(data.shipping).join(', ');
  var bodyHtml =
    '<p>Quote <strong>' + esc_(record.number) + '</strong> was approved by ' +
    esc_(signerName || record.contact) + ' on ' + esc_(signedAt.toLocaleString()) + '.</p>' +
    '<table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:13px;">' +
      row_('Company', record.company) +
      row_('Contact', record.contact) +
      row_('Client email', record.email) +
      row_('Phone', record.phone) +
      row_('Ticket #', record.ticket) +
      row_('Project', record.projectName) +
      row_('Bill to', addressLines_(data.billing).join(', ')) +
      row_('Ship to', shipTo) +
      row_('Quote date', record.date) +
      row_('Valid until', record.validUntil) +
      row_('Preparer', record.preparer) +
      '<tr><td style="color:#888;">Total</td><td><strong>' + moneyFmt_(record.total) + '</strong></td></tr>' +
    '</table>' +
    '<p>The signed PDF is attached.</p>';

  MailApp.sendEmail({
    to: record.preparerEmail,
    cc: ACCOUNTING_EMAIL,
    subject: 'Signed: Quote ' + record.number + ' approved by ' + (record.company || record.contact),
    htmlBody: bodyHtml,
    attachments: [pdfBlob]
  });
}

// ["Jane Doe", "123 Main St.", "Suite 4", "Austin, TX 78701"], skipping blank parts.
function addressLines_(a) {
  a = a || {};
  var cityLine = [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [a.name, a.line1, a.line2, cityLine].filter(Boolean);
}

function addressCell_(title, lines) {
  if (!lines.length) return '';
  return '<td style="width:50%;padding:6px 16px;vertical-align:top;">' +
    '<div style="font-size:9px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#cc1111;">' + title + '</div>' +
    lines.map(function (ln, i) {
      return i === 0
        ? '<div style="font-size:12px;font-weight:bold;color:#0a0a0a;">' + esc_(ln) + '</div>'
        : '<div style="font-size:11px;color:#444444;">' + esc_(ln) + '</div>';
    }).join('') +
  '</td>';
}

// Google Docs' HTML import ignores CSS word-wrapping, so a long email (no
// spaces) runs off the edge of the PDF. Zero-width spaces after "@" and "."
// give it invisible places to wrap.
function breakableEmail_(email) {
  return esc_(email).replace(/([@.])/g, '$1&#8203;');
}

function row_(label, value) {
  return '<tr><td style="color:#888;">' + esc_(label) + '</td><td>' + esc_(value) + '</td></tr>';
}

// ---------------------------------------------------------------- PDF template

// A deliberately simple, table-based HTML document for the emailed/signed
// PDF -- built from the structured line-item/totals data captured at
// "create" time (record.dataJson), not from record.html. Google's HTML
// import (used by htmlToPdf_ below) doesn't handle gradients, flexbox, or
// @import web fonts, all of which the on-screen quote uses; this template
// sticks to plain tables and inline colors, which it renders reliably,
// while keeping the same Impact LED red/black branding and layout shape.
function buildPdfHtml_(record, signature) {
  var data = {};
  try { data = JSON.parse(record.dataJson || '{}'); } catch (e) {}
  var lines = data.lines || [];
  var totals = data.totals || {};
  var terms = data.terms || '';
  var billLines = addressLines_(data.billing);
  var shipLines = addressLines_(data.shipping);
  var logoUrl = 'https://sacton86.github.io/itemlist/Impact%20Logo.png';

  var rows = lines.map(function (l) {
    // HYBRID items are split into an ITEM row (priced at cost) and a SERVICE
    // row (the remainder of the sold amount) -- but only here, on the signed
    // PDF. The quote the client reviews/signs shows the item as a single line.
    if (l.type === 'HYBRID') {
      var qty = Number(l.qty) || 0;
      var costPerUnit = Number(l.cost) || 0;
      var itemExt = Math.min(costPerUnit * qty, l.ext);
      var serviceExt = l.ext - itemExt;
      var serviceUnit = qty ? serviceExt / qty : serviceExt;
      return lineRow_(l.part + ' (ITEM)', l.desc, l.gens, l.qty, costPerUnit, l.discLabel, itemExt) +
             lineRow_(l.part + ' (SERVICE)', l.desc, l.gens, l.qty, serviceUnit, l.discLabel, serviceExt);
    }
    return lineRow_(l.part, l.desc, l.gens, l.qty, l.unit, l.discLabel, l.ext);
  }).join('');

  var totalRows = totalsRow_('Subtotal', moneyFmt_(totals.subtotal), '#888888');
  if (totals.lineDiscAmt > 0) {
    totalRows += totalsRow_('Line item discounts', '−' + moneyFmt_(totals.lineDiscAmt), '#cc1111');
  }
  if (totals.discAmt > 0) {
    totalRows += totalsRow_(
      'Quote discount' + (totals.qDiscMode === 'pct' ? ' (' + totals.qDisc + '%)' : ''),
      '−' + moneyFmt_(totals.discAmt), '#cc1111'
    );
  }
  if (totals.ship > 0) totalRows += totalsRow_('Shipping', moneyFmt_(totals.ship), '#888888');
  totalRows +=
    '<tr>' +
      '<td style="padding:10px;background-color:#0a0a0a;color:#ffffff;font-weight:bold;font-size:11px;text-transform:uppercase;">Total</td>' +
      '<td style="padding:10px;background-color:#0a0a0a;color:#ffffff;font-weight:bold;text-align:right;font-size:14px;">' + moneyFmt_(totals.total) + '</td>' +
    '</tr>';

  var sigBlock = '';
  if (signature) {
    sigBlock =
      '<table style="width:100%;border-collapse:collapse;margin-top:20px;">' +
        '<tr><td style="padding:14px 16px;border:1px solid #e2e2e2;background-color:#ffffff;">' +
          '<div style="font-size:9px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#cc1111;margin-bottom:6px;">Approved &amp; Signed</div>' +
          '<img src="' + signature.dataUri + '" width="200" alt="Signature" /><br/>' +
          '<div style="font-size:11px;color:#444444;margin-top:4px;">' + esc_(signature.name) + ' &middot; ' + esc_(signature.dateStr) + '</div>' +
        '</td></tr>' +
      '</table>';
  }

  return '' +
'<html><head><meta charset="UTF-8" /></head>' +
'<body style="font-family:Arial,Helvetica,sans-serif;color:#444444;margin:0;padding:0;">' +

'<table style="width:100%;border-collapse:collapse;background-color:#0a0a0a;">' +
  '<tr>' +
    '<td style="padding:12px 16px;"><img src="' + logoUrl + '" width="130" alt="Impact LED Signs" /></td>' +
    '<td style="padding:12px 16px;text-align:right;">' +
      '<span style="background-color:#cc1111;color:#ffffff;font-size:10px;font-weight:bold;letter-spacing:1px;padding:4px 10px;">QUOTATION</span>' +
    '</td>' +
  '</tr>' +
'</table>' +

'<table style="width:100%;border-collapse:collapse;border-bottom:3px solid #cc1111;">' +
  '<tr>' +
    '<td style="padding:14px 16px;">' +
      '<div style="font-size:9px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#cc1111;">Quote Number</div>' +
      '<div style="font-size:16px;font-weight:bold;color:#0a0a0a;">' + esc_(record.number) + '</div>' +
    '</td>' +
    '<td style="padding:14px 16px;text-align:right;font-size:10px;color:#888888;">' +
      'Date: <strong style="color:#0a0a0a;">' + esc_(fmtDate_(record.date)) + '</strong><br/>' +
      'Valid Until: <strong style="color:#0a0a0a;">' + esc_(fmtDate_(record.validUntil)) + '</strong>' +
    '</td>' +
  '</tr>' +
'</table>' +

'<table style="width:100%;border-collapse:collapse;margin-top:10px;">' +
  '<tr>' +
    '<td style="width:50%;padding:6px 16px;vertical-align:top;">' +
      '<div style="font-size:9px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#cc1111;">Prepared For</div>' +
      '<div style="font-size:12px;font-weight:bold;color:#0a0a0a;">' + esc_(record.company || record.contact || '—') + '</div>' +
      (record.company && record.contact ? '<div style="font-size:11px;color:#888888;">' + esc_(record.contact) + '</div>' : '') +
      (record.email ? '<div style="font-size:11px;color:#888888;">' + breakableEmail_(record.email) + '</div>' : '') +
      (record.phone ? '<div style="font-size:11px;color:#888888;">' + esc_(record.phone) + '</div>' : '') +
      (record.ticket ? '<div style="font-size:11px;color:#888888;">Ticket #: ' + esc_(record.ticket) + '</div>' : '') +
      (record.projectName ? '<div style="font-size:11px;color:#888888;">Project: ' + esc_(record.projectName) + '</div>' : '') +
    '</td>' +
    '<td style="width:50%;padding:6px 16px;vertical-align:top;">' +
      '<div style="font-size:9px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#cc1111;">Prepared By</div>' +
      '<div style="font-size:12px;font-weight:bold;color:#0a0a0a;">Impact LED Signs</div>' +
      (record.preparer ? '<div style="font-size:11px;color:#888888;">' + esc_(record.preparer) + '</div>' : '') +
    '</td>' +
  '</tr>' +
'</table>' +

((billLines.length || shipLines.length) ?
  '<table style="width:100%;border-collapse:collapse;margin-top:4px;">' +
    '<tr>' + addressCell_('Bill To', billLines) + addressCell_('Ship To', shipLines) + '</tr>' +
  '</table>'
  : '') +

'<table style="width:100%;border-collapse:collapse;margin-top:16px;">' +
  '<tr>' +
    '<th style="padding:8px 10px;border:1px solid #ccc;background-color:#f4f4f4;text-align:left;font-size:10px;text-transform:uppercase;">Part / Description</th>' +
    '<th style="padding:8px 10px;border:1px solid #ccc;background-color:#f4f4f4;font-size:10px;text-transform:uppercase;">Gen</th>' +
    '<th style="padding:8px 10px;border:1px solid #ccc;background-color:#f4f4f4;font-size:10px;text-transform:uppercase;">Qty</th>' +
    '<th style="padding:8px 10px;border:1px solid #ccc;background-color:#f4f4f4;font-size:10px;text-transform:uppercase;">Unit Price</th>' +
    '<th style="padding:8px 10px;border:1px solid #ccc;background-color:#f4f4f4;font-size:10px;text-transform:uppercase;">Disc</th>' +
    '<th style="padding:8px 10px;border:1px solid #ccc;background-color:#f4f4f4;font-size:10px;text-transform:uppercase;">Extended</th>' +
  '</tr>' +
  rows +
'</table>' +

'<table style="width:280px;border-collapse:collapse;margin:16px 0 0 auto;">' +
  totalRows +
'</table>' +

'<p style="font-size:10px;color:#888888;text-align:right;margin:0 0 16px;">Any applicable taxes due will be charged and may not be reflected in the quoted price.</p>' +

(terms ?
  '<table style="width:100%;border-collapse:collapse;margin-top:16px;">' +
    '<tr><td style="padding:14px 16px;background-color:#e8f0fe;border-left:4px solid #1a56a0;">' +
      '<div style="font-size:11px;font-weight:bold;color:#0f1f40;margin-bottom:4px;">Terms &amp; Notes</div>' +
      '<div style="font-size:11px;color:#1a3060;">' + esc_(terms) + '</div>' +
    '</td></tr>' +
  '</table>'
  : '') +

sigBlock +

'<table style="width:100%;border-collapse:collapse;background-color:#0a0a0a;margin-top:20px;">' +
  '<tr><td style="padding:14px 16px;text-align:center;color:#888888;font-size:9px;">' +
    'Impact LED Signs &nbsp;&middot;&nbsp; Quotation ' + esc_(record.number) + ' &nbsp;&middot;&nbsp; Valid until ' + esc_(fmtDate_(record.validUntil)) +
  '</td></tr>' +
'</table>' +

'</body></html>';
}

function lineRow_(part, desc, gens, qty, unit, discLabel, ext) {
  return '' +
    '<tr>' +
      '<td style="padding:8px 10px;border:1px solid #ccc;">' +
        '<div style="font-weight:bold;color:#0a0a0a;">' + esc_(part) + '</div>' +
        (desc ? '<div style="font-size:10px;color:#888888;">' + esc_(desc) + '</div>' : '') +
      '</td>' +
      '<td style="padding:8px 10px;border:1px solid #ccc;text-align:center;font-size:10px;color:#888888;">' + esc_(gens) + '</td>' +
      '<td style="padding:8px 10px;border:1px solid #ccc;text-align:center;">' + qty + '</td>' +
      '<td style="padding:8px 10px;border:1px solid #ccc;text-align:right;">' + moneyFmt_(unit) + '</td>' +
      '<td style="padding:8px 10px;border:1px solid #ccc;text-align:center;">' + esc_(discLabel) + '</td>' +
      '<td style="padding:8px 10px;border:1px solid #ccc;text-align:right;font-weight:bold;">' + moneyFmt_(ext) + '</td>' +
    '</tr>';
}

function totalsRow_(label, value, color) {
  return '<tr>' +
    '<td style="padding:6px 10px;color:' + color + ';">' + esc_(label) + '</td>' +
    '<td style="padding:6px 10px;text-align:right;color:' + color + ';">' + value + '</td>' +
  '</tr>';
}

var MONTHS_ = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Google Sheets silently converts date-looking text (e.g. "2026-09-16")
// into a real Date value when it's written to a cell -- so a value read
// back from the sheet may be a Date object even though it started as a
// plain ISO string on the way in. Handle both.
function fmtDate_(value) {
  if (!value) return '—';
  var d;
  if (Object.prototype.toString.call(value) === '[object Date]') {
    d = value;
  } else {
    var p = String(value).split('-');
    if (p.length !== 3) return String(value);
    d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }
  return MONTHS_[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

// Converts an HTML string to a PDF by importing it as a Google Doc (Drive
// auto-converts on upload when the target mimeType differs from the source),
// exporting that Doc as PDF, then discarding the intermediate Doc.
function htmlToPdf_(html, filenameBase) {
  var htmlBlob = Utilities.newBlob(html, 'text/html', filenameBase + '.html');
  var fileMetadata = {
    name: filenameBase,
    mimeType: MimeType.GOOGLE_DOCS,
    parents: [SIGNED_FOLDER_ID]
  };
  // supportsAllDrives is required for the Advanced Drive Service (v3 REST
  // API) to see/write items in a Shared Drive -- without it, a Shared Drive
  // folder ID comes back as "File not found" even with full access to it.
  var doc = Drive.Files.create(fileMetadata, htmlBlob, { supportsAllDrives: true });
  var pdfBlob = DriveApp.getFileById(doc.id).getAs(MimeType.PDF).setName(filenameBase + '.pdf');
  var pdfFile = DriveApp.getFolderById(SIGNED_FOLDER_ID).createFile(pdfBlob);
  DriveApp.getFileById(doc.id).setTrashed(true);
  return { blob: pdfFile.getBlob(), url: pdfFile.getUrl() };
}

// ---------------------------------------------------------------- Sheet helpers

function getSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function findRowIndex_(token) {
  var sheet = getSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var tokens = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < tokens.length; i++) {
    if (tokens[i][0] === token) return i + 2;
  }
  return null;
}

function rowToRecord_(row) {
  var record = {};
  HEADERS.forEach(function (key, i) { record[key] = row[i]; });
  return record;
}

// ---------------------------------------------------------------- misc helpers

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function moneyFmt_(n) {
  var num = Number(n) || 0;
  return '$' + num.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
