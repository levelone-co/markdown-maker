#!/usr/bin/env node
// build.js — assembles dist/markdown-maker.html (single file) and dist/web/ (PWA bundle)
// Run once with internet; the output works forever offline.
'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const SRC  = path.join(ROOT, 'src');
const DEPS = path.join(ROOT, 'deps');
const DIST = path.join(ROOT, 'dist');
const NM   = path.join(ROOT, 'node_modules');

[DEPS, DIST].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Helpers ───────────────────────────────────────────────────────────────

function log(msg) { process.stdout.write(msg + '\n'); }

// JSON.stringify safe for embedding inside HTML <script> blocks.
// The HTML parser terminates a script block on any </script (case-insensitive),
// so we must escape every </ sequence inside string literals.
function jsStr(value) {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

// Safe for directly-inlining JS source inside a <script> block.
// Only escapes </script (case-insensitive) — the exact sequence the HTML parser
// uses to close a script block. Replacing all </ would break regex literals like
// /^</.test(x) by extending them into surrounding code.
function safeInlineJs(src) {
  return src.replace(/<\/script/gi, '<\\/script');
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) { log(`  cached: ${path.basename(dest)}`); return resolve(); }
    log(`  downloading: ${url}`);
    const file = fs.createWriteStream(dest);
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => { fs.unlinkSync(dest); reject(err); });
  });
}

function toB64(buf) {
  return Buffer.from(buf).toString('base64');
}

// Find a file in node_modules, trying several candidate paths
function nmFile(pkg, ...candidates) {
  for (const c of candidates) {
    const p = path.join(NM, pkg, c);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`Cannot find ${pkg}: tried ${candidates.join(', ')}`);
}

// Find the Tesseract core WASM JS wrapper and binary
function findTesseractCore() {
  // tesseract.js ships its core as 'tesseract.js-core' (files at package root)
  // or scoped '@tesseract.js-core/*' (files in dist/)
  const candidates = [
    // Unscoped package (tesseract.js v5): files at package root
    { pkg: 'tesseract.js-core', dir: path.join(NM, 'tesseract.js-core') },
    // Scoped packages (older): files in dist/
    ...['@tesseract.js-core/tesseract-core-simd-lstm',
        '@tesseract.js-core/tesseract-core-simd',
        '@tesseract.js-core/tesseract-core-lstm',
        '@tesseract.js-core/tesseract-core'].map(pkg => ({
      pkg, dir: path.join(NM, pkg, 'dist'),
    })),
    // Also check dist/ of unscoped package
    { pkg: 'tesseract.js-core/dist', dir: path.join(NM, 'tesseract.js-core', 'dist') },
  ];

  // Preference order for WASM variant (SIMD+LSTM is best quality)
  const wasmPreference = [
    'tesseract-core-simd-lstm.wasm.js',
    'tesseract-core-simd.wasm.js',
    'tesseract-core-lstm.wasm.js',
    'tesseract-core.wasm.js',
  ];

  for (const { pkg, dir } of candidates) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    const jsFile = wasmPreference.find(f => files.includes(f));
    if (!jsFile) continue;
    const wasmFile = jsFile.replace('.wasm.js', '.wasm');
    if (!files.includes(wasmFile)) continue;
    log(`  using: ${pkg}/${jsFile}`);
    return {
      jsPath:   path.join(dir, jsFile),
      wasmPath: path.join(dir, wasmFile),
    };
  }
  throw new Error('Tesseract core WASM not found. Try: npm install');
}

// Patch the tesseract.js worker so it works in an offline blob context:
//  1. Remove importScripts calls for the core (core is inlined before the worker)
//  2. Prepend fetch/XHR intercepts that serve WASM and lang data from base64 globals
function buildTesseractWorkerBlob(workerSrc, coreJsSrc) {
  // Remove any importScripts calls that reference the core
  const patchedWorker = workerSrc
    .replace(/importScripts\([^)]*tesseract-core[^)]*\);?/g, '/* core inlined */')
    .replace(/importScripts\s*\(\s*[`'"]([^`'"]*corePath[^`'"]*)[`'"]\s*\);?/g, '/* core inlined */')
    // Also handle: importScripts(env.corePath + '/...')
    .replace(/importScripts\s*\([^)]*corePath[^)]*\);?/g, '/* core inlined */');

  const preamble = `
/* === OFFLINE PREAMBLE (Level One Markdown Maker) === */
(function() {
  function _b64ToArr(b64) {
    var raw = atob(b64), buf = new ArrayBuffer(raw.length), view = new Uint8Array(buf);
    for (var i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
    return buf;
  }
  var __wasmBuf = _b64ToArr(self.__WASM_B64__);
  var __langBuf = _b64ToArr(self.__LANG_B64__);

  var _origFetch = self.fetch;
  self.fetch = function(url, opts) {
    var u = String(typeof url === 'string' ? url : (url && url.url) || url);
    if (u.indexOf('.wasm') !== -1) {
      return Promise.resolve(new Response(__wasmBuf.slice(0), {
        status: 200, headers: { 'Content-Type': 'application/wasm' }
      }));
    }
    if (u.indexOf('.traineddata') !== -1) {
      return Promise.resolve(new Response(__langBuf.slice(0), {
        status: 200, headers: { 'Content-Type': 'application/octet-stream' }
      }));
    }
    if (_origFetch) return _origFetch(url, opts);
    return Promise.reject(new Error('fetch not available'));
  };

  var _XHR = self.XMLHttpRequest;
  if (_XHR) {
    function PatchedXHR() {
      var real = new _XHR();
      var _open = real.open.bind(real);
      real.open = function(m, u) {
        real.__lo_url__ = u;
        return _open.apply(real, arguments);
      };
      var _send = real.send.bind(real);
      real.send = function() {
        var u = real.__lo_url__ || '';
        if (u.indexOf('.wasm') !== -1 || u.indexOf('.traineddata') !== -1) {
          var buf = u.indexOf('.wasm') !== -1 ? __wasmBuf.slice(0) : __langBuf.slice(0);
          setTimeout(function() {
            try {
              Object.defineProperty(real, 'readyState', { get: function() { return 4; }, configurable: true });
              Object.defineProperty(real, 'status', { get: function() { return 200; }, configurable: true });
              Object.defineProperty(real, 'response', { get: function() { return buf; }, configurable: true });
            } catch(e) {}
            if (real.onload) real.onload();
            if (real.onreadystatechange) real.onreadystatechange();
          }, 0);
          return;
        }
        return _send.apply(real, arguments);
      };
      return real;
    }
    PatchedXHR.prototype = _XHR.prototype;
    self.XMLHttpRequest = PatchedXHR;
  }
})();
/* === END OFFLINE PREAMBLE === */
`;

  return preamble + '\n' + coreJsSrc + '\n' + patchedWorker;
}

// Fetch text from URL (follows redirects)
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    get(url, { headers: { 'User-Agent': ua } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchText(res.headers.location).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

// Download Google Fonts (Quicksand) and return base64 @font-face CSS
async function downloadQuicksand() {
  // Resolve current WOFF2 URLs via the Google Fonts CSS v2 API
  const apiUrl = 'https://fonts.googleapis.com/css2?family=Quicksand:wght@400;700&display=swap';
  log('  fetching font CSS from Google Fonts API…');
  const fontCssRaw = await fetchText(apiUrl);

  // Parse @font-face blocks, extract weight + src URL (woff2 preferred, ttf fallback)
  const blocks = fontCssRaw.split('@font-face');
  const found = {};
  for (const block of blocks) {
    const wm = block.match(/font-weight:\s*(\d+)/);
    // Match woff2 or ttf src URL (unquoted in Google Fonts CSS)
    const um = block.match(/url\((https:\/\/fonts\.gstatic\.com[^)]+\.(?:woff2|ttf))\)/);
    if (wm && um) found[wm[1]] = { url: um[1], fmt: um[1].endsWith('.woff2') ? 'woff2' : 'truetype' };
  }

  let css = '';
  for (const [weight, { url, fmt }] of Object.entries(found)) {
    if (!['400', '700'].includes(weight)) continue;
    const ext = url.endsWith('.woff2') ? 'woff2' : 'ttf';
    const dest = path.join(DEPS, `quicksand-${weight}.${ext}`);
    await download(url, dest);
    const b64 = toB64(fs.readFileSync(dest));
    const mimeType = ext === 'woff2' ? 'font/woff2' : 'font/ttf';
    css += `@font-face{font-family:'Quicksand';font-style:normal;font-weight:${weight};src:url('data:${mimeType};base64,${b64}') format('${fmt}');}\n`;
  }
  if (!css) throw new Error('Could not extract Quicksand font URLs from Google Fonts API');
  return css;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  log('\n🔨  Level One Markdown Maker — build\n');

  // 1. Install npm deps
  if (!fs.existsSync(path.join(NM, 'pdfjs-dist'))) {
    log('📦  Installing npm dependencies…');
    execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
  } else {
    log('📦  npm deps already installed.');
  }

  // 2. Locate library files
  log('\n📚  Locating library files…');

  const pdfMainJs   = fs.readFileSync(nmFile('pdfjs-dist',
    'legacy/build/pdf.min.js',
    'build/pdf.min.js',
    'build/pdf.mjs'
  ), 'utf8');

  const pdfWorkerJs = fs.readFileSync(nmFile('pdfjs-dist',
    'legacy/build/pdf.worker.min.js',
    'build/pdf.worker.min.js',
    'build/pdf.worker.mjs'
  ), 'utf8');

  const tessMainJs  = fs.readFileSync(nmFile('tesseract.js',
    'dist/tesseract.min.js',
    'dist/tesseract.esm.min.js'
  ), 'utf8');

  const tessWorkerJs = fs.readFileSync(nmFile('tesseract.js',
    'dist/worker.min.js'
  ), 'utf8');

  const markedJs = fs.readFileSync(nmFile('marked',
    'marked.min.js',
    'src/marked.min.js',
    'lib/marked.esm.js'
  ), 'utf8');

  log('  pdf.js, tesseract.js, marked — found');

  // 3. Find Tesseract core
  log('\n🧠  Locating Tesseract WASM core…');
  const { jsPath: coreJsPath, wasmPath } = findTesseractCore();
  const coreJsSrc = fs.readFileSync(coreJsPath, 'utf8');
  const wasmBuf   = fs.readFileSync(wasmPath);
  log(`  WASM size: ${(wasmBuf.length / 1024 / 1024).toFixed(1)} MB`);

  // 4. Download language data
  log('\n🌐  Downloading language data…');
  const langPath = path.join(DEPS, 'eng.traineddata');
  await download(
    'https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata',
    langPath
  );
  const langBuf = fs.readFileSync(langPath);
  log(`  Language data size: ${(langBuf.length / 1024 / 1024).toFixed(1)} MB`);

  // 5. Download Quicksand font
  log('\n🔤  Downloading Quicksand font…');
  const fontCss = await downloadQuicksand();

  // 6. Download Ko-fi cup image
  log('\n☕  Downloading Ko-fi cup…');
  const kofiPath = path.join(DEPS, 'kofi-cup.png');
  await download('https://storage.ko-fi.com/cdn/cup-border.png', kofiPath);
  const kofiCupB64 = toB64(fs.readFileSync(kofiPath));

  // 7. Build Tesseract worker blob (with inline WASM + lang data + fetch patch)
  log('\n🔧  Patching Tesseract worker for offline use…');
  const wasmB64 = toB64(wasmBuf);
  const langB64 = toB64(langBuf);
  const tessWorkerBlob = buildTesseractWorkerBlob(tessWorkerJs, coreJsSrc);
  log('  Worker patched.');

  // 8. Read source files
  log('\n📝  Reading source files…');
  const stylesCss     = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');
  const appJs         = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  const processorJs   = fs.readFileSync(path.join(SRC, 'pdfProcessor.js'), 'utf8');
  const converterJs   = fs.readFileSync(path.join(SRC, 'markdownConverter.js'), 'utf8');
  const htmlConvJs    = fs.readFileSync(path.join(SRC, 'htmlConverter.js'), 'utf8');
  let   template      = fs.readFileSync(path.join(SRC, 'template.html'), 'utf8');

  // 9. Assemble HTML
  log('\n🏗️   Assembling HTML…');

  // Self-inject: WASM/lang base64 prepended into the worker blob so it runs first.
  // Uses jsStr so the inner JSON string literals don't clash with the outer JS.
  // (base64 chars are A-Za-z0-9+/= so no </script risk, but we use jsStr to be consistent)
  const selfInject = `self.__WASM_B64__=${jsStr(wasmB64)};\nself.__LANG_B64__=${jsStr(langB64)};\n`;
  const finalWorkerSrc = selfInject + tessWorkerBlob;

  // Asset script: all large strings use jsStr() to prevent </script> from terminating the block.
  const assetScript = `<script>
window.__TESS_WORKER_SRC__  = ${jsStr(finalWorkerSrc)};
window.__PDFJS_WORKER_SRC__ = ${jsStr(pdfWorkerJs)};
window.__KOFI_CUP_B64__     = ${jsStr(kofiCupB64)};
</script>`;

  template = template
    .replace('/* INJECT:FONTS */',   fontCss)
    .replace('/* INJECT:STYLES */',  stylesCss)
    // safeInlineJs() escapes any </ inside directly-injected JS source
    .replace('<!-- INJECT:PDFJS -->',  `<script>\n${safeInlineJs(pdfMainJs)}\n</script>`)
    .replace('<!-- INJECT:MARKED -->', `<script>\n${safeInlineJs(markedJs)}\n</script>`)
    .replace('<!-- INJECT:ASSETS -->', assetScript)
    .replace('<!-- INJECT:TESS_MAIN -->', `<script>\n${safeInlineJs(tessMainJs)}\n</script>`)
    .replace('<!-- INJECT:HTML_CONVERTER -->',     `<script>\n${safeInlineJs(htmlConvJs)}\n</script>`)
    .replace('<!-- INJECT:MARKDOWN_CONVERTER -->', `<script>\n${safeInlineJs(converterJs)}\n</script>`)
    .replace('<!-- INJECT:PDF_PROCESSOR -->',      `<script>\n${safeInlineJs(processorJs)}\n</script>`)
    .replace('<!-- INJECT:APP -->',                `<script>\n${safeInlineJs(appJs)}\n</script>`);

  // 10a. Standalone single file (open from disk; SW self-disables on file://)
  const outPath = path.join(DIST, 'markdown-maker.html');
  fs.writeFileSync(outPath, template, 'utf8');

  // 10b. Deployable PWA bundle in dist/web/
  log('\n📦  Writing PWA bundle (dist/web/)…');
  const WEB = path.join(DIST, 'web');
  const ICONS_OUT = path.join(WEB, 'icons');
  fs.mkdirSync(ICONS_OUT, { recursive: true });

  // index.html (same assembled HTML)
  fs.writeFileSync(path.join(WEB, 'index.html'), template, 'utf8');

  // sw.js with version stamped into the cache name
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const swSrc = fs.readFileSync(path.join(SRC, 'sw.js'), 'utf8')
    .replace(/__VERSION__/g, pkg.version);
  fs.writeFileSync(path.join(WEB, 'sw.js'), swSrc, 'utf8');

  // manifest
  fs.copyFileSync(path.join(SRC, 'manifest.webmanifest'), path.join(WEB, 'manifest.webmanifest'));

  // icons
  const iconsSrc = path.join(SRC, 'icons');
  if (fs.existsSync(iconsSrc)) {
    for (const f of fs.readdirSync(iconsSrc)) {
      fs.copyFileSync(path.join(iconsSrc, f), path.join(ICONS_OUT, f));
    }
  } else {
    log('  ⚠  src/icons/ not found — PWA icons will be missing.');
  }

  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  log(`\n✅  Built:`);
  log(`    Single file : ${outPath} (${sizeMB} MB)`);
  log(`    PWA bundle  : ${WEB}/  (deploy this folder)`);
  log('\n📌  Single file: open dist/markdown-maker.html — no server needed.');
  log('📌  Hosted PWA:  npx wrangler pages deploy dist/web --project-name markdown-maker\n');
}

main().catch(err => { console.error('\n❌ Build failed:', err.message); process.exit(1); });
