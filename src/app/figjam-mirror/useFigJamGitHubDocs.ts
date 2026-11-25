'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { compileToCharacterRanges } from '@/lib/sync/markdownCompiler';
import type { GitHubDocPayload } from '@/app/miro-plugin/useGitHubDocsImporter';
import type { SyncedImage } from '@/app/miro-plugin/useMiroSelection';
import type { SyncStatusType } from '@/app/miro-plugin/useMiroPlugin';

const GITHUB_PAT_STORAGE_KEY = 'syncingboard_github_pat';
const DOC_REQUEST_TIMEOUT_MS = 15_000;

interface FigJamDocResultMsg {
  action: 'figjam-doc-result';
  requestId?: string;
  ok?: boolean;
  error?: string;
  nodeId?: string;
  updatedCount?: number;
  name?: string;
}

interface PendingDocRequest {
  resolve: (res: FigJamDocResultMsg) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function postToPlugin(msg: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  window.parent.postMessage(msg, '*');
}

function resolveSectionContent(
  docData: GitHubDocPayload,
  sectionId: string
): { markdown: string; heading: string; contentHash: string } {
  if (sectionId === '*') {
    return {
      markdown: docData.fullMarkdown,
      heading: `${docData.repo}/${docData.path}`,
      contentHash: docData.fullHash,
    };
  }
  if (
    docData.lineRange &&
    sectionId === `L${docData.lineRange.start}-L${docData.lineRange.end}` &&
    docData.lineRangeMarkdown !== null
  ) {
    return {
      markdown: docData.lineRangeMarkdown,
      heading: `${docData.path} (${sectionId})`,
      contentHash: docData.lineRangeHash || docData.fullHash,
    };
  }
  const found = docData.sections.find((s) => s.id === sectionId);
  if (found) {
    return { markdown: found.markdown, heading: found.title, contentHash: found.contentHash };
  }
  const first = docData.sections[0];
  return first
    ? { markdown: first.markdown, heading: first.title, contentHash: first.contentHash }
    : { markdown: docData.fullMarkdown, heading: docData.path, contentHash: docData.fullHash };
}

export function useFigJamGitHubDocs(
  setStatus: (message: string, type: SyncStatusType) => void,
  githubToken: string | null,
  selectedForeignIds: string[],
  selectedTrackedIds: string[]
) {
  const [githubUrl, setGithubUrl] = useState<string>('');
  const [githubPat, setGithubPatState] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem(GITHUB_PAT_STORAGE_KEY) || '';
  });
  const [docData, setDocData] = useState<GitHubDocPayload | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedSectionId, setSelectedSectionId] = useState<string>('');
  const [isLoadingDoc, setIsLoadingDoc] = useState<boolean>(false);
  const [isSyncingDocs, setIsSyncingDocs] = useState<boolean>(false);
  const [docError, setDocError] = useState<string | null>(null);

  const pendingRef = useRef<Map<string, PendingDocRequest>>(new Map());

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as FigJamDocResultMsg | null;
      if (!msg || typeof msg !== 'object' || msg.action !== 'figjam-doc-result') return;
      if (!msg.requestId) return;
      const pending = pendingRef.current.get(msg.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRef.current.delete(msg.requestId);
      pending.resolve(msg);
    };
    window.addEventListener('message', onMessage);
    const pendingMap = pendingRef.current;
    return () => {
      window.removeEventListener('message', onMessage);
      for (const req of pendingMap.values()) {
        clearTimeout(req.timer);
        req.reject(new Error('FigJam doc bridge unmounted'));
      }
      pendingMap.clear();
    };
  }, []);

  const sendDocCommand = useCallback(
    (action: 'figjam-place-doc' | 'figjam-update-doc', payload: Record<string, unknown>) => {
      return new Promise<FigJamDocResultMsg>((resolve, reject) => {
        const requestId = `fjdoc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(() => {
          pendingRef.current.delete(requestId);
          reject(new Error('FigJam plugin did not respond in time'));
        }, DOC_REQUEST_TIMEOUT_MS);
        pendingRef.current.set(requestId, { resolve, reject, timer });
        postToPlugin({ action, requestId, payload });
      });
    },
    []
  );

  const setGithubPat = useCallback((pat: string) => {
    setGithubPatState(pat);
    if (typeof window !== 'undefined') {
      if (pat.trim()) {
        localStorage.setItem(GITHUB_PAT_STORAGE_KEY, pat.trim());
      } else {
        localStorage.removeItem(GITHUB_PAT_STORAGE_KEY);
      }
    }
  }, []);

  const getActiveAuthToken = useCallback((): string | null => {
    if (githubToken && githubToken.trim()) return githubToken.trim();
    if (githubPat && githubPat.trim()) return githubPat.trim();
    return null;
  }, [githubToken, githubPat]);

  const fetchDocPayload = useCallback(
    async (
      url: string,
      etag?: string,
      branchOverride?: string
    ): Promise<GitHubDocPayload | { unchanged: true }> => {
      const headers: Record<string, string> = {};
      const token = getActiveAuthToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (etag) headers['If-None-Match'] = etag;

      const branchQuery = branchOverride ? `&branch=${encodeURIComponent(branchOverride)}` : '';
      const res = await fetch(`/api/github/markdown?url=${encodeURIComponent(url)}${branchQuery}`, {
        headers,
      });
      if (res.status === 304) {
        return { unchanged: true };
      }
      const data = (await res.json().catch(() => ({}))) as Partial<GitHubDocPayload> & {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || `GitHub fetch failed (${res.status})`);
      }
      return data as GitHubDocPayload;
    },
    [getActiveAuthToken]
  );

  const fetchBranches = useCallback(
    async (owner: string, repo: string) => {
      try {
        const headers: Record<string, string> = {};
        const token = getActiveAuthToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(
          `/api/github/branches?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
          { headers }
        );
        if (!res.ok) return;
        const json = (await res.json()) as { branches?: string[] };
        if (Array.isArray(json.branches)) {
          setBranches(json.branches);
        }
      } catch {
        // Non-fatal
      }
    },
    [getActiveAuthToken]
  );

  const loadDoc = useCallback(
    async (overrideUrl?: string, branchOverride?: string) => {
      const trimmed = (overrideUrl ?? githubUrl).trim();
      if (!trimmed) {
        setDocError('Paste a GitHub Markdown (.md) URL first.');
        return;
      }
      setIsLoadingDoc(true);
      setDocError(null);
      try {
        const result = await fetchDocPayload(trimmed, undefined, branchOverride);
        if ('unchanged' in result) return;
        setDocData(result);
        if (branchOverride) {
          setGithubUrl(result.canonicalUrl);
        }
        void fetchBranches(result.owner, result.repo);
        if (result.lineRange && result.lineRangeMarkdown !== null) {
          setSelectedSectionId(`L${result.lineRange.start}-L${result.lineRange.end}`);
        } else if (result.sections.length > 0) {
          setSelectedSectionId(result.sections[0].id);
        } else {
          setSelectedSectionId('*');
        }
        setStatus(
          `Loaded ${result.path} (${result.branch} · ${result.sections.length} section${result.sections.length === 1 ? '' : 's'})`,
          'info'
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to load GitHub Markdown';
        setDocError(msg);
        setStatus(msg, 'error');
      } finally {
        setIsLoadingDoc(false);
      }
    },
    [githubUrl, fetchDocPayload, fetchBranches, setStatus]
  );

  const switchBranch = useCallback(
    async (nextBranch: string) => {
      if (!docData || !nextBranch || nextBranch === docData.branch) return;
      await loadDoc(docData.canonicalUrl, nextBranch);
    },
    [docData, loadDoc]
  );

  const placeAsText = useCallback(async () => {
    if (!docData) return;
    setIsSyncingDocs(true);
    setDocError(null);
    try {
      const { markdown, heading, contentHash } = resolveSectionContent(docData, selectedSectionId);
      const compiled = compileToCharacterRanges(markdown);
      const res = await sendDocCommand('figjam-place-doc', {
        widgetType: 'text',
        githubUrl: docData.canonicalUrl,
        githubBranch: docData.branch,
        sectionId: selectedSectionId || '*',
        sectionHeading: heading,
        characters: compiled.plainText,
        ranges: compiled.ranges,
        contentHash,
        etag: docData.etag || '',
      });
      if (!res.ok) {
        throw new Error(res.error || 'Failed to place FigJam text widget');
      }
      setStatus(`✓ Placed "${heading}" on FigJam`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to place FigJam text';
      setDocError(msg);
      setStatus(msg, 'error');
    } finally {
      setIsSyncingDocs(false);
    }
  }, [docData, selectedSectionId, sendDocCommand, setStatus]);

  const bindSelectedWidgets = useCallback(async () => {
    if (!docData) return;
    const targetIds = Array.from(new Set([...selectedTrackedIds, ...selectedForeignIds]));
    if (targetIds.length === 0) {
      setStatus('Select a text, sticky note, or shape on FigJam first.', 'info');
      return;
    }
    setIsSyncingDocs(true);
    setDocError(null);
    try {
      const { markdown, heading, contentHash } = resolveSectionContent(docData, selectedSectionId);
      const compiled = compileToCharacterRanges(markdown);
      const res = await sendDocCommand('figjam-update-doc', {
        nodeIds: targetIds,
        githubUrl: docData.canonicalUrl,
        githubBranch: docData.branch,
        sectionId: selectedSectionId || '*',
        sectionHeading: heading,
        characters: compiled.plainText,
        ranges: compiled.ranges,
        contentHash,
        etag: docData.etag || '',
      });
      if (!res.ok) {
        throw new Error(res.error || 'Failed to bind FigJam widget');
      }
      setStatus(
        `✓ Bound ${res.updatedCount || targetIds.length} widget(s) to "${heading}"`,
        'success'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to bind FigJam widget';
      setDocError(msg);
      setStatus(msg, 'error');
    } finally {
      setIsSyncingDocs(false);
    }
  }, [docData, selectedSectionId, selectedTrackedIds, selectedForeignIds, sendDocCommand, setStatus]);

  const syncGitHubItems = useCallback(
    async (items: SyncedImage[]): Promise<{ updated: number; unchanged: number }> => {
      if (items.length === 0) return { updated: 0, unchanged: 0 };
      const byUrl = new Map<string, SyncedImage[]>();
      for (const item of items) {
        const url = item.fileKey;
        if (!url) continue;
        const list = byUrl.get(url) ?? [];
        list.push(item);
        byUrl.set(url, list);
      }

      let updated = 0;
      let unchanged = 0;
      for (const [url, urlItems] of byUrl.entries()) {
        const allSameEtag =
          urlItems.length > 0 &&
          urlItems[0].etag &&
          urlItems.every((i) => i.etag === urlItems[0].etag);
        const result = await fetchDocPayload(url, allSameEtag ? urlItems[0].etag : undefined);
        if ('unchanged' in result) {
          unchanged += urlItems.length;
          continue;
        }
        // Group by sectionId within this URL
        const bySection = new Map<string, SyncedImage[]>();
        for (const item of urlItems) {
          const secId = item.nodeId || '*';
          const list = bySection.get(secId) ?? [];
          list.push(item);
          bySection.set(secId, list);
        }
        for (const [secId, secItems] of bySection.entries()) {
          const { markdown, heading, contentHash } = resolveSectionContent(result, secId);
          const compiled = compileToCharacterRanges(markdown);
          const res = await sendDocCommand('figjam-update-doc', {
            nodeIds: secItems.map((i) => i.id),
            githubUrl: url,
            githubBranch: result.branch,
            sectionId: secId,
            sectionHeading: heading,
            characters: compiled.plainText,
            ranges: compiled.ranges,
            contentHash,
            etag: result.etag || '',
          });
          if (!res.ok) {
            throw new Error(res.error || `Failed to update "${heading}"`);
          }
          updated += res.updatedCount || secItems.length;
        }
      }
      return { updated, unchanged };
    },
    [fetchDocPayload, sendDocCommand]
  );

  const retargetGitHubSection = useCallback(
    async (widgetIds: string[], _githubUrlForGroup: string, nextSectionId: string, nextSectionHeading: string) => {
      if (widgetIds.length === 0) return;
      // Only update the bound section metadata; wait for the user to click Sync Selected
      postToPlugin({
        action: 'figjam-set-meta',
        nodeIds: widgetIds,
        sectionId: nextSectionId,
        sectionHeading: nextSectionHeading,
      });
      setStatus(`Section set to "${nextSectionHeading}" — click Sync Selected to update`, 'info');
    },
    [setStatus]
  );

  const retargetGitHubBranch = useCallback(
    async (widgetIds: string[], nextUrl: string, nextBranch: string) => {
      if (widgetIds.length === 0 || !nextUrl) return;
      postToPlugin({
        action: 'figjam-set-meta',
        nodeIds: widgetIds,
        githubUrl: nextUrl,
        githubBranch: nextBranch,
      });
      setStatus(`Branch set to "${nextBranch}" — click Sync Selected to update`, 'info');
    },
    [setStatus]
  );

  return {
    githubUrl,
    setGithubUrl,
    githubPat,
    setGithubPat,
    docData,
    branches,
    selectedSectionId,
    setSelectedSectionId,
    isLoadingDoc,
    isSyncingDocs,
    docError,
    loadDoc,
    switchBranch,
    placeAsText,
    bindSelectedWidgets,
    syncGitHubItems,
    retargetGitHubSection,
    retargetGitHubBranch,
  };
}
