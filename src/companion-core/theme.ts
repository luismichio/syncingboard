/**
 * Companion Core - Theme Handling & CSS Class Synchronization
 */

/**
 * Resolves the effective light or dark theme mode based on theme setting and system preference.
 */
export function resolveEffectiveTheme(
  theme: string,
  isSystemDark: boolean = true
): 'light' | 'dark' {
  if (theme === 'light') return 'light';
  if (theme === 'dark') return 'dark';
  if (theme === 'os') {
    return isSystemDark ? 'dark' : 'light';
  }
  return 'dark';
}

/**
 * Applies the theme CSS class (theme-light or dark default) to the document body.
 */
export function applyTheme(theme: string, doc?: Document): 'light' | 'dark' {
  const targetDoc = doc || (typeof document !== 'undefined' ? document : null);
  if (!targetDoc || !targetDoc.body) {
    return 'dark';
  }

  let isSystemDark = true;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      isSystemDark = true;
    }
  }

  const effective = resolveEffectiveTheme(theme, isSystemDark);

  if (effective === 'light') {
    targetDoc.body.classList.add('theme-light');
  } else {
    targetDoc.body.classList.remove('theme-light');
  }

  return effective;
}
