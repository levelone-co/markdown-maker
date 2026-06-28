// htmlConverter.js — converts an HTML file directly to a Markdown string
// Exposes: window.HtmlConverter = { convertHtml }
// No external dependencies — uses the browser's built-in DOMParser.

(function (root) {
  'use strict';

  const BLOCK_SKIP = ['script', 'style', 'nav', 'aside', 'noscript', 'iframe',
                      'form', 'template', 'svg', 'canvas'];

  function convertHtml(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const doc = new DOMParser().parseFromString(e.target.result, 'text/html');
          BLOCK_SKIP.forEach(tag => doc.querySelectorAll(tag).forEach(el => el.remove()));
          const md = blockToMd(doc.body || doc.documentElement);
          resolve(md.replace(/\n{3,}/g, '\n\n').trim());
        } catch (err) { reject(err); }
      };
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsText(file);
    });
  }

  function blockToMd(el) {
    const parts = [];
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.textContent.trim();
        if (t) parts.push(t);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const md = elementToMd(child);
      if (md != null && md !== '') parts.push(md);
    }
    return parts.join('\n\n');
  }

  function elementToMd(el) {
    const tag = el.tagName.toUpperCase();
    switch (tag) {
      case 'H1': return `# ${inline(el)}`;
      case 'H2': return `## ${inline(el)}`;
      case 'H3': return `### ${inline(el)}`;
      case 'H4': return `#### ${inline(el)}`;
      case 'H5': return `##### ${inline(el)}`;
      case 'H6': return `###### ${inline(el)}`;
      case 'P':  { const t = inline(el); return t || null; }
      case 'HR': return '---';
      case 'BR': return '';
      case 'PRE': return '```\n' + el.textContent + '\n```';
      case 'BLOCKQUOTE':
        return blockToMd(el).split('\n').map(l => '> ' + l).join('\n');
      case 'UL': return listToMd(el, false, 0);
      case 'OL': return listToMd(el, true, 0);
      case 'TABLE': return tableToMd(el);
      case 'LI': return null; // handled by listToMd
      case 'DIV':
      case 'SECTION':
      case 'ARTICLE':
      case 'MAIN':
      case 'HEADER':
      case 'FOOTER':
      case 'FIGURE':
      case 'FIGCAPTION':
      case 'DETAILS':
      case 'SUMMARY':
      case 'BODY': {
        const inner = blockToMd(el);
        return inner || null;
      }
      default: {
        const t = inline(el);
        return t || null;
      }
    }
  }

  function listToMd(el, ordered, depth) {
    const indent = '  '.repeat(depth);
    const lines = [];
    let i = 1;
    for (const child of el.children) {
      if (child.tagName.toUpperCase() !== 'LI') continue;
      const prefix = ordered ? `${i++}. ` : '- ';
      let text = '';
      let nested = '';
      for (const c of child.childNodes) {
        if (c.nodeType === Node.ELEMENT_NODE) {
          const t = c.tagName.toUpperCase();
          if (t === 'UL') { nested += '\n' + listToMd(c, false, depth + 1); continue; }
          if (t === 'OL') { nested += '\n' + listToMd(c, true,  depth + 1); continue; }
        }
        text += nodeInline(c);
      }
      lines.push(indent + prefix + text.trim() + nested);
    }
    return lines.join('\n');
  }

  function tableToMd(el) {
    const rows = [];
    el.querySelectorAll('tr').forEach(tr => {
      const cells = [];
      tr.querySelectorAll('th, td').forEach(td => cells.push(inline(td).replace(/\|/g, '\\|')));
      if (cells.length) rows.push(cells);
    });
    if (!rows.length) return '';
    const colCount = Math.max(...rows.map(r => r.length));
    const pad = r => { while (r.length < colCount) r.push(''); return r; };
    const header = '| ' + pad(rows[0]).join(' | ') + ' |';
    const sep    = '| ' + rows[0].map(() => '---').join(' | ') + ' |';
    const body   = rows.slice(1).map(r => '| ' + pad(r).join(' | ') + ' |').join('\n');
    return [header, sep, body].filter(Boolean).join('\n');
  }

  function inline(el) {
    let out = '';
    for (const child of el.childNodes) out += nodeInline(child);
    return out.replace(/\s+/g, ' ').trim();
  }

  function nodeInline(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent.replace(/\s+/g, ' ');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toUpperCase();
    const inner = inline(node);
    switch (tag) {
      case 'STRONG': case 'B':  return inner ? `**${inner}**` : '';
      case 'EM':     case 'I':  return inner ? `*${inner}*`   : '';
      case 'CODE':              return inner ? `\`${inner}\`` : '';
      case 'DEL':    case 'S':  return inner ? `~~${inner}~~` : '';
      case 'A': {
        const href = node.getAttribute('href') || '';
        return href && !href.startsWith('#') ? `[${inner}](${href})` : inner;
      }
      case 'IMG': {
        const alt = node.getAttribute('alt') || '';
        const src = node.getAttribute('src') || '';
        return src && !src.startsWith('data:') ? `![${alt}](${src})` : alt;
      }
      case 'BR': return '\n';
      default:   return inner;
    }
  }

  root.HtmlConverter = { convertHtml };
})(window);
