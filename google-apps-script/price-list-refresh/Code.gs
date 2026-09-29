/**
 * "Refresh Website" button for the price list Google Sheet.
 *
 * Triggers the repo's `refresh-prices` GitHub Action, which downloads this
 * sheet, regenerates index.html, and pushes it live. See README.md in this
 * folder for one-time setup (GitHub token, menu vs. drawing button).
 */

var GITHUB_OWNER = 'Sacton86';
var GITHUB_REPO = 'itemlist';
var WORKFLOW_FILE = 'refresh-prices.yml';
var GITHUB_BRANCH = 'main';

function onOpen() {
  SpreadsheetApp.getUi()
      .createMenu('Price List')
      .addItem('Refresh Website', 'refreshWebsite')
      .addToUi();
}

function refreshWebsite() {
  var ui = SpreadsheetApp.getUi();
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    ui.alert(
        'No GitHub token set.\n\n' +
        'Go to Project Settings (gear icon) → Script Properties, and add a ' +
        'property named GITHUB_TOKEN with your GitHub token as the value.');
    return;
  }

  var url = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO +
      '/actions/workflows/' + WORKFLOW_FILE + '/dispatches';

  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json'
    },
    payload: JSON.stringify({ref: GITHUB_BRANCH}),
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  if (code === 204) {
    ui.alert(
        'Website refresh started.\n\n' +
        'It usually takes 30–60 seconds. Progress: ' +
        'https://github.com/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/actions');
  } else if (code === 401 || code === 403) {
    ui.alert(
        'GitHub rejected the request (' + code + ').\n\n' +
        'The GITHUB_TOKEN script property is missing, expired, or lacks ' +
        '"Actions: read and write" permission on this repo. See README.md ' +
        'in this folder to generate a new one.');
  } else {
    ui.alert('GitHub returned an error (' + code + '):\n' + response.getContentText());
  }
}
