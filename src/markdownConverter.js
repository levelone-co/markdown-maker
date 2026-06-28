// markdownConverter.js — PDF PageItem[] → Markdown string
// PageItem: { str, x, y, fontSize, fontName, pageNum, pageHeight }

(function (root) {
  'use strict';

  const BIN_WIDTH = 30;        // px tolerance for column clustering
  const LINE_Y_TOLERANCE = 3;  // px to group items into the same line
  const HEADING_RATIO = 1.18;  // font size multiple above body = heading candidate
  const PARA_GAP_RATIO = 1.5;  // line-gap / line-height > this = new paragraph

  // Bullet characters that signal a list item
  const BULLET_RE = /^[•·◦■●–—\-\*]\s+/;
  const ORDERED_RE = /^(\d+|[a-z])[.)]\s+/i;
  // Font name patterns for monospace
  const MONO_RE = /mono|courier|code|fixed|consol|inconsolata|source\s*code/i;

  function mode(arr) {
    const freq = {};
    let best = arr[0], bestCount = 0;
    for (const v of arr) {
      const k = Math.round(v * 2) / 2; // bucket to 0.5
      freq[k] = (freq[k] || 0) + 1;
      if (freq[k] > bestCount) { bestCount = freq[k]; best = k; }
    }
    return best;
  }

  // Group items into lines by Y proximity (same page, close Y)
  function groupLines(items) {
    if (!items.length) return [];
    const sorted = [...items].sort((a, b) =>
      a.pageNum !== b.pageNum ? a.pageNum - b.pageNum :
      b.y - a.y !== 0 ? b.y - a.y : a.x - b.x
    );

    const lines = [];
    let current = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const samePage = prev.pageNum === cur.pageNum;
      const closeY = samePage && Math.abs(cur.y - prev.y) <= LINE_Y_TOLERANCE;
      if (closeY) {
        current.push(cur);
      } else {
        lines.push(current);
        current = [cur];
      }
    }
    lines.push(current);

    // Sort items within each line left-to-right
    for (const line of lines) line.sort((a, b) => a.x - b.x);
    return lines;
  }

  // Suppress header/footer lines that repeat on most pages (page numbers, etc.)
  function suppressRepeated(lines, totalPages) {
    if (totalPages < 3) return lines;
    const threshold = Math.max(2, Math.round(totalPages * 0.7));

    // Count each rounded-Y position
    const yPageSets = {};
    for (const line of lines) {
      const key = `${Math.round(line[0].y / 5) * 5}`;
      if (!yPageSets[key]) yPageSets[key] = new Set();
      yPageSets[key].add(line[0].pageNum);
    }

    return lines.filter(line => {
      const key = `${Math.round(line[0].y / 5) * 5}`;
      return (yPageSets[key]?.size || 0) < threshold;
    });
  }

  // Detect table regions from a set of lines
  function detectTable(lines) {
    // Need ≥ 3 lines, each with ≥ 2 items
    const candidates = lines.filter(l => l.length >= 2);
    if (candidates.length < 2) return null;

    // Collect all X positions
    const allX = candidates.flatMap(l => l.map(i => Math.round(i.x / BIN_WIDTH) * BIN_WIDTH));
    const freq = {};
    for (const x of allX) freq[x] = (freq[x] || 0) + 1;

    const minCount = Math.max(2, Math.round(candidates.length * 0.4));
    const columns = Object.entries(freq)
      .filter(([, c]) => c >= minCount)
      .map(([x]) => parseInt(x))
      .sort((a, b) => a - b);

    if (columns.length < 2) return null;

    // Build rows: assign each item to nearest column
    const rows = candidates.map(line => {
      const row = Array(columns.length).fill('');
      for (const item of line) {
        const colIdx = columns.reduce((best, col, i) =>
          Math.abs(item.x - col) < Math.abs(item.x - columns[best]) ? i : best, 0);
        row[colIdx] = (row[colIdx] ? row[colIdx] + ' ' : '') + item.str.trim();
      }
      return row;
    });

    // Build Markdown table
    const header = rows[0];
    const sep = header.map(h => '---');
    const body = rows.slice(1);
    const mdRows = [header, sep, ...body].map(r => '| ' + r.join(' | ') + ' |');
    return mdRows.join('\n');
  }

  // Convert a single logical line (array of items) to Markdown
  function lineToText(line) {
    return line.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
  }

  function convertToMarkdown(items, totalPages) {
    if (!items.length) return '';

    // Analyse font sizes for heading detection
    const fontSizes = items.map(i => i.fontSize).filter(s => s > 0);
    const bodySize = mode(fontSizes);
    const distinctSizes = [...new Set(fontSizes.map(s => Math.round(s * 2) / 2))]
      .filter(s => s > bodySize * HEADING_RATIO)
      .sort((a, b) => b - a);

    const h1Size = distinctSizes[0] || null;
    const h2Size = distinctSizes[1] || null;
    const h3Size = distinctSizes[2] || null;

    const lines = suppressRepeated(groupLines(items), totalPages);
    const output = [];
    let i = 0;
    let prevLineType = null;
    let prevY = null;
    let prevPageNum = null;

    while (i < lines.length) {
      const line = lines[i];
      const firstItem = line[0];
      const text = lineToText(line);
      if (!text) { i++; continue; }

      const avgFontSize = line.reduce((s, it) => s + it.fontSize, 0) / line.length;
      const isMono = line.some(it => MONO_RE.test(it.fontName));

      // --- Heading detection ---
      if (h1Size && avgFontSize >= h1Size - 0.5) {
        if (prevLineType !== 'h1') output.push('');
        output.push('# ' + text);
        prevLineType = 'h1';
        i++; continue;
      }
      if (h2Size && avgFontSize >= h2Size - 0.5) {
        if (prevLineType !== 'h2') output.push('');
        output.push('## ' + text);
        prevLineType = 'h2';
        i++; continue;
      }
      if (h3Size && avgFontSize >= h3Size - 0.5) {
        if (prevLineType !== 'h3') output.push('');
        output.push('### ' + text);
        prevLineType = 'h3';
        i++; continue;
      }

      // --- Code block detection ---
      if (isMono) {
        // Collect consecutive mono lines
        const codeLines = [];
        while (i < lines.length && lines[i].some(it => MONO_RE.test(it.fontName))) {
          codeLines.push(lineToText(lines[i]));
          i++;
        }
        output.push('');
        output.push('```');
        output.push(codeLines.join('\n'));
        output.push('```');
        prevLineType = 'code';
        continue;
      }

      // --- Table detection (look-ahead window of up to 10 lines) ---
      if (line.length >= 2) {
        const windowEnd = Math.min(i + 12, lines.length);
        const window = lines.slice(i, windowEnd);
        const tableLines = [];
        let j = 0;
        while (j < window.length && window[j].length >= 2) {
          tableLines.push(window[j]);
          j++;
        }
        if (j >= 2) {
          const table = detectTable(tableLines);
          if (table) {
            output.push('');
            output.push(table);
            i += j;
            prevLineType = 'table';
            continue;
          }
        }
      }

      // --- List detection ---
      if (BULLET_RE.test(text)) {
        if (prevLineType !== 'list') output.push('');
        output.push('- ' + text.replace(BULLET_RE, ''));
        prevLineType = 'list';
        i++; continue;
      }
      if (ORDERED_RE.test(text)) {
        if (prevLineType !== 'list') output.push('');
        const match = text.match(ORDERED_RE);
        output.push('1. ' + text.slice(match[0].length));
        prevLineType = 'list';
        i++; continue;
      }

      // --- Paragraph text ---
      // Determine if this continues the previous paragraph or starts a new one
      let newParagraph = false;
      if (prevLineType !== 'para') {
        newParagraph = true;
      } else if (firstItem.pageNum !== prevPageNum) {
        newParagraph = true;
      } else if (prevY !== null) {
        const lineHeight = avgFontSize || bodySize;
        const gap = prevY - firstItem.y; // prevY is higher on page (larger PDF Y)
        if (gap > lineHeight * PARA_GAP_RATIO) newParagraph = true;
      }

      if (newParagraph) {
        output.push('');
        output.push(text);
      } else {
        // Append to last paragraph line
        const last = output[output.length - 1];
        // If last ends with a hyphen → join directly (word wrap), else space
        if (last && last.endsWith('-')) {
          output[output.length - 1] = last.slice(0, -1) + text;
        } else {
          output[output.length - 1] = last + ' ' + text;
        }
      }

      prevY = firstItem.y;
      prevPageNum = firstItem.pageNum;
      prevLineType = 'para';
      i++;
    }

    return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  root.MarkdownConverter = { convertToMarkdown };
})(window);
