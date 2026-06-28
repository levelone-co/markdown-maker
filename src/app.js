// app.js — UI orchestration for Level One PDF Converter
(function () {
  'use strict';

  const APP_VERSION = '0.1.0';

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const dropZone    = document.getElementById('drop-zone');
  const fileInput   = document.getElementById('file-input');
  const browseBtn   = document.getElementById('browse-btn');
  const progressBar = document.getElementById('progress-bar');
  const progressWrap= document.getElementById('progress-wrap');
  const progressLbl = document.getElementById('progress-label');
  const outputArea  = document.getElementById('output-area');
  const mdEditor    = document.getElementById('md-editor');
  const mdPreview   = document.getElementById('md-preview');
  const btnCopy     = document.getElementById('btn-copy');
  const btnDownload = document.getElementById('btn-download');
  const btnMd       = document.getElementById('btn-view-md');
  const btnPreview  = document.getElementById('btn-view-preview');
  const btnSplit    = document.getElementById('btn-view-split');
  const toolbar     = document.getElementById('toolbar');
  const themeBtn    = document.getElementById('theme-btn');
  const footerVer   = document.getElementById('footerVersion');
  const kofiCup     = document.getElementById('kofi-cup');

  // ── Init ──────────────────────────────────────────────────────────────────
  footerVer.textContent = `v${APP_VERSION}`;
  if (window.__KOFI_CUP_B64__) {
    kofiCup.src = `data:image/png;base64,${window.__KOFI_CUP_B64__}`;
  }

  // Set up pdf.js worker from inline blob
  (function initPdfjsWorker() {
    const workerSrc = window.__PDFJS_WORKER_SRC__;
    const blob = new Blob([workerSrc], { type: 'application/javascript' });
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  })();

  // Set up Tesseract blob URLs from inline data
  (function initTesseractUrls() {
    const workerSrc = window.__TESS_WORKER_SRC__;
    const blob = new Blob([workerSrc], { type: 'application/javascript' });
    window.__TESS_WORKER_URL__ = URL.createObjectURL(blob);
    // corePath and langPath are handled by the patched worker itself
    window.__TESS_CORE_URL__ = undefined;
    window.__TESS_LANG_URL__ = undefined;
  })();

  // ── Theme ─────────────────────────────────────────────────────────────────
  const saved = localStorage.getItem('lo-theme');
  if (saved === 'light') document.body.classList.add('light');

  themeBtn.addEventListener('click', () => {
    const isLight = document.body.classList.toggle('light');
    localStorage.setItem('lo-theme', isLight ? 'light' : 'dark');
  });

  // ── Drag & drop ───────────────────────────────────────────────────────────
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  browseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
    fileInput.value = '';
  });

  // ── View toggles ──────────────────────────────────────────────────────────
  function setView(mode) {
    outputArea.dataset.view = mode;
    btnMd.classList.toggle('active', mode === 'md');
    btnPreview.classList.toggle('active', mode === 'preview');
    btnSplit.classList.toggle('active', mode === 'split');
    localStorage.setItem('lo-view', mode);
  }
  btnMd.addEventListener('click', () => setView('md'));
  btnPreview.addEventListener('click', () => setView('preview'));
  btnSplit.addEventListener('click', () => setView('split'));
  setView(localStorage.getItem('lo-view') || 'split');

  // ── Copy & download ───────────────────────────────────────────────────────
  btnCopy.addEventListener('click', async () => {
    const text = mdEditor.value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      btnCopy.textContent = 'Copied!';
      setTimeout(() => btnCopy.textContent = 'Copy', 1500);
    } catch {
      btnCopy.textContent = 'Failed';
      setTimeout(() => btnCopy.textContent = 'Copy', 1500);
    }
  });

  btnDownload.addEventListener('click', () => {
    const text = mdEditor.value;
    if (!text) return;
    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (window.__currentFilename__ || 'document').replace(/\.pdf$/i, '') + '.md';
    a.click();
    URL.revokeObjectURL(url);
  });

  // Live preview update as user edits
  mdEditor.addEventListener('input', renderPreview);

  // ── Main pipeline ─────────────────────────────────────────────────────────
  let converting = false;

  async function handleFile(file) {
    if (converting) return;
    if (!file || file.type !== 'application/pdf') {
      showError('Please drop a PDF file.');
      return;
    }
    converting = true;
    window.__currentFilename__ = file.name;

    showProgress('Loading PDF…', 0);
    outputArea.classList.add('hidden');
    toolbar.classList.add('hidden');

    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const total = pdfDoc.numPages;

      let pagesProcessed = 0;
      const onProgress = ({ phase, page, total: t, progress }) => {
        const tot = t || total;
        if (phase === 'extract') showProgress(`Extracting page ${page} / ${tot}…`, page / tot * 50);
        if (phase === 'ocr')     showProgress(`OCR page ${page} / ${tot}… ${progress ? Math.round(progress * 100) + '%' : ''}`, (page - 1) / tot * 50 + 25);
        if (phase === 'done-page') {
          pagesProcessed++;
          showProgress(`Processed ${pagesProcessed} / ${tot} pages…`, 50 + pagesProcessed / tot * 45);
        }
      };

      showProgress('Extracting text…', 5);
      const items = await PdfProcessor.processPDF(pdfDoc, onProgress);

      showProgress('Converting to Markdown…', 96);
      const markdown = MarkdownConverter.convertToMarkdown(items, total);

      displayMarkdown(markdown);
    } catch (err) {
      showError('Conversion failed: ' + err.message);
      console.error(err);
    } finally {
      converting = false;
    }
  }

  function displayMarkdown(markdown) {
    mdEditor.value = markdown;
    renderPreview();
    outputArea.classList.remove('hidden');
    toolbar.classList.remove('hidden');
    progressWrap.classList.add('hidden');
    dropZone.classList.add('has-result');
  }

  function renderPreview() {
    if (typeof marked !== 'undefined') {
      mdPreview.innerHTML = marked.parse(mdEditor.value || '');
    } else {
      mdPreview.textContent = mdEditor.value;
    }
  }

  function showProgress(label, pct) {
    progressWrap.classList.remove('hidden');
    progressLbl.textContent = label;
    progressBar.style.width = Math.min(100, pct) + '%';
  }

  function showError(msg) {
    progressWrap.classList.remove('hidden');
    progressLbl.textContent = '⚠ ' + msg;
    progressBar.style.width = '0%';
  }

})();
