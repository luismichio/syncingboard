import { describe, it, expect } from 'vitest';
import { resolveEffectiveTheme, applyTheme } from '../theme';

describe('Companion Theme Synchronization', () => {
  describe('resolveEffectiveTheme', () => {
    it('resolves explicit light and dark themes', () => {
      expect(resolveEffectiveTheme('light', true)).toBe('light');
      expect(resolveEffectiveTheme('light', false)).toBe('light');
      expect(resolveEffectiveTheme('dark', true)).toBe('dark');
      expect(resolveEffectiveTheme('dark', false)).toBe('dark');
    });

    it('resolves os theme according to system dark mode preference', () => {
      expect(resolveEffectiveTheme('os', true)).toBe('dark');
      expect(resolveEffectiveTheme('os', false)).toBe('light');
    });
  });

  describe('applyTheme', () => {
    it('applies and toggles theme-light class on document body', () => {
      const mockDoc = {
        body: {
          classList: {
            classes: new Set<string>(),
            add(cls: string) {
              this.classes.add(cls);
            },
            remove(cls: string) {
              this.classes.delete(cls);
            },
            contains(cls: string) {
              return this.classes.has(cls);
            },
          },
        },
      } as unknown as Document;

      applyTheme('light', mockDoc);
      expect((mockDoc.body as unknown as { classList: { contains: (c: string) => boolean } }).classList.contains('theme-light')).toBe(true);

      applyTheme('dark', mockDoc);
      expect((mockDoc.body as unknown as { classList: { contains: (c: string) => boolean } }).classList.contains('theme-light')).toBe(false);
    });
  });
});
