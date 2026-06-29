# Markdown Maker

Offline, installable PWA that converts PDF, image, HTML and URLs to clean Markdown — cheaper AI context. Private, air-gapped, no runtime network calls.

**Build:** `cd "/Users/in/Code Projects/markdown-maker" && node build.js` → `dist/markdown-maker.html` (standalone) + `dist/web/` (PWA bundle).
**Deploy:** `cd "/Users/in/Code Projects/markdown-maker" && npx wrangler pages deploy dist/web --project-name markdown-maker` (Cloudflare Pages, free). Future custom domain: `markdown-maker.levelone.co.za`.
