# Markdown Maker

Offline, installable PWA that converts PDF, image, HTML and URLs to clean Markdown — cheaper AI context. Private, air-gapped, no runtime network calls.

**Build:** `node build.js` → `dist/markdown-maker.html` (standalone single file) + `dist/web/` (deployable PWA bundle).
**Deploy:** `npx wrangler pages deploy dist/web --project-name markdown-maker` (Cloudflare Pages, free). Future custom domain: `markdown-maker.levelone.co.za`.
