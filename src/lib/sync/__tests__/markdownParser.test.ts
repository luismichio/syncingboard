import { describe, it, expect } from 'vitest';
import {
  computeContentHash,
  extractLineRange,
  parseGitHubMarkdownUrl,
  parseMarkdownSections,
  slugifyHeading,
} from '../markdownParser';

describe('markdownParser', () => {
  describe('parseGitHubMarkdownUrl', () => {
    it('parses standard github.com blob URLs with heading hash', () => {
      const parsed = parseGitHubMarkdownUrl(
        'https://github.com/luismichio/syncingboard/blob/main/doc/features.md#syncingbridge'
      );
      expect(parsed).toEqual({
        owner: 'luismichio',
        repo: 'syncingboard',
        branch: 'main',
        path: 'doc/features.md',
        sectionId: 'syncingbridge',
        lineRange: null,
        canonicalUrl: 'https://github.com/luismichio/syncingboard/blob/main/doc/features.md',
      });
    });

    it('parses line range fragments (#L10-L25)', () => {
      const parsed = parseGitHubMarkdownUrl(
        'https://github.com/org/repo/blob/dev/README.md#L10-L25'
      );
      expect(parsed?.lineRange).toEqual({ start: 10, end: 25 });
      expect(parsed?.sectionId).toBeNull();
    });

    it('parses raw.githubusercontent.com URLs', () => {
      const parsed = parseGitHubMarkdownUrl(
        'https://raw.githubusercontent.com/org/repo/main/docs/guide.md'
      );
      expect(parsed?.owner).toBe('org');
      expect(parsed?.path).toBe('docs/guide.md');
    });

    it('rejects non-GitHub hosts, http, userinfo, and path traversal (SSRF protection)', () => {
      expect(parseGitHubMarkdownUrl('http://github.com/org/repo/blob/main/a.md')).toBeNull();
      expect(parseGitHubMarkdownUrl('https://evil.com/org/repo/blob/main/a.md')).toBeNull();
      expect(parseGitHubMarkdownUrl('https://127.0.0.1/org/repo/blob/main/a.md')).toBeNull();
      expect(parseGitHubMarkdownUrl('https://github.com@evil.com/org/repo/blob/main/a.md')).toBeNull();
      expect(parseGitHubMarkdownUrl('https://github.com/org/repo/blob/main/../../etc/passwd')).toBeNull();
    });
  });

  describe('parseMarkdownSections', () => {
    it('strips YAML frontmatter and splits by headings and explicit sync:id anchors', () => {
      const md = [
        '---',
        'title: Spec',
        '---',
        '# Overview',
        'Hello world.',
        '',
        '<!-- sync:id="custom-anchor" -->',
        '## Architecture Details',
        'Line A',
        '```md',
        '# Not a heading inside fence',
        '```',
      ].join('\n');

      const sections = parseMarkdownSections(md);
      expect(sections).toHaveLength(2);
      expect(sections[0].id).toBe('overview');
      expect(sections[0].markdown).toContain('Hello world.');
      expect(sections[1].id).toBe('custom-anchor');
      expect(sections[1].markdown).toContain('# Not a heading inside fence');
    });

    it('extracts 1-indexed inclusive line ranges', () => {
      const md = 'L1\nL2\nL3\nL4\nL5';
      expect(extractLineRange(md, 2, 4)).toBe('L2\nL3\nL4');
    });

    it('slugifies headings and produces deterministic hashes', async () => {
      expect(slugifyHeading('SyncingBridge (Local Mode)!')).toBe('syncingbridge-local-mode');
      const h1 = await computeContentHash('hello');
      const h2 = await computeContentHash('hello');
      expect(h1).toBe(h2);
      expect(h1.length).toBeGreaterThanOrEqual(8);
    });
  });
});
