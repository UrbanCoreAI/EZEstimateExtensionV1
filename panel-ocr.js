// Duke Estimating — OCR handler running in the panel page context
// Receives raw GIF bytes from background, runs Tesseract, returns plain text
// Worker is created once and reused across calls to avoid repeated init cost (~5-8s per call).

var _ocrWorker = null;
var _ocrWorkerReady = false;
var _ocrWorkerInitializing = null;

function getOcrWorker() {
  if (_ocrWorkerReady && _ocrWorker) return Promise.resolve(_ocrWorker);
  if (_ocrWorkerInitializing) return _ocrWorkerInitializing;
  _ocrWorkerInitializing = (async function() {
    var t0 = performance.now();
    var w = await Tesseract.createWorker({
      workerPath:    chrome.runtime.getURL('lib/worker.min.js'),
      langPath:      chrome.runtime.getURL('lib/'),
      corePath:      chrome.runtime.getURL('lib/tesseract-core.wasm.js'),
      workerBlobURL: false,
    });
    await w.loadLanguage('eng');
    await w.initialize('eng');
    console.log('[Duke Timing] Tesseract worker init: ' + (performance.now() - t0).toFixed(0) + 'ms');
    _ocrWorker = w;
    _ocrWorkerReady = true;
    _ocrWorkerInitializing = null;
    return w;
  })();
  return _ocrWorkerInitializing;
}

// Pre-warm the worker as soon as the panel loads
getOcrWorker().catch(function(e) {
  console.warn('[Duke] Tesseract pre-warm failed:', e.message);
});

chrome.runtime.onMessage.addListener(function(msg, _sender, sendResponse) {
  if (msg.target !== 'panel-ocr' || msg.action !== 'OCR_IMAGE') return;
  (async function() {
    try {
      var t0 = performance.now();
      var bin = atob(msg.gifBase64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var blob = new Blob([bytes], { type: 'image/gif' });
      var blobUrl = URL.createObjectURL(blob);

      var worker = await getOcrWorker();
      var tRecognize = performance.now();
      var result = await worker.recognize(blobUrl);
      console.log('[Duke Timing] Tesseract recognize only: ' + (performance.now() - tRecognize).toFixed(0) + 'ms');
      console.log('[Duke Timing] Tesseract total (incl worker get): ' + (performance.now() - t0).toFixed(0) + 'ms');

      URL.revokeObjectURL(blobUrl);
      sendResponse({ ok: true, text: result.data.text });
    } catch(e) {
      // If worker errored out, reset so next call re-initializes
      _ocrWorker = null;
      _ocrWorkerReady = false;
      _ocrWorkerInitializing = null;
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});
