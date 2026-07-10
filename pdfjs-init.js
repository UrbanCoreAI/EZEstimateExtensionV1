// pdfjs-init.js — sets worker path and marks PDF engine ready
// Polls so it works regardless of whether pdfjsLib appears sync or async

(function tryInit(attempt) {
  attempt = attempt || 0;

  try {
    // pdfjs v2 UMD sets globalThis.pdfjsLib AND globalThis["pdfjs-dist/build/pdf"]
    var lib = globalThis['pdfjs-dist/build/pdf'] || globalThis.pdfjsLib || self.pdfjsLib;

    if (lib) {
      lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
      globalThis.pdfjsLib   = lib;
      globalThis.pdfjsReady = true;

      // Dispatch event — popup.js polls for pdfjsReady so timing doesn't matter
      try { document.dispatchEvent(new CustomEvent('pdfjs-ready')); } catch (e) {}

      console.log('[Duke] PDF engine ready (attempt ' + attempt + ')');
    } else if (attempt < 30) {
      // Retry every 100ms for up to 3 seconds
      setTimeout(function() { tryInit(attempt + 1); }, 100);
    } else {
      console.error('[Duke] PDF engine failed to load after 3s. Keys:', Object.keys(globalThis).filter(function(k){ return /pdf/i.test(k); }));
    }
  } catch (e) {
    console.error('[Duke] pdfjs-init error:', e.message);
    if (attempt < 30) setTimeout(function() { tryInit(attempt + 1); }, 100);
  }
})(0);
