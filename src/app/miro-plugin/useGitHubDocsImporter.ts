import { useCallback, useEffect, useState } from 'react';
import { compileToMiroHtml } from '@/lib/sync/markdownCompiler';

type SyncStatusType = 'info' | 'progress' | 'success' | 'error';

export interface GitHubDocSection {
  id: string;
  title: string;
  level: number;
  markdown: string;
  contentHash: string;
  startLine: number;
  endLine: number;
}

export interface GitHubDocPayload {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  canonicalUrl: string;
  sectionId: string | null;
  lineRange: { start: number; end: number } | null;
  lineRangeMarkdown: string | null;
  lineRangeHash: string | null;
  etag: string | null;
  fullHash: string;
  fullMarkdown: string;
  sections: GitHubDocSection[];
}

interface MiroTextWidgetLike {
  id: string;
  type: string;
  content?: string;
  getMetadata?(namespace?: string): Promise<unknown>;
  setMetadata?(namespace: string, value: unknown): Promise<void>;
  sync?(): Promise<void>;
}

interface MiroBoardDocsLike {
  viewport: {
    get(): Promise<{ x: number; y: number; width: number; height: number }>;
  };
  createText(opts: {
    content: string;
    x: number;
    y: number;
    width?: number;
  }): Promise<MiroTextWidgetLike>;
  getSelection(): Promise<MiroTextWidgetLike[]>;
}

interface GitHubTextSyncMeta {
  platform: 'github';
  url: string;
  sectionId: string;
  sectionTitle: string;
  contentHash: string;
  etag?: string | null;
}

const GITHUB_PAT_STORAGE_KEY = 'syncingboard_github_pat';
const TEXT_CAPABLE_TYPES = new Set(['text', 'shape', 'sticky_note', 'card']);

function getMiroBoard(): MiroBoardDocsLike | null {
  if (typeof window === 'undefined') return null;
  const miro = (window as unknown as { miro?: { board?: MiroBoardDocsLike } }).miro;
  return miro?.board ?? null;
}

export function useGitHubDocsImporter(
  setSyncStatusParent: (msg: string, type?: SyncStatusType) => void,
  githubOAuthToken?: string | null
) {
  const [githubUrl, setGithubUrl] = useState<string>('');
  const [githubPat, setGithubPat] = useState<string>('');
  const [docData, setDocData] = useState<GitHubDocPayload | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState<string>('*');
  const [isLoadingDoc, setIsLoadingDoc] = useState<boolean>(false);
  const [isSyncingDocs, setIsSyncingDocs] = useState<boolean>(false);
  const [docError, setDocError] = useState<string | null>(null);

  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      try {
        const saved = window.localStorage.getItem(GITHUB_PAT_STORAGE_KEY);
        if (saved) setGithubPat(saved);
      } catch {
        // ignore storage errors
      }
    });
    return () => window.cancelAnimationFrame(rafId);
  }, []);

  const updateGithubPat = useCallback((value: string) => {
    setGithubPat(value);
    try {
      if (value.trim()) {
        window.localStorage.setItem(GITHUB_PAT_STORAGE_KEY, value.trim());
      } else {
        window.localStorage.removeItem(GITHUB_PAT_STORAGE_KEY);
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchDocByUrl = useCallback(
    async (rawUrl: string, etag?: string | null): Promise<{ status: number; data: GitHubDocPayload | null; error?: string }> => {
      const headers: Record<string, string> = {};
      const effectiveToken = githubOAuthToken?.trim() || githubPat.trim();
      if (effectiveToken) {
        headers.Authorization = `Bearer ${effectiveToken}`;
      }
      if (etag) {
        headers['If-None-Match'] = etag;
      }
      const res = await fetch(`/api/github/markdown?url=${encodeURIComponent(rawUrl.trim())}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
      });
      if (res.status === 304) {
        return { status: 304, data: null };
      }
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { status: res.status, data: null, error: err.error || `HTTP ${res.status}` };
      }
      const payload = (await res.json()) as GitHubDocPayload;
      return { status: 200, data: payload };
    },
    [githubOAuthToken, githubPat]
  );

  const loadGitHubDoc = useCallback(
    async (overrideUrl?: string) => {
      const targetUrl = (overrideUrl ?? githubUrl).trim();
      if (!targetUrl) return;
      setIsLoadingDoc(true);
      setDocError(null);
      try {
        const result = await fetchDocByUrl(targetUrl);
        if (!result.data) {
          setDocError(result.error || 'Failed to load Markdown file from GitHub.');
          setDocData(null);
          return;
        }
        setDocData(result.data);
        if (result.data.lineRange && result.data.lineRangeMarkdown !== null) {
          setSelectedSectionId(`L${result.data.lineRange.start}-L${result.data.lineRange.end}`);
        } else if (
          result.data.sectionId &&
          result.data.sections.some((s) => s.id === result.data?.sectionId)
        ) {
          setSelectedSectionId(result.data.sectionId);
        } else if (result.data.sections.length > 0) {
          setSelectedSectionId(result.data.sections[0].id);
        } else {
          setSelectedSectionId('*');
        }
        setSyncStatusParent(
          `Loaded ${result.data.path} (${result.data.sections.length} section${result.data.sections.length === 1 ? '' : 's'})`,
          'info'
        );
      } catch (err: unknown) {
        setDocError(err instanceof Error ? err.message : 'Failed to fetch Markdown');
        setDocData(null);
      } finally {
        setIsLoadingDoc(false);
      }
    },
    [fetchDocByUrl, githubUrl, setSyncStatusParent]
  );

  const resolveSelectedMarkdown = useCallback(
    (payload: GitHubDocPayload, secId: string): { markdown: string; title: string; hash: string } | null => {
      if (secId === '*') {
        return { markdown: payload.fullMarkdown, title: payload.path, hash: payload.fullHash };
      }
      if (payload.lineRange && secId === `L${payload.lineRange.start}-L${payload.lineRange.end}` && payload.lineRangeMarkdown !== null) {
        return {
          markdown: payload.lineRangeMarkdown,
          title: `${payload.path}#${secId}`,
          hash: payload.lineRangeHash || payload.fullHash,
        };
      }
      const match = payload.sections.find((s) => s.id === secId);
      if (!match) return null;
      return { markdown: match.markdown, title: match.title, hash: match.contentHash };
    },
    []
  );

  const placeTextOnBoard = useCallback(async () => {
    if (!docData) return;
    const board = getMiroBoard();
    if (!board) {
      setSyncStatusParent('Miro SDK unavailable.', 'error');
      return;
    }
    const resolved = resolveSelectedMarkdown(docData, selectedSectionId);
    if (!resolved) {
      setSyncStatusParent('Selected section not found in document.', 'error');
      return;
    }

    setIsSyncingDocs(true);
    try {
      const vp = await board.viewport.get();
      const html = compileToMiroHtml(resolved.markdown);
      const widget = await board.createText({
        content: html,
        x: vp.x + vp.width / 2,
        y: vp.y + vp.height / 2,
        width: 480,
      });

      const meta: GitHubTextSyncMeta = {
        platform: 'github',
        url: docData.canonicalUrl,
        sectionId: selectedSectionId,
        sectionTitle: resolved.title,
        contentHash: resolved.hash,
        etag: docData.etag,
      };
      if (widget.setMetadata) {
        await widget.setMetadata('syncingboard', meta);
      }
      if (widget.sync) {
        await widget.sync();
      }
      setSyncStatusParent(`Placed "${resolved.title}" from GitHub onto board.`, 'success');
    } catch (err: unknown) {
      setSyncStatusParent(
        `Place failed: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
    } finally {
      setIsSyncingDocs(false);
    }
  }, [docData, resolveSelectedMarkdown, selectedSectionId, setSyncStatusParent]);

  const bindSelectedTextWidget = useCallback(async () => {
    if (!docData) return;
    const board = getMiroBoard();
    if (!board) return;
    const resolved = resolveSelectedMarkdown(docData, selectedSectionId);
    if (!resolved) return;

    setIsSyncingDocs(true);
    try {
      const selection = await board.getSelection();
      const target = selection.find((w) => TEXT_CAPABLE_TYPES.has(w.type));
      if (!target) {
        setSyncStatusParent('Select a text box, shape, or sticky note on the Miro board first.', 'error');
        return;
      }

      target.content = compileToMiroHtml(resolved.markdown);
      const meta: GitHubTextSyncMeta = {
        platform: 'github',
        url: docData.canonicalUrl,
        sectionId: selectedSectionId,
        sectionTitle: resolved.title,
        contentHash: resolved.hash,
        etag: docData.etag,
      };
      if (target.setMetadata) {
        await target.setMetadata('syncingboard', meta);
      }
      if (target.sync) {
        await target.sync();
      }
      setSyncStatusParent(`Bound selected ${target.type} to "${resolved.title}".`, 'success');
    } catch (err: unknown) {
      setSyncStatusParent(
        `Bind failed: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
    } finally {
      setIsSyncingDocs(false);
    }
  }, [docData, resolveSelectedMarkdown, selectedSectionId, setSyncStatusParent]);

  const syncSelectedGitHubDocs = useCallback(async () => {
    const board = getMiroBoard();
    if (!board) return;

    setIsSyncingDocs(true);
    try {
      const selection = await board.getSelection();
      const boundWidgets: { widget: MiroTextWidgetLike; meta: GitHubTextSyncMeta }[] = [];

      for (const w of selection) {
        if (!TEXT_CAPABLE_TYPES.has(w.type) || !w.getMetadata) continue;
        const raw = (await w.getMetadata('syncingboard')) as Record<string, unknown> | undefined;
        if (raw && raw.platform === 'github' && typeof raw.url === 'string' && typeof raw.sectionId === 'string') {
          boundWidgets.push({
            widget: w,
            meta: {
              platform: 'github',
              url: raw.url,
              sectionId: raw.sectionId,
              sectionTitle: typeof raw.sectionTitle === 'string' ? raw.sectionTitle : raw.sectionId,
              contentHash: typeof raw.contentHash === 'string' ? raw.contentHash : '',
              etag: typeof raw.etag === 'string' ? raw.etag : null,
            },
          });
        }
      }

      if (boundWidgets.length === 0) {
        setSyncStatusParent('No GitHub-bound text widgets selected on the board.', 'error');
        return;
      }

      // Deduplicate fetches by canonical URL
      const urlCache = new Map<string, GitHubDocPayload | 'not_modified'>();
      let updated = 0;
      let unchanged = 0;
      let missing = 0;

      for (const { widget, meta } of boundWidgets) {
        let payload = urlCache.get(meta.url);
        if (!payload) {
          const res = await fetchDocByUrl(meta.url, meta.etag);
          if (res.status === 304) {
            payload = 'not_modified';
          } else if (res.data) {
            payload = res.data;
          } else {
            throw new Error(res.error || `Failed to fetch ${meta.url}`);
          }
          urlCache.set(meta.url, payload);
        }

        if (payload === 'not_modified') {
          unchanged += 1;
          continue;
        }

        const resolved = resolveSelectedMarkdown(payload, meta.sectionId);
        if (!resolved) {
          missing += 1;
          continue;
        }

        if (resolved.hash === meta.contentHash) {
          unchanged += 1;
          continue;
        }

        widget.content = compileToMiroHtml(resolved.markdown);
        if (widget.setMetadata) {
          await widget.setMetadata('syncingboard', {
            ...meta,
            sectionTitle: resolved.title,
            contentHash: resolved.hash,
            etag: payload.etag,
          });
        }
        if (widget.sync) {
          await widget.sync();
        }
        updated += 1;
      }

      const parts: string[] = [];
      if (updated > 0) parts.push(`Updated ${updated}`);
      if (unchanged > 0) parts.push(`${unchanged} already up to date`);
      if (missing > 0) parts.push(`${missing} missing section in Git`);
      setSyncStatusParent(`GitHub Docs sync: ${parts.join(', ')}.`, missing > 0 ? 'info' : 'success');
    } catch (err: unknown) {
      setSyncStatusParent(
        `Docs sync failed: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
    } finally {
      setIsSyncingDocs(false);
    }
  }, [fetchDocByUrl, resolveSelectedMarkdown, setSyncStatusParent]);

  return {
    githubUrl,
    setGithubUrl,
    githubPat,
    updateGithubPat,
    docData,
    selectedSectionId,
    setSelectedSectionId,
    isLoadingDoc,
    isSyncingDocs,
    docError,
    loadGitHubDoc,
    placeTextOnBoard,
    bindSelectedTextWidget,
    syncSelectedGitHubDocs,
  };
}
