// Duke Estimating - Offscreen Document
// Renders PDF pages to PNG images (PDF.js) and runs Tesseract OCR on spec pages

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  if (msg.action === 'OCR_IMAGE') {
    ocrGifBase64(msg.gifBase64)
      .then(text => sendResponse({ ok: true, text }))
      .catch(e  => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.action === 'RENDER_PDF_PAGES') {
    renderPDF(msg.pdfBase64, msg.scale || 2.5)
      .then(images => sendResponse({ ok: true, images }))
      .catch(e  => sendResponse({ ok: false, error: e.message }));
    return true; // keep channel open
  }
});

async function renderPDF(pdfBase64, scale) {
  // Decode base64 → Uint8Array
  const binary = atob(pdfBase64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const totalPages = pdf.numPages;
  const images = [];

  // Render all pages (floor plans often span 2 pages)
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const page     = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width  = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;

    // Convert to base64 PNG
    const dataUrl = canvas.toDataURL('image/png');
    images.push(dataUrl.split(',')[1]);

    canvas.remove();
  }

  return images; // array of base64 PNG strings, one per page
}

// ─── Tesseract OCR ────────────────────────────────────────────────────────────

async function ocrGifBase64(gifBase64) {
  // Decode base64 GIF → Blob → object URL (Tesseract accepts a URL)
  const binary = atob(gifBase64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob   = new Blob([bytes], { type: 'image/gif' });
  const blobUrl = URL.createObjectURL(blob);

  const workerPath = chrome.runtime.getURL('lib/worker.min.js');
  const corePath   = chrome.runtime.getURL('lib/');
  const langPath   = chrome.runtime.getURL('lib/');

  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath,
    langPath,
    corePath,
    workerBlobURL: false,
  });

  try {
    const { data: { text } } = await worker.recognize(blobUrl);
    return text;
  } finally {
    await worker.terminate();
    URL.revokeObjectURL(blobUrl);
  }
}
