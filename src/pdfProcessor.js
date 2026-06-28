// pdfProcessor.js — extracts PageItems from each PDF page, and OCRs images
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

  // Shared: convert Tesseract line results → PageItem array
  function linesToPageItems(lines, canvasWidth, canvasHeight, pageNum, scale) {
    const inv = 1 / (scale || 1);
    const items = [];
    for (const line of (lines || [])) {
      const text = line.text.replace(/\n/g, ' ').trim();
      if (!text) continue;
      const lineH = (line.bbox.y1 - line.bbox.y0) * inv;
      // Flip Y: Tesseract Y=0 is top; we want top of page = high Y value
      const y = (canvasHeight - line.bbox.y0) * inv;
      items.push({
        str: text,
        x: line.bbox.x0 * inv,
        y,
        fontSize: lineH,
        fontName: 'body',
        pageNum,
        pageHeight: canvasHeight * inv,
      });
    }
    return items;
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

    return linesToPageItems(result.data.lines, viewport.width, viewport.height, pageNum, scale);
  }

  async function ocrImage(imageFile, onProgress) {
    await initTesseract();
    const bitmap = await createImageBitmap(imageFile);
    const w = bitmap.width;
    const h = bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();

    root.__ocrProgress__ = onProgress || null;
    const result = await tessWorker.recognize(canvas);
    root.__ocrProgress__ = null;

    return linesToPageItems(result.data.lines, w, h, 1, 1);
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
      return textItems;
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

  root.PdfProcessor = { processPDF, ocrImage };
})(window);
