// pdfProcessor.js — extracts PageItems from each PDF page
// Depends on: pdfjsLib (global), Tesseract (global, lazy-init)
// PageItem: { str, x, y, fontSize, fontName, pageNum, pageHeight }

(function (root) {
  'use strict';

  const OCR_MIN_CHARS = 40; // fewer than this → treat page as scanned

  let tessWorker = null;
  let tessReady = false;
  let tessInitPromise = null;

  function initTesseract() {
    if (tessReady) return Promise.resolve();
    if (tessInitPromise) return tessInitPromise;
    tessInitPromise = (async () => {
      tessWorker = await Tesseract.createWorker('eng', 1, {
        workerPath: root.__TESS_WORKER_URL__,
        corePath: root.__TESS_CORE_URL__ || undefined,
        langPath: root.__TESS_LANG_URL__ || undefined,
        logger: m => {
          if (m.status === 'recognizing text' && root.__ocrProgress__) {
            root.__ocrProgress__(m.progress);
          }
        },
      });
      tessReady = true;
    })();
    return tessInitPromise;
  }

  // Extract font size from the pdf.js transform matrix [a,b,c,d,tx,ty]
  function fontSizeFromTransform(transform) {
    const [a, b, c, d] = transform;
    return Math.round(Math.sqrt(b * b + d * d) * 10) / 10 || Math.round(Math.sqrt(a * a + c * c) * 10) / 10;
  }

  async function extractTextItems(page, pageNum) {
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent({ includeMarkedContent: false });
    const items = [];
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const fontSize = fontSizeFromTransform(item.transform);
      items.push({
        str: item.str,
        x: item.transform[4],
        y: item.transform[5],
        fontSize,
        fontName: item.fontName || '',
        pageNum,
        pageHeight: viewport.height,
      });
    }
    return items;
  }

  async function ocrPage(page, pageNum, onPageProgress) {
    await initTesseract();
    const scale = 2.5; // ~180 DPI equivalent
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    root.__ocrProgress__ = onPageProgress;
    const result = await tessWorker.recognize(canvas);
    root.__ocrProgress__ = null;

    // Convert tesseract lines to PageItems (normalise Y to PDF coordinate space)
    const items = [];
    const scaleInv = 1 / scale;
    for (const line of (result.data.lines || [])) {
      const text = line.text.replace(/\n/g, ' ').trim();
      if (!text) continue;
      const lineH = (line.bbox.y1 - line.bbox.y0) * scaleInv;
      // Flip Y: tesseract Y=0 is top, PDF Y=0 is bottom
      const pdfY = (viewport.height - line.bbox.y0 * scale) * scaleInv;
      items.push({
        str: text,
        x: line.bbox.x0 * scaleInv,
        y: pdfY,
        fontSize: lineH,
        fontName: 'body',
        pageNum,
        pageHeight: viewport.height * scaleInv,
      });
    }
    return items;
  }

  async function processPage(page, pageNum, onProgress) {
    onProgress({ phase: 'extract', page: pageNum });
    const textItems = await extractTextItems(page, pageNum);
    const charCount = textItems.reduce((s, i) => s + i.str.length, 0);

    if (charCount >= OCR_MIN_CHARS) {
      return textItems;
    }

    // Sparse text → OCR fallback
    onProgress({ phase: 'ocr', page: pageNum });
    try {
      return await ocrPage(page, pageNum, (p) => onProgress({ phase: 'ocr', page: pageNum, progress: p }));
    } catch (e) {
      console.warn(`OCR failed on page ${pageNum}:`, e);
      return textItems; // return whatever text we had
    }
  }

  async function processPDF(pdfDoc, onProgress) {
    const numPages = pdfDoc.numPages;
    const allItems = [];
    for (let p = 1; p <= numPages; p++) {
      const page = await pdfDoc.getPage(p);
      const items = await processPage(page, p, onProgress);
      allItems.push(...items);
      onProgress({ phase: 'done-page', page: p, total: numPages });
    }
    return allItems;
  }

  root.PdfProcessor = { processPDF };
})(window);
