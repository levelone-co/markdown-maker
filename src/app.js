// app.js — UI orchestration for Level One Markdown Maker
(function () {
  'use strict';

  const APP_VERSION = '0.4.1';

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
  const infoBtn     = document.getElementById('info-btn');
  const infoModal   = document.getElementById('info-modal');
  const infoClose   = document.getElementById('info-close');
  const footerVer   = document.getElementById('footerVersion');
  const kofiCup     = document.getElementById('kofi-cup');
  const urlInput    = document.getElementById('url-input');
  const urlBtn      = document.getElementById('url-btn');
  const updateToast = document.getElementById('update-toast');
  const updateBtn   = document.getElementById('update-refresh');
  const dlBtn       = document.getElementById('dl-btn');

  // ── Init ──────────────────────────────────────────────────────────────────
  footerVer.textContent = `v${APP_VERSION}`;
  if (dlBtn && !location.protocol.startsWith('http')) dlBtn.style.display = 'none';
  if (window.__KOFI_CUP_B64__) {
    kofiCup.src = `data:image/png;base64,${window.__KOFI_CUP_B64__}`;
  }

  // Set up pdf.js worker from inline blob
  (function initPdfjsWorker() {
    const blob = new Blob([window.__PDFJS_WORKER_SRC__], { type: 'application/javascript' });
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  })();

  // Set up Tesseract blob URL from inline data
  (function initTesseractUrls() {
    const blob = new Blob([window.__TESS_WORKER_SRC__], { type: 'application/javascript' });
    window.__TESS_WORKER_URL__ = URL.createObjectURL(blob);
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

  // ── Info modal ────────────────────────────────────────────────────────────
  infoBtn.addEventListener('click', () => infoModal.classList.remove('hidden'));
  infoClose.addEventListener('click', () => infoModal.classList.add('hidden'));
  infoModal.addEventListener('click', e => { if (e.target === infoModal) infoModal.classList.add('hidden'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') infoModal.classList.add('hidden'); });

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

  // ── URL + paste-HTML input ──────────────────────────────────────────────────
  urlBtn.addEventListener('click', () => handleUrl(urlInput.value.trim()));
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleUrl(urlInput.value.trim()); });

  // ── Paste-to-convert: screenshot → OCR, copied web selection → Markdown ──────
  document.addEventListener('paste', e => {
    const cd = e.clipboardData;
    if (!cd || converting) return;
    const tag = e.target && e.target.tagName;
    const inField = tag === 'INPUT' || tag === 'TEXTAREA';

    // 1. Image on clipboard → OCR (allowed anywhere; an image can't live in a text field)
    const imgItem = Array.from(cd.items || []).find(it => it.type.startsWith('image/'));
    if (imgItem) {
      const file = imgItem.getAsFile();
      if (file) { e.preventDefault(); handleFile(file); return; }
    }

    // 2. Rich HTML on clipboard → convert — but not while deliberately editing a field
    //    (so pasting a URL into #url-input or editing #md-editor behaves normally)
    if (!inField) {
      const html = cd.getData('text/html');
      if (html && html.trim()) {
        e.preventDefault();
        window.__currentFilename__ = 'pasted';
        handlePastedHtml(html);
      }
    }
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
    a.download = (window.__currentFilename__ || 'document').replace(/\.[^.]+$/, '') + '.md';
    a.click();
    URL.revokeObjectURL(url);
  });

  mdEditor.addEventListener('input', renderPreview);

  // ── Main pipeline ─────────────────────────────────────────────────────────
  let converting = false;

  function classifyFile(file) {
    const mime = file.type || '';
    const name = file.name || '';
    if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
    if (mime.startsWith('image/') || /\.(png|jpe?g|webp|tiff?|bmp|gif)$/i.test(name)) return 'image';
    if (mime === 'text/html' || /\.html?$/i.test(name)) return 'html';
    return null;
  }

  async function handleFile(file) {
    if (converting) return;
    const kind = classifyFile(file);
    if (!kind) {
      showError('Unsupported file type. Drop a PDF, image, or HTML file.');
      return;
    }
    converting = true;
    window.__currentFilename__ = file.name;
    outputArea.classList.add('hidden');
    toolbar.classList.add('hidden');

    try {
      let markdown;

      if (kind === 'pdf') {
        showProgress('Loading PDF…', 0);
        const arrayBuffer = await file.arrayBuffer();
        const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const total = pdfDoc.numPages;
        let done = 0;
        const onProgress = ({ phase, page, total: t, progress }) => {
          const tot = t || total;
          if (phase === 'extract') showProgress(`Extracting page ${page} / ${tot}…`, page / tot * 50);
          if (phase === 'ocr')     showProgress(`OCR page ${page} / ${tot}… ${progress ? Math.round(progress * 100) + '%' : ''}`, (page - 1) / tot * 50 + 25);
          if (phase === 'done-page') { done++; showProgress(`Processed ${done} / ${tot} pages…`, 50 + done / tot * 45); }
        };
        showProgress('Extracting text…', 5);
        const items = await PdfProcessor.processPDF(pdfDoc, onProgress);
        showProgress('Converting to Markdown…', 96);
        markdown = MarkdownConverter.convertToMarkdown(items, total);

      } else if (kind === 'image') {
        showProgress('Starting OCR…', 5);
        const items = await PdfProcessor.ocrImage(file, p => showProgress(`OCR… ${Math.round(p * 100)}%`, 5 + p * 88));
        showProgress('Converting to Markdown…', 96);
        markdown = MarkdownConverter.convertToMarkdown(items, 1);

      } else if (kind === 'html') {
        showProgress('Converting HTML…', 20);
        markdown = await HtmlConverter.convertHtml(file);
        showProgress('Done.', 100);
      }

      displayMarkdown(markdown);
    } catch (err) {
      showError('Conversion failed: ' + err.message);
      console.error(err);
    } finally {
      converting = false;
    }
  }

  async function handleUrl(url) {
    if (converting || !url) return;
    if (!/^https?:\/\//i.test(url)) { showError('Enter a full URL starting with http:// or https://'); return; }
    converting = true;
    outputArea.classList.add('hidden');
    toolbar.classList.add('hidden');
    try {
      window.__currentFilename__ = (url.split('/').filter(Boolean).pop() || 'page').replace(/[?#].*$/, '');
      showProgress('Fetching URL…', 20);
      let res;
      try {
        res = await fetch(url);
      } catch (e) {
        throw new Error('CORS');
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();
      showProgress('Converting HTML…', 70);
      const markdown = HtmlConverter.convertHtmlString(html);
      if (!markdown || markdown.trim().length < 20) {
        showError('Nothing useful extracted from that URL. The site may block scraping — open the page, select the content, copy it, and paste here (Cmd/Ctrl+V).');
        return;
      }
      displayMarkdown(markdown);
    } catch (err) {
      if (err.message === 'CORS') {
        showError('Couldn\'t fetch that URL — the site blocks cross-origin requests. Open the page, select the content, copy it, and paste here (Cmd/Ctrl+V).');
      } else {
        showError('Could not fetch URL: ' + err.message);
      }
    } finally {
      converting = false;
    }
  }

  function handlePastedHtml(html) {
    if (converting || !html.trim()) return;
    converting = true;
    outputArea.classList.add('hidden');
    toolbar.classList.add('hidden');
    try {
      window.__currentFilename__ = 'pasted';
      showProgress('Converting HTML…', 50);
      const markdown = HtmlConverter.convertHtmlString(html);
      displayMarkdown(markdown);
    } catch (err) {
      showError('Conversion failed: ' + err.message);
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
    // Typeset math in the preview only — the source markdown keeps its raw $…$ notation.
    if (typeof renderMathInElement === 'function') {
      try {
        renderMathInElement(mdPreview, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$',  right: '$',  display: false },
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false }
          ],
          throwOnError: false
        });
      } catch (_) { /* math optional */ }
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
    converting = false;
  }

  // ── Service worker (PWA) — only when hosted, never from file:// ─────────────
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          // A new worker is installed and an old one already controls the page → update available
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            updateToast.classList.remove('hidden');
            updateBtn.onclick = () => {
              if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
              updateToast.classList.add('hidden');
            };
          }
        });
      });
    }).catch(() => { /* SW optional; ignore */ });

    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloaded) { reloaded = true; location.reload(); }
    });
  }

})();
