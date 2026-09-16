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
var SHEET_ID = 'PASTE_QUOTES_LOG_SPREADSHEET_ID_HERE';
var SIGNED_FOLDER_ID = 'PASTE_SIGNED_QUOTES_DRIVE_FOLDER_ID_HERE';
var ACCOUNTING_EMAIL = 'accounting@impactledsigns.com';
// ----------------------------------------------------------------------------

var COMPANY_NAME = 'Impact LED Signs';
var SHEET_NAME = 'Quotes';
var HEADERS = [
  'token', 'status', 'createdAt', 'signedAt',
  'company', 'contact', 'email', 'phone',
  'number', 'date', 'validUntil',
  'preparer', 'preparerEmail', 'total',
  'html', 'pdfUrl'
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
  getSheet_().appendRow([
    token, 'sent', new Date().toISOString(), '',
    body.company || '', body.contact || '', body.email || '', body.phone || '',
    body.number || '', body.date || '', body.validUntil || '',
    body.preparer || '', body.preparerEmail || '', body.total || 0,
    body.html || '', ''
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
  var signatureBlob = Utilities.newBlob(Utilities.base64Decode(pngBase64), 'image/png', 'signature.png');

  var signedHtml = injectSignature_(record.html, {
    name: body.signerName || record.contact,
    dateStr: signedAt.toLocaleString()
  }, signatureBlob);

  var safeNumber = String(record.number || 'quote').replace(/[^A-Za-z0-9\-_. ]/g, '');
  var pdf = htmlToPdf_(signedHtml, 'Quote ' + safeNumber + ' - Signed');

  sheet.getRange(rowIdx, HEADERS.indexOf('status') + 1).setValue('signed');
  sheet.getRange(rowIdx, HEADERS.indexOf('signedAt') + 1).setValue(signedAt.toISOString());
  sheet.getRange(rowIdx, HEADERS.indexOf('pdfUrl') + 1).setValue(pdf.url);

  notifyApproval_(record, pdf.blob, signedAt, body.signerName);

  return jsonOut_({ ok: true });
}

function notifyApproval_(record, pdfBlob, signedAt, signerName) {
  var bodyHtml =
    '<p>Quote <strong>' + esc_(record.number) + '</strong> was approved by ' +
    esc_(signerName || record.contact) + ' on ' + esc_(signedAt.toLocaleString()) + '.</p>' +
    '<table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:13px;">' +
      row_('Company', record.company) +
      row_('Contact', record.contact) +
      row_('Client email', record.email) +
      row_('Phone', record.phone) +
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

function row_(label, value) {
  return '<tr><td style="color:#888;">' + esc_(label) + '</td><td>' + esc_(value) + '</td></tr>';
}

// ---------------------------------------------------------------- PDF / signature

function injectSignature_(html, info, signatureBlob) {
  var dataUri = 'data:image/png;base64,' + Utilities.base64Encode(signatureBlob.getBytes());
  var block =
    '<div style="margin:26px 26px 30px;padding:18px 22px;border:1px solid #e2e2e2;' +
    'border-radius:10px;background:#fff;">' +
      '<div style="font-size:9px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;' +
      'color:#cc1111;margin-bottom:8px;">Approved &amp; Signed</div>' +
      '<img src="' + dataUri + '" alt="Signature" style="max-width:280px;max-height:90px;' +
      'display:block;margin-bottom:8px;" />' +
      '<div style="font-size:.85rem;color:#444;">' + esc_(info.name) + ' &middot; ' +
      esc_(info.dateStr) + '</div>' +
    '</div>';

  var idx = html.lastIndexOf('</body>');
  if (idx === -1) return html + block;
  return html.slice(0, idx) + block + html.slice(idx);
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
  var doc = Drive.Files.create(fileMetadata, htmlBlob);
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
