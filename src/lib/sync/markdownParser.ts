/**
 * Deterministic Markdown section parser & strict GitHub URL parser
 * for SyncingBoard Docs-as-Code Text Sync.
 */

export interface ParsedGitHubMarkdownUrl {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  /** Optional heading slug or anchor id (e.g. "architecture") */
  sectionId: string | null;
  /** Optional 1-indexed inclusive line range (e.g. #L10-L45) */
  lineRange: { start: number; end: number } | null;
  canonicalUrl: string;
}

export interface MarkdownSection {
  id: string;
  title: string;
  level: number;
  markdown: string;
  startLine: number;
  endLine: number;
}

const SEGMENT_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const LINE_RANGE_RE = /^L(\d+)(?:-L?(\d+))?$/i;
const SYNC_ANCHOR_RE = /^<!--\s*sync:id=["']([A-Za-z0-9_-]{1,80})["']\s*-->$/;
const ATX_HEADING_RE = /^(#{1,3})\s+(.+?)\s*#*$/;

/**
 * Normalizes a Markdown heading title into a deterministic GitHub-style slug.
 */
export function slugifyHeading(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * Strictly parses and validates a GitHub Markdown file URL (SSRF-safe).
 * Allows ONLY https://github.com/{owner}/{repo}/blob/{branch}/{path}
 * and https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}.
 */
export function parseGitHubMarkdownUrl(rawUrl: string): ParsedGitHubMarkdownUrl | null {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;

  const host = parsed.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'raw.githubusercontent.com') {
    return null;
  }

  const rawParts = parsed.pathname.split('/').filter(Boolean);
  let owner = '';
  let repo = '';
  let branch = '';
  let pathParts: string[] = [];

  if (host === 'github.com') {
    // /owner/repo/blob/branch/path/to/file.md
    if (rawParts.length < 5 || rawParts[2] !== 'blob') return null;
    owner = rawParts[0];
    repo = rawParts[1];
    branch = rawParts[3];
    pathParts = rawParts.slice(4);
  } else {
    // raw.githubusercontent.com/owner/repo/branch/path/to/file.md
    if (rawParts.length < 4) return null;
    owner = rawParts[0];
    repo = rawParts[1];
    branch = rawParts[2];
    pathParts = rawParts.slice(3);
  }

  if (!SEGMENT_RE.test(owner) || !SEGMENT_RE.test(repo) || !branch || branch.includes('..')) {
    return null;
  }

  const decodedParts: string[] = [];
  for (const part of pathParts) {
    let dec: string;
    try {
      dec = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (!dec || dec === '.' || dec === '..' || dec.includes('\\') || dec.includes('\0')) {
      return null;
    }
    decodedParts.push(dec);
  }

  const filePath = decodedParts.join('/');
  if (!filePath || filePath.length > 512) return null;

  let sectionId: string | null = null;
  let lineRange: { start: number; end: number } | null = null;

  const hash = parsed.hash.replace(/^#/, '').trim();
  if (hash) {
    const lr = hash.match(LINE_RANGE_RE);
    if (lr) {
      const start = Math.max(1, Number(lr[1]));
      const end = lr[2] ? Math.max(start, Number(lr[2])) : start;
      lineRange = { start, end };
    } else {
      sectionId = slugifyHeading(decodeURIComponent(hash));
    }
  }

  const canonicalUrl = `https://github.com/${owner}/${repo}/blob/${branch}/${filePath}`;
  return {
    owner,
    repo,
    branch,
    path: filePath,
    sectionId,
    lineRange,
    canonicalUrl,
  };
}

/**
 * Extracts a 1-indexed inclusive line range from a Markdown document.
 */
export function extractLineRange(markdown: string, startLine: number, endLine: number): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const startIdx = Math.max(0, startLine - 1);
  const endIdx = Math.min(lines.length, Math.max(startLine, endLine));
  return lines.slice(startIdx, endIdx).join('\n').trim();
}

/**
 * Splits a Markdown document into deterministic sections using:
 * 1. Explicit `<!-- sync:id="my-id" -->` comments (takes priority as the ID for the next section).
 * 2. ATX headings (`#`, `##`, `###`).
 * Strips YAML frontmatter (`--- ... ---`) at the top of the file.
 */
export function parseMarkdownSections(rawMarkdown: string): MarkdownSection[] {
  const normalized = rawMarkdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  // Skip leading YAML frontmatter if present
  let startOffset = 0;
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        startOffset = i + 1;
        break;
      }
    }
  }

  const sections: MarkdownSection[] = [];
  const usedIds = new Map<string, number>();

  const uniqueId = (base: string): string => {
    const clean = base || 'section';
    const count = usedIds.get(clean) || 0;
    usedIds.set(clean, count + 1);
    return count === 0 ? clean : `${clean}-${count}`;
  };

  let pendingAnchorId: string | null = null;
  let current: { id: string; title: string; level: number; startLine: number; lines: string[] } | null = null;
  let inFence = false;

  const flushCurrent = (endLine: number) => {
    if (!current) return;
    const body = current.lines.join('\n').trim();
    sections.push({
      id: current.id,
      title: current.title,
      level: current.level,
      markdown: body,
      startLine: current.startLine,
      endLine,
    });
    current = null;
  };

  for (let i = startOffset; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      inFence = !inFence;
      if (current) current.lines.push(line);
      continue;
    }

    if (!inFence) {
      const anchorMatch = trimmed.match(SYNC_ANCHOR_RE);
      if (anchorMatch) {
        pendingAnchorId = anchorMatch[1];
        continue;
      }

      const headingMatch = trimmed.match(ATX_HEADING_RE);
      if (headingMatch) {
        flushCurrent(i);
        const level = headingMatch[1].length;
        const title = headingMatch[2].trim();
        const id = uniqueId(pendingAnchorId || slugifyHeading(title));
        pendingAnchorId = null;
        current = {
          id,
          title,
          level,
          startLine: i + 1,
          lines: [line],
        };
        continue;
      }
    }

    if (!current && trimmed !== '') {
      const id = uniqueId(pendingAnchorId || 'intro');
      pendingAnchorId = null;
      current = {
        id,
        title: 'Introduction',
        level: 1,
        startLine: i + 1,
        lines: [line],
      };
    } else if (current) {
      current.lines.push(line);
    }
  }

  flushCurrent(lines.length);
  return sections;
}

/**
 * Computes a short SHA-256 hex digest (16 chars) for change detection.
 */
export async function computeContentHash(text: string): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest === 'function') {
    const data = new TextEncoder().encode(text);
    const buf = await globalThis.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16);
  }
  // Deterministic fallback if SubtleCrypto is unavailable
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
