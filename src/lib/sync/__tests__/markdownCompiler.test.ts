import { describe, it, expect } from 'vitest';
import { compileToCharacterRanges, compileToMiroHtml } from '../markdownCompiler';

describe('markdownCompiler', () => {
  describe('compileToMiroHtml', () => {
    it('compiles headings, lists, bold, italic, and safe links', () => {
      const md = [
        '## Release Notes',
        'See **SyncingBoard** *v0.18* at [docs](https://syncingboard.com/docs).',
        '- Item 1',
        '- Item 2',
      ].join('\n');

      const html = compileToMiroHtml(md);
      expect(html).toContain('<p><strong>Release Notes</strong></p>');
      expect(html).toContain('<strong>SyncingBoard</strong>');
      expect(html).toContain('<em>v0.18</em>');
      expect(html).toContain('<a href="https://syncingboard.com/docs">docs</a>');
      expect(html).toContain('<ul><li>Item 1</li><li>Item 2</li></ul>');
    });

    it('escapes raw HTML tags and strips unsafe javascript: links (XSS guard)', () => {
      const md = '<script>alert(1)</script> [click](javascript:alert(2))';
      const html = compileToMiroHtml(md);
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('javascript:');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).toContain('click');
    });
  });

  describe('compileToCharacterRanges', () => {
    it('extracts stripped plain text and accurate bold/code/heading ranges', () => {
      const md = '# Title\nUse **bold** and `code`';
      const { plainText, ranges } = compileToCharacterRanges(md);
      expect(plainText).toBe('Title\nUse bold and code');

      const heading = ranges.find((r) => r.headingLevel === 1);
      expect(heading).toEqual({ start: 0, end: 5, bold: true, headingLevel: 1 });

      const bold = ranges.find((r) => r.bold && !r.headingLevel);
      expect(plainText.slice(bold!.start, bold!.end)).toBe('bold');

      const code = ranges.find((r) => r.code);
      expect(plainText.slice(code!.start, code!.end)).toBe('code');
    });
  });
});
