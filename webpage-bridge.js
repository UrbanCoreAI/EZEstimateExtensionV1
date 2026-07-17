// Keel EZ Estimate — Webpage Bridge
//
// Runs as a content script on the public EZEstimate webpage
// (https://alanamac222.github.io/*). Lets that plain webpage hand off
// the "Write to Estimate" flow to this extension, which has the
// chrome.tabs / chrome.scripting permissions needed to show a real
// tab picker and write values directly into the chosen BuilderTrend tab.
//
// Protocol (window.postMessage, since the webpage has no direct access
// to chrome.runtime):
//   Page  -> Bridge : { source: 'keel-quick-quote',     type: 'OPEN_ESTIMATE_TAB_PICKER', items: [...], slowConnection: bool }
//   Page  -> Bridge : { source: 'keel-quick-quote',     type: 'RUN_CLIENT_PREVIEW', slowConnection: bool }
//   Bridge -> Page  : { source: 'duke-ext',             type: 'EXTENSION_READY' }
//   Bridge -> Page  : { source: 'duke-ext',             type: 'OPEN_ESTIMATE_TAB_PICKER_RESULT', ok, error }

(function () {
  'use strict';

  // Let the webpage know the extension is installed and this bridge is live.
  // Sent on load, and again whenever the page asks (in case the page's
  // listener wasn't attached yet when we first posted).
  function announceReady() {
    window.postMessage({ source: 'duke-ext', type: 'EXTENSION_READY' }, '*');
  }
  announceReady();

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== 'keel-quick-quote') return;

    if (data.type === 'PING_EXTENSION') {
      announceReady();
      return;
    }

    if (data.type === 'OPEN_ESTIMATE_TAB_PICKER') {
      chrome.runtime.sendMessage(
        { action: 'OPEN_ESTIMATE_TAB_PICKER', items: data.items || [], customItems: data.customItems || [], siteOptions: data.siteOptions || [], slowConnection: !!data.slowConnection },
        function (res) {
          var err = chrome.runtime.lastError;
          window.postMessage({
            source: 'duke-ext',
            type: 'OPEN_ESTIMATE_TAB_PICKER_RESULT',
            ok: !err && !!(res && res.ok),
            error: err ? err.message : (res && res.error)
          }, '*');
        }
      );
    }

    if (data.type === 'RUN_CLIENT_PREVIEW') {
      chrome.runtime.sendMessage(
        { action: 'RUN_CLIENT_PREVIEW', slowConnection: !!data.slowConnection },
        function (res) {
          var err = chrome.runtime.lastError;
          window.postMessage({
            source: 'duke-ext',
            type: 'RUN_CLIENT_PREVIEW_RESULT',
            ok: !err && !!(res && res.ok),
            error: err ? err.message : (res && res.error)
          }, '*');
        }
      );
    }

    if (data.type === 'DOWNLOAD_PROPOSAL_PDF') {
      chrome.runtime.sendMessage({ action: 'GET_PROPOSAL_PDF' }, function (res) {
        var err = chrome.runtime.lastError;
        window.postMessage({
          source: 'duke-ext',
          type: 'PROPOSAL_PDF_DATA',
          ok: !err && !!(res && res.ok),
          data: res && res.data,
          error: err ? err.message : (res && res.error)
        }, '*');
      });
    }
  });

  // Background notifies us directly when a PDF is ready
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.action === 'PROPOSAL_PDF_READY') {
      window.postMessage({ source: 'duke-ext', type: 'PROPOSAL_PDF_READY' }, '*');
    }
  });
})();
