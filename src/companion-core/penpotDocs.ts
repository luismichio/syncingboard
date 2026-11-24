/**
 * Penpot Companion — GitHub Docs-as-Code Text Sync & OAuth UI Controller
 *
 * Powers the Penpot-only DOCS tab and Settings → GitHub Status OAuth card
 * inside the Companion UI so Penpot projects can act as living documentation
 * boards (importing, retargeting, and updating Markdown sections in-place on
 * Penpot Text shapes with range typography styling).
 */

import { compileToCharacterRanges } from '../lib/sync/markdownCompiler';

interface ParsedDocSection {
  id: string;
  title: string;
  level: number;
  markdown: string;
  contentHash: string;
}

interface GitHubDocResponse {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  canonicalUrl: string;
  etag: string | null;
  fullHash: string;
  fullMarkdown: string;
  lineRange: { start: number; end: number } | null;
  lineRangeMarkdown: string | null;
  lineRangeHash: string | null;
  sections: ParsedDocSection[];
}

interface PenpotGitMeta {
  githubUrl: string;
  githubBranch: string;
  sectionId: string;
  sectionHeading: string;
  contentHash: string;
  etag?: string;
}

interface ScannedGitShape {
  id: string;
  name: string;
  meta: PenpotGitMeta | null;
}

interface SelectionPayload {
  id: string;
  name: string;
  shapeType?: string | null;
  gitMeta?: PenpotGitMeta | null;
}

interface PluginReply {
  action?: string;
  requestId?: string;
  data?: unknown;
  error?: string;
}

interface OAuthTokenPayload {
  accessToken?: string;
  access_token?: string;
}

const GITHUB_PAT_KEY = 'syncingboard_github_pat';
const GITHUB_OAUTH_KEY = 'github_access_token';
const PLUGIN_TIMEOUT_MS = 15_000;

function getApiBase(): string {
  if (typeof window === 'undefined') return '';
  if (window.location.origin && window.location.origin.startsWith('http')) {
    return window.location.origin;
  }
  return 'https://www.syncingboard.com';
}

function extractAccessToken(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as OAuthTokenPayload;
  if (typeof obj.accessToken === 'string' && obj.accessToken.trim()) return obj.accessToken.trim();
  if (typeof obj.access_token === 'string' && obj.access_token.trim()) return obj.access_token.trim();
  return null;
}

function resolveSection(
  doc: GitHubDocResponse,
  sectionId: string
): { markdown: string; heading: string; contentHash: string } {
  if (sectionId === '*') {
    return { markdown: doc.fullMarkdown, heading: `${doc.repo}/${doc.path}`, contentHash: doc.fullHash };
  }
  if (
    doc.lineRange &&
    sectionId === `L${doc.lineRange.start}-L${doc.lineRange.end}` &&
    doc.lineRangeMarkdown !== null
  ) {
    return {
      markdown: doc.lineRangeMarkdown,
      heading: `${doc.path} (${sectionId})`,
      contentHash: doc.lineRangeHash || doc.fullHash,
    };
  }
  const match = doc.sections.find((s) => s.id === sectionId);
  if (match) return { markdown: match.markdown, heading: match.title, contentHash: match.contentHash };
  const first = doc.sections[0];
  return first
    ? { markdown: first.markdown, heading: first.title, contentHash: first.contentHash }
    : { markdown: doc.fullMarkdown, heading: doc.path, contentHash: doc.fullHash };
}

export function initPenpotDocs(): void {
  const urlInput = document.getElementById('docs-github-url') as HTMLInputElement | null;
  const patInput = document.getElementById('docs-github-pat') as HTMLInputElement | null;
  const loadBtn = document.getElementById('docs-load-btn') as HTMLButtonElement | null;
  const sectionWrap = document.getElementById('docs-section-wrap') as HTMLElement | null;
  const sectionSelect = document.getElementById('docs-section-select') as HTMLSelectElement | null;
  const placeBtn = document.getElementById('docs-place-btn') as HTMLButtonElement | null;
  const bindBtn = document.getElementById('docs-bind-btn') as HTMLButtonElement | null;
  const syncAllBtn = document.getElementById('docs-sync-all-btn') as HTMLButtonElement | null;
  const statusEl = document.getElementById('docs-status-text') as HTMLElement | null;

  // Selected Bound Doc Card elements
  const selectedCard = document.getElementById('docs-selected-card') as HTMLElement | null;
  const selectedTitleEl = document.getElementById('docs-selected-title') as HTMLElement | null;
  const selectedUrlEl = document.getElementById('docs-selected-url') as HTMLAnchorElement | null;
  const selectedOpenBtn = document.getElementById('docs-selected-open-btn') as HTMLAnchorElement | null;
  const selectedCopyBtn = document.getElementById('docs-selected-copy-btn') as HTMLButtonElement | null;
  const selectedSectionSelect = document.getElementById('docs-selected-section') as HTMLSelectElement | null;
  const syncSelectedBtn = document.getElementById('docs-sync-selected-btn') as HTMLButtonElement | null;

  // Settings → GitHub OAuth elements
  const ghDivider = document.getElementById('github-oauth-divider') as HTMLElement | null;
  const ghRow = document.getElementById('github-oauth-row') as HTMLElement | null;
  const ghDot = document.getElementById('github-dot') as HTMLElement | null;
  const ghStatusText = document.getElementById('github-status-text') as HTMLElement | null;
  const ghConnectBtn = document.getElementById('github-connect-btn') as HTMLButtonElement | null;

  if (!urlInput || !loadBtn || !sectionSelect) return;

  // ---- GitHub OAuth State & UI ----
  const readOAuthToken = (): string | null => {
    try {
      const val = localStorage.getItem(GITHUB_OAUTH_KEY);
      return val && val.trim() ? val.trim() : null;
    } catch {
      return null;
    }
  };

  let oauthToken: string | null = readOAuthToken();
  let oauthPollTimer: ReturnType<typeof setInterval> | null = null;

  const updateGitHubOAuthUI = (): void => {
    if (ghDivider) ghDivider.style.display = '';
    if (ghRow) ghRow.style.display = 'flex';
    const connected = !!oauthToken;
    if (ghDot) {
      ghDot.classList.toggle('connected', connected);
    }
    if (ghStatusText) {
      ghStatusText.textContent = connected
        ? 'Connected (private repos enabled)'
        : 'Not connected (public repos only)';
    }
    if (ghConnectBtn) {
      ghConnectBtn.textContent = connected ? 'DISCONNECT' : 'CONNECT';
    }
    if (patInput) {
      patInput.placeholder = connected
        ? 'Optional PAT override (GitHub OAuth connected)'
        : 'Optional GitHub PAT (or connect in Settings)';
    }
  };

  const applyGitHubOAuthToken = (token: string): void => {
    oauthToken = token;
    try {
      localStorage.setItem(GITHUB_OAUTH_KEY, token);
    } catch {
      // ignore storage errors
    }
    if (oauthPollTimer) {
      clearInterval(oauthPollTimer);
      oauthPollTimer = null;
    }
    updateGitHubOAuthUI();
    setStatus('✓ GitHub connected via OAuth.');
  };

  // Hydrate saved PAT
  if (patInput) {
    try {
      patInput.value = localStorage.getItem(GITHUB_PAT_KEY) || '';
      patInput.addEventListener('change', () => {
        const val = patInput.value.trim();
        if (val) localStorage.setItem(GITHUB_PAT_KEY, val);
        else localStorage.removeItem(GITHUB_PAT_KEY);
      });
    } catch {
      // ignore storage errors
    }
  }

  // Listen for OAuth completion via BroadcastChannel + postMessage
  try {
    const channel = new BroadcastChannel('figma_miro_sync');
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; tokens?: unknown } | null;
      if (data?.type === 'GITHUB_AUTH_SUCCESS') {
        const tok = extractAccessToken(data.tokens);
        if (tok) applyGitHubOAuthToken(tok);
      }
    };
  } catch {
    // BroadcastChannel unavailable in sandbox
  }

  ghConnectBtn?.addEventListener('click', () => {
    if (oauthToken) {
      oauthToken = null;
      try {
        localStorage.removeItem(GITHUB_OAUTH_KEY);
      } catch {
        // ignore
      }
      updateGitHubOAuthUI();
      setStatus('Disconnected GitHub OAuth.');
      return;
    }

    const state = `gh_pp_${Math.random().toString(36).slice(2, 12)}`;
    const authUrl = `${getApiBase()}/api/oauth/github/auth?state=${encodeURIComponent(state)}`;
    const popup = window.open(authUrl, 'Connect GitHub', 'width=600,height=700');

    if (oauthPollTimer) clearInterval(oauthPollTimer);
    let attempts = 0;
    oauthPollTimer = setInterval(async () => {
      attempts += 1;
      if (attempts > 60) {
        if (oauthPollTimer) clearInterval(oauthPollTimer);
        oauthPollTimer = null;
        return;
      }
      try {
        const res = await fetch(`${getApiBase()}/api/oauth/store?state=${encodeURIComponent(state)}`);
        if (!res.ok) return;
        const json = (await res.json().catch(() => ({}))) as { tokens?: unknown };
        const tok = extractAccessToken(json.tokens);
        if (tok) {
          applyGitHubOAuthToken(tok);
          try {
            popup?.close();
          } catch {
            // ignore
          }
        }
      } catch {
        // retry on next tick
      }
    }, 2000);
  });

  // ---- Docs State & Plugin Bridge ----
  let currentDoc: GitHubDocResponse | null = null;
  let selectedBound: { id: string; name: string; meta: PenpotGitMeta } | null = null;
  const sectionsCache = new Map<string, GitHubDocResponse>();

  const pending = new Map<
    string,
    { resolve: (msg: PluginReply) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  const sendPluginRequest = (payload: Record<string, unknown>): Promise<PluginReply> => {
    return new Promise((resolve, reject) => {
      const requestId = `ppdoc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Penpot plugin did not respond in time'));
      }, PLUGIN_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timer });
      window.parent.postMessage({ ...payload, requestId }, '*');
    });
  };

  const setStatus = (msg: string, isError = false): void => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = isError ? '#ef4444' : 'var(--text-muted)';
  };

  const getAuthToken = (): string | null => {
    const pat = patInput?.value.trim() || '';
    if (pat) return pat;
    if (oauthToken) return oauthToken;
    return null;
  };

  const fetchDoc = async (
    url: string,
    etag?: string
  ): Promise<GitHubDocResponse | { unchanged: true }> => {
    const headers: Record<string, string> = {};
    const token = getAuthToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (etag) headers['If-None-Match'] = etag;
    const res = await fetch(`${getApiBase()}/api/github/markdown?url=${encodeURIComponent(url)}`, {
      headers,
    });
    if (res.status === 304) return { unchanged: true };
    const data = (await res.json().catch(() => ({}))) as Partial<GitHubDocResponse> & {
      error?: string;
    };
    if (!res.ok) {
      throw new Error(data.error || `GitHub fetch failed (${res.status})`);
    }
    const doc = data as GitHubDocResponse;
    sectionsCache.set(url, doc);
    return doc;
  };

  const populateSelect = (selectEl: HTMLSelectElement, doc: GitHubDocResponse, currentId?: string): void => {
    selectEl.innerHTML = '';
    if (doc.lineRange && doc.lineRangeMarkdown !== null) {
      const opt = document.createElement('option');
      opt.value = `L${doc.lineRange.start}-L${doc.lineRange.end}`;
      opt.textContent = `Lines L${doc.lineRange.start}–L${doc.lineRange.end}`;
      selectEl.appendChild(opt);
    }
    for (const sec of doc.sections) {
      const opt = document.createElement('option');
      opt.value = sec.id;
      opt.textContent = `${'#'.repeat(Math.min(sec.level, 3))} ${sec.title}`;
      selectEl.appendChild(opt);
    }
    const fullOpt = document.createElement('option');
    fullOpt.value = '*';
    fullOpt.textContent = `Full document (${doc.path})`;
    selectEl.appendChild(fullOpt);
    if (currentId) {
      selectEl.value = currentId;
    }
  };

  const buildBoundGitHubUrl = (meta: PenpotGitMeta): string => {
    const base = meta.githubUrl.split('#')[0];
    if (meta.sectionId && meta.sectionId !== '*') {
      return `${base}#${meta.sectionId}`;
    }
    return base;
  };

  selectedCopyBtn?.addEventListener('click', () => {
    if (!selectedBound) return;
    const fullUrl = buildBoundGitHubUrl(selectedBound.meta);
    const done = () => {
      if (!selectedCopyBtn) return;
      selectedCopyBtn.textContent = 'COPIED!';
      setTimeout(() => {
        if (selectedCopyBtn) selectedCopyBtn.textContent = 'COPY';
      }, 1500);
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(fullUrl).then(done).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = fullUrl;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch { /* ignore */ }
        document.body.removeChild(ta);
        done();
      });
    } else {
      const ta = document.createElement('textarea');
      ta.value = fullUrl;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      document.body.removeChild(ta);
      done();
    }
  });

  const renderSelectedBoundCard = (sel: SelectionPayload | null): void => {
    if (!selectedCard || !selectedTitleEl || !selectedUrlEl || !selectedSectionSelect) return;
    if (!sel || !sel.gitMeta || !sel.gitMeta.githubUrl) {
      selectedBound = null;
      selectedCard.style.display = 'none';
      return;
    }

    selectedBound = { id: sel.id, name: sel.name, meta: sel.gitMeta };
    selectedCard.style.display = 'flex';
    selectedTitleEl.textContent = sel.gitMeta.sectionHeading || sel.name || 'Bound Doc';
    const fullUrl = buildBoundGitHubUrl(sel.gitMeta);
    selectedUrlEl.textContent = sel.gitMeta.githubUrl.replace(/^https:\/\/github\.com\//, '');
    selectedUrlEl.href = fullUrl;
    if (selectedOpenBtn) selectedOpenBtn.href = fullUrl;

    const cached = sectionsCache.get(sel.gitMeta.githubUrl);
    if (cached) {
      populateSelect(selectedSectionSelect, cached, sel.gitMeta.sectionId);
    } else {
      selectedSectionSelect.innerHTML = '';
      const opt = document.createElement('option');
      opt.value = sel.gitMeta.sectionId || '*';
      opt.textContent = sel.gitMeta.sectionHeading || sel.gitMeta.sectionId || 'Current section';
      selectedSectionSelect.appendChild(opt);
    }
  };

  // Lazy-load section list when user opens the Selected Bound Doc section dropdown
  const ensureSelectedSectionsLoaded = async (): Promise<void> => {
    if (!selectedBound || !selectedSectionSelect) return;
    const url = selectedBound.meta.githubUrl;
    if (sectionsCache.has(url)) return;
    try {
      const doc = await fetchDoc(url);
      if ('unchanged' in doc) return;
      if (selectedBound && selectedBound.meta.githubUrl === url) {
        populateSelect(selectedSectionSelect, doc, selectedBound.meta.sectionId);
      }
    } catch {
      // Keep current section option if offline or auth required
    }
  };

  selectedSectionSelect?.addEventListener('focus', () => {
    void ensureSelectedSectionsLoaded();
  });
  selectedSectionSelect?.addEventListener('mousedown', () => {
    void ensureSelectedSectionsLoaded();
  });

  selectedSectionSelect?.addEventListener('change', () => {
    if (!selectedBound || !selectedSectionSelect) return;
    const chosenLabel =
      selectedSectionSelect.options[selectedSectionSelect.selectedIndex]?.textContent ||
      selectedSectionSelect.value;
    setStatus(`Section set to "${chosenLabel}" — click SYNC SELECTED to update.`);
  });

  syncSelectedBtn?.addEventListener('click', async () => {
    if (!selectedBound) return;
    const { id: shapeId, meta } = selectedBound;
    const targetSectionId = selectedSectionSelect?.value || meta.sectionId || '*';
    const sectionChanged = targetSectionId !== (meta.sectionId || '*');
    syncSelectedBtn.disabled = true;
    setStatus(`Syncing "${sectionChanged ? targetSectionId : meta.sectionHeading || meta.sectionId}"...`);
    try {
      const doc = await fetchDoc(meta.githubUrl, sectionChanged ? undefined : meta.etag);
      if ('unchanged' in doc) {
        setStatus(`✓ "${meta.sectionHeading || meta.sectionId}" is already up to date.`);
        return;
      }
      const { markdown, heading, contentHash } = resolveSection(doc, targetSectionId);
      const compiled = compileToCharacterRanges(markdown);
      const nextMeta: PenpotGitMeta = {
        githubUrl: meta.githubUrl,
        githubBranch: doc.branch,
        sectionId: targetSectionId,
        sectionHeading: heading,
        contentHash,
        etag: doc.etag || undefined,
      };
      const reply = await sendPluginRequest({
        action: 'update-git-text',
        shapeId,
        characters: compiled.plainText,
        ranges: compiled.ranges,
        meta: nextMeta,
      });
      if (reply.error) throw new Error(reply.error);
      setStatus(`✓ Updated "${heading}".`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Sync failed', true);
    } finally {
      syncSelectedBtn.disabled = false;
    }
  });

  window.addEventListener('message', (event: MessageEvent) => {
    const raw = event.data as (PluginReply & { type?: string; tokens?: unknown }) | { pluginMessage?: PluginReply } | null;
    if (!raw || typeof raw !== 'object') return;

    // Handle OAuth popup postMessage
    if ('type' in raw && raw.type === 'GITHUB_AUTH_SUCCESS') {
      const tok = extractAccessToken(raw.tokens);
      if (tok) applyGitHubOAuthToken(tok);
      return;
    }

    const msg: PluginReply =
      'pluginMessage' in raw && raw.pluginMessage ? raw.pluginMessage : (raw as PluginReply);

    if (msg.action === 'selection-changed-locally') {
      renderSelectedBoundCard((msg.data as SelectionPayload | null) ?? null);
      return;
    }

    if (!msg.requestId) return;
    if (msg.action !== 'git-text-result' && msg.action !== 'scan-git-shapes-result') return;
    const entry = pending.get(msg.requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(msg.requestId);
    entry.resolve(msg);
  });

  loadBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) {
      setStatus('Paste a GitHub Markdown (.md) URL first.', true);
      return;
    }
    loadBtn.disabled = true;
    setStatus('Loading Markdown from GitHub...');
    try {
      const result = await fetchDoc(url);
      if ('unchanged' in result) return;
      currentDoc = result;
      populateSelect(sectionSelect, result);
      if (sectionWrap) sectionWrap.style.display = 'flex';
      setStatus(`Loaded ${result.path} (${result.sections.length} sections).`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Failed to load Markdown', true);
    } finally {
      loadBtn.disabled = false;
    }
  });

  const buildPayload = () => {
    if (!currentDoc) return null;
    const sectionId = sectionSelect.value || '*';
    const { markdown, heading, contentHash } = resolveSection(currentDoc, sectionId);
    const compiled = compileToCharacterRanges(markdown);
    const meta: PenpotGitMeta = {
      githubUrl: currentDoc.canonicalUrl,
      githubBranch: currentDoc.branch,
      sectionId,
      sectionHeading: heading,
      contentHash,
      etag: currentDoc.etag || undefined,
    };
    return { characters: compiled.plainText, ranges: compiled.ranges, meta };
  };

  placeBtn?.addEventListener('click', async () => {
    const payload = buildPayload();
    if (!payload) return;
    placeBtn.disabled = true;
    setStatus('Creating Penpot Text shape...');
    try {
      const reply = await sendPluginRequest({ action: 'create-git-text', ...payload });
      if (reply.error) throw new Error(reply.error);
      setStatus(`✓ Placed "${payload.meta.sectionHeading}" on canvas.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Failed to place text', true);
    } finally {
      placeBtn.disabled = false;
    }
  });

  bindBtn?.addEventListener('click', async () => {
    const payload = buildPayload();
    if (!payload) return;
    bindBtn.disabled = true;
    setStatus('Binding selected Penpot Text shape...');
    try {
      const reply = await sendPluginRequest({ action: 'update-git-text', ...payload });
      if (reply.error) throw new Error(reply.error);
      setStatus(`✓ Bound & updated "${payload.meta.sectionHeading}".`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Failed to bind text shape', true);
    } finally {
      bindBtn.disabled = false;
    }
  });

  syncAllBtn?.addEventListener('click', async () => {
    syncAllBtn.disabled = true;
    setStatus('Scanning page for bound GitHub text shapes...');
    try {
      const scanReply = await sendPluginRequest({ action: 'scan-git-shapes' });
      if (scanReply.error) throw new Error(scanReply.error);
      const shapes = Array.isArray(scanReply.data) ? (scanReply.data as ScannedGitShape[]) : [];
      const bound = shapes.filter((s) => s.meta && s.meta.githubUrl);
      if (bound.length === 0) {
        setStatus('No bound GitHub text shapes found on this page.');
        return;
      }

      const byUrl = new Map<string, ScannedGitShape[]>();
      for (const s of bound) {
        const u = s.meta!.githubUrl;
        const list = byUrl.get(u) ?? [];
        list.push(s);
        byUrl.set(u, list);
      }

      let updated = 0;
      let unchanged = 0;
      for (const [url, list] of byUrl.entries()) {
        const sameEtag =
          list[0].meta?.etag && list.every((item) => item.meta?.etag === list[0].meta?.etag);
        const doc = await fetchDoc(url, sameEtag ? list[0].meta?.etag : undefined);
        if ('unchanged' in doc) {
          unchanged += list.length;
          continue;
        }
        for (const shape of list) {
          const secId = shape.meta?.sectionId || '*';
          const { markdown, heading, contentHash } = resolveSection(doc, secId);
          const compiled = compileToCharacterRanges(markdown);
          const nextMeta: PenpotGitMeta = {
            githubUrl: url,
            githubBranch: doc.branch,
            sectionId: secId,
            sectionHeading: heading,
            contentHash,
            etag: doc.etag || undefined,
          };
          const reply = await sendPluginRequest({
            action: 'update-git-text',
            shapeId: shape.id,
            characters: compiled.plainText,
            ranges: compiled.ranges,
            meta: nextMeta,
          });
          if (reply.error) throw new Error(reply.error);
          updated += 1;
        }
      }
      setStatus(
        updated > 0
          ? `✓ Synced ${updated} text shape(s)${unchanged > 0 ? ` (${unchanged} unchanged)` : ''}.`
          : `✓ All ${unchanged} text shape(s) already up to date.`
      );
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Sync failed', true);
    } finally {
      syncAllBtn.disabled = false;
    }
  });

  // Initialize GitHub OAuth row state
  updateGitHubOAuthUI();
}
