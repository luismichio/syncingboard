/**
 * Multi-target Markdown dialect compiler for SyncingBoard Docs-as-Code Text Sync.
 * - compileToMiroHtml: strict, XSS-safe Miro Web SDK v2 HTML subset (<p>, <strong>, <em>, <ul>, <ol>, <li>, <a>, <br>).
 * - compileToCharacterRanges: stripped plain text + StyledTextRange[] for Penpot & FigJam.
 */

export interface StyledTextRange {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  headingLevel?: 1 | 2 | 3;
  href?: string;
}

export interface CompiledCharacterRanges {
  plainText: string;
  ranges: StyledTextRange[];
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isSafeHref(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Formats inline Markdown (links, bold, italic, inline code) into safe Miro HTML.
 * Input is HTML-escaped BEFORE applying Markdown inline rules so raw HTML tags cannot inject XSS.
 */
function formatInlineMiroHtml(rawLine: string): string {
  let text = escapeHtml(rawLine);

  // Links: [label](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    const cleanUrl = url.replace(/&amp;/g, '&').trim();
    if (!isSafeHref(cleanUrl)) return label;
    return `<a href="${escapeHtml(cleanUrl)}">${label}</a>`;
  });

  // Inline code: `code`
  text = text.replace(/`([^`]+)`/g, '<strong>$1</strong>');

  // Bold: **text** or __text__
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // Italic: *text* or _text_
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  text = text.replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>');

  return text;
}

/**
 * Compiles Markdown into Miro's supported safe HTML subset.
 * Gracefully degrades fenced code blocks and tables to clean readable paragraphs.
 */
export function compileToMiroHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];

  let inUl = false;
  let inOl = false;
  let inFence = false;
  let fenceLines: string[] = [];

  const closeLists = () => {
    if (inUl) {
      out.push('</ul>');
      inUl = false;
    }
    if (inOl) {
      out.push('</ol>');
      inOl = false;
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      if (inFence) {
        inFence = false;
        if (fenceLines.length > 0) {
          out.push(`<p>${fenceLines.map(escapeHtml).join('<br/>')}</p>`);
          fenceLines = [];
        }
      } else {
        closeLists();
        inFence = true;
        fenceLines = [];
      }
      continue;
    }

    if (inFence) {
      fenceLines.push(rawLine);
      continue;
    }

    if (trimmed === '' || /^[-*_]{3,}$/.test(trimmed)) {
      closeLists();
      continue;
    }

    // Headings (#, ##, ###)
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+?)\s*#*$/);
    if (headingMatch) {
      closeLists();
      out.push(`<p><strong>${formatInlineMiroHtml(headingMatch[2])}</strong></p>`);
      continue;
    }

    // Unordered list (- or *)
    const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      if (inOl) {
        out.push('</ol>');
        inOl = false;
      }
      if (!inUl) {
        out.push('<ul>');
        inUl = true;
      }
      out.push(`<li>${formatInlineMiroHtml(ulMatch[1])}</li>`);
      continue;
    }

    // Ordered list (1. )
    const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      if (inUl) {
        out.push('</ul>');
        inUl = false;
      }
      if (!inOl) {
        out.push('<ol>');
        inOl = true;
      }
      out.push(`<li>${formatInlineMiroHtml(olMatch[1])}</li>`);
      continue;
    }

    // Blockquote (> )
    const bqMatch = trimmed.match(/^>\s?(.*)$/);
    if (bqMatch) {
      closeLists();
      out.push(`<p><em>${formatInlineMiroHtml(bqMatch[1])}</em></p>`);
      continue;
    }

    closeLists();
    out.push(`<p>${formatInlineMiroHtml(trimmed)}</p>`);
  }

  if (inFence && fenceLines.length > 0) {
    out.push(`<p>${fenceLines.map(escapeHtml).join('<br/>')}</p>`);
  }
  closeLists();

  return out.join('') || '<p> </p>';
}

/**
 * Compiles Markdown into stripped plain text + character-offset style ranges
 * for Penpot (`shape.getRange`) and FigJam (`TextNode` range setters).
 */
export function compileToCharacterRanges(markdown: string): CompiledCharacterRanges {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const ranges: StyledTextRange[] = [];
  let plainText = '';
  let inFence = false;

  const appendStyledLine = (raw: string, headingLevel?: 1 | 2 | 3) => {
    if (plainText.length > 0) plainText += '\n';
    const lineStart = plainText.length;

    // Tokenize inline bold (**x**), italic (*x*), code (`x`), links ([t](u))
    const tokenRe = /(\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*)/g;
    let lastIdx = 0;
    let match: RegExpExecArray | null;

    while ((match = tokenRe.exec(raw)) !== null) {
      if (match.index > lastIdx) {
        plainText += raw.slice(lastIdx, match.index);
      }
      const start = plainText.length;
      if (match[2] !== undefined && match[3] !== undefined) {
        plainText += match[2];
        if (isSafeHref(match[3])) {
          ranges.push({ start, end: plainText.length, href: match[3].trim() });
        }
      } else if (match[4] !== undefined) {
        plainText += match[4];
        ranges.push({ start, end: plainText.length, bold: true });
      } else if (match[5] !== undefined) {
        plainText += match[5];
        ranges.push({ start, end: plainText.length, code: true });
      } else if (match[6] !== undefined) {
        plainText += match[6];
        ranges.push({ start, end: plainText.length, italic: true });
      }
      lastIdx = tokenRe.lastIndex;
    }

    if (lastIdx < raw.length) {
      plainText += raw.slice(lastIdx);
    }

    if (headingLevel && plainText.length > lineStart) {
      ranges.push({ start: lineStart, end: plainText.length, bold: true, headingLevel });
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (plainText.length > 0) plainText += '\n';
      const start = plainText.length;
      plainText += rawLine;
      if (plainText.length > start) {
        ranges.push({ start, end: plainText.length, code: true });
      }
      continue;
    }
    if (trimmed === '') {
      if (plainText.length > 0 && !plainText.endsWith('\n\n')) plainText += '\n';
      continue;
    }
    const hm = trimmed.match(/^(#{1,3})\s+(.+?)\s*#*$/);
    if (hm) {
      appendStyledLine(hm[2], hm[1].length as 1 | 2 | 3);
      continue;
    }
    const ul = trimmed.match(/^[-*+]\s+(.+)$/);
    if (ul) {
      appendStyledLine(`• ${ul[1]}`);
      continue;
    }
    appendStyledLine(trimmed);
  }

  return { plainText: plainText.trim(), ranges };
}
