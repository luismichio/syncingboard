'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthTokens } from '@/app/miro-plugin/useAuthTokens';
import { parseFigmaUrl } from '@/lib/sync/figmaUrlParser';
import { callRelay, getOrCreatePairingId, subscribeRelayLive } from '@/lib/sync/companionRelayClient';
import { decodeHtmlEntities } from '@/lib/decodeHtmlEntities';
import { formatDuration } from '@/lib/formatDuration';
import { SyncedImage } from '@/app/miro-plugin/useMiroSelection';
import type { SyncStatus, SyncStatusType } from '@/app/miro-plugin/useMiroPlugin';

/**
 * FigJam target hook. The FigJam board is the destination; the plugin exposes
 * the board via figma.ui postMessage. This hook mirrors the shape of
 * useMiroPlugin so the SAME sidebar components render identically for Miro and
 * FigJam (the shared TargetAdapter UI mirror).
 *
 * Bridge:
 *   -> plugin: window.parent.postMessage({ action, ... }, '*')
 *   <- plugin: window.onmessage ({ action: ... })
 */

interface FigjamTracked {
  id: string;
  key?: string;
  fileKey?: string;
  nodeId?: string;
  name?: string;
  format?: 'png' | 'svg';
  scale?: number;
  platform?: 'figma' | 'penpot';
}

interface BridgeMsg {
  action: string;
  selected?: FigjamTracked[];
  tracked?: FigjamTracked[];
  foreign?: { id: string; name: string }[];
  data?: { id: string; name: string; fileKey: string } | null;
  ok?: boolean;
  key?: string;
  error?: string;
  created?: boolean;
  /** Node-swap fallback fired (component/locked fills couldn't be written; plugin deleted the old node and created a rectangle at the same geometry). */
  swap?: boolean;
  /** Human-readable frame name from the source (plugin echoes payload.name). */
  name?: string;
  editorType?: string;
}

// FigJam's createImageAsync rejects SVG data-URLs ("Image type is
// unsupported"), so SVG imports (Figma + Penpot) are rasterized to PNG in
// the browser before placement. The canvas is sized at the SVG's natural
// size × scale, so PNG pixels keep the same visual scale semantics as the
// direct-PNG path (1× = design size, 2× = double, crisp).
function decodeSvgDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return '';
  const head = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (head.includes('base64')) {
    try {
      const raw = atob(body);
      const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      try {
        return new TextDecoder('utf-8').decode(bytes);
      } catch {
        return raw;
      }
    } catch {
      return '';
    }
  }
  try {
    return decodeURIComponent(body);
  } catch {
    return body;
  }
}

function svgTextDimensions(text: string): { width: number; height: number } | null {
  const head = text.slice(0, 4096);
  const w = /\bwidth=["']([\d.]+)/.exec(head);
  const h = /\bheight=["']([\d.]+)/.exec(head);
  let width = w ? parseFloat(w[1]) : NaN;
  let height = h ? parseFloat(h[1]) : NaN;
  if (!isFinite(width) || !isFinite(height)) {
    const vb = /\bviewBox=["']([-\d.\s]+)["']/.exec(head);
    if (vb && vb[1]) {
      const parts = vb[1].trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every((n) => isFinite(n))) {
        if (!isFinite(width)) width = parts[2];
        if (!isFinite(height)) height = parts[3];
      }
    }
  }
  if (isFinite(width) && isFinite(height) && width > 0 && height > 0 && width < 100000 && height < 100000) {
    return { width, height };
  }
  return null;
}

async function svgToPngDataUrl(
  svgDataUrl: string,
  scale: number,
  fallbackW?: number,
  fallbackH?: number
): Promise<string> {
  const dims = svgTextDimensions(decodeSvgDataUrl(svgDataUrl));
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const w = Math.max(1, Math.round((dims?.width || fallbackW || 240) * safeScale));
  const h = Math.max(1, Math.round((dims?.height || fallbackH || 160) * safeScale));
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('SVG rasterization failed (the browser rejected this SVG).'));
    img.src = svgDataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable in this webview.');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/png');
}

async function exportPenpotViaRelay(
  objectId: string,
  format: 'png' | 'svg',
  scale: number
): Promise<{ dataUrl: string; name?: string; width?: number; height?: number }> {
  const pairingId = getOrCreatePairingId();
  if (!pairingId) {
    throw new Error('Pairing ID is not set. Copy it from Settings first.');
  }
  const data = await callRelay({
    pairingId,
    platform: 'penpot',
    action: 'export',
    shapeId: objectId,
    format,
    scale,
    timeoutMs: 45_000,
  });
  const payload = data as {
    svg?: string;
    base64?: string;
    name?: string;
    width?: number;
    height?: number;
  } | null;
  if (!payload) {
    throw new Error('Penpot relay returned an empty export.');
  }
  const name = payload.name ? decodeHtmlEntities(payload.name) : undefined;
  let dataUrl: string;
  if (format === 'svg') {
    if (!payload.svg) {
      throw new Error('Penpot relay returned empty SVG export data.');
    }
    const svgBase64 = btoa(unescape(encodeURIComponent(payload.svg)));
    dataUrl = `data:image/svg+xml;base64,${svgBase64}`;
  } else {
    if (!payload.base64) {
      throw new Error('Penpot relay returned empty PNG export data.');
    }
    dataUrl = `data:image/png;base64,${payload.base64}`;
  }
  return { dataUrl, name, width: payload.width, height: payload.height };
}

function postToPlugin(msg: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  window.parent.postMessage(msg, '*');
}

function trackedToSynced(items: FigjamTracked[]): SyncedImage[] {
  // One card per SELECTED image instance (duplicates are distinct board
  // nodes and count as separate selections — the SyncTab group badge shows
  // "xN"). Persisted per-instance format/scale/platform round-trip here.
  return items.map((t) => ({
    id: t.id || t.key || '',
    title: t.name || t.key || t.id || '',
    fileKey: t.fileKey || '',
    nodeId: t.nodeId || '',
    nodeName: t.name || '',
    format: t.format || 'png',
    scale: t.scale || 1,
    platform: t.platform || 'figma',
  }));
}

export function useFigJamPlugin() {
  const { figmaToken, tokensLoading, connectFigma, disconnectFigma } = useAuthTokens(false);
  const selectionKey = useMemo(
    () => rawSelectedItems.map((i) => i.id).sort().join(','),
    [rawSelectedItems]
  );
  const [prevSelectionKey, setPrevSelectionKey] = useState(selectionKey);
  const [deselectedIds, setDeselectedIds] = useState<string[]>([]);

  if (prevSelectionKey !== selectionKey) {
    setPrevSelectionKey(selectionKey);
    setDeselectedIds([]);
  }

  const selectedItems = useMemo(
    () => rawSelectedItems.filter((item) => !deselectedIds.includes(item.id)),
    [rawSelectedItems, deselectedIds]
  );

  const handleDeselectGroup = useCallback((_groupKey: string, itemIds: string[]) => {
    setDeselectedIds((prev) => Array.from(new Set([...prev, ...itemIds])));
    postToPlugin({ action: 'figjam-deselect', nodeIds: itemIds });
  }, []);

  const handleClearDeselected = useCallback(() => {
    setDeselectedIds([]);
  }, []);

  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [figmaInput, setFigmaInput] = useState('');
  const [figmaParseError, setFigmaParseError] = useState<string | null>(null);
  const [figmaNodeInfo, setFigmaNodeInfo] = useState<{
    fileKey: string;
    nodeId: string;
    name: string;
  } | null>(null);
  const [isDetectingLocal, setIsDetectingLocal] = useState(false);
  const [syncAllCopies, setSyncAllCopies] = useState(false);
  const [preserveSize, setPreserveSize] = useState(false);
  const [propagate, setPropagate] = useState(false);
  const [penpotNodeInfo, setPenpotNodeInfo] = useState<{
    fileId: string;
    objectId: string;
    name: string;
  } | null>(null);
  const [isDetectingPenpotLocal, setIsDetectingPenpotLocal] = useState(false);
  // Foreign nodes (images placed by hand / other plugins): selected but not
  // SyncingBoard mirrors — the Import tab can still REPLACE them.
  const [foreignSelection, setForeignSelection] = useState<{ id: string; name: string }[]>([]);
  // M3 live-push: opt-in toggle (OFF by default so the relay only runs on
  // explicit Detect presses — no quota burn without the user asking).
  const [liveFigmaSelection, setLiveFigmaSelection] = useState(false);
  const [editorType, setEditorType] = useState('figma');

  const tokenRef = useRef<string | null>(figmaToken);
  const placeWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Render cache: replaces/imports of the same frame+scale+format reuse the
  // last data-URL (90s TTL) instead of burning a Figma API render every
  // click — repeated replaces used to hit the rate limit after ~4 tries.
  const renderCacheRef = useRef(new Map<string, { value: unknown; at: number }>());
  const [rateLimited, setRateLimited] = useState(false);
  // Session API-call telemetry: renders hit Figma's REST API (the expensive,
  // rate-limited call); cache hits do not. Surfaced in Settings so the user
  // can see exactly how many calls each session burns.
  const [figmaApiCalls, setFigmaApiCalls] = useState(0);
  const [figmaCacheHits, setFigmaCacheHits] = useState(0);
  const [rateInfo, setRateInfo] = useState<{ planTier: string; limitType: string; retryAfter: number } | null>(null);
  // Figma REST API rate limits are a ROLLING 60-second window (Pro = 10
  // calls/min per developers.figma.com/docs/rest-api/rate-limits): every
  // request occupies a slot for 60s, then frees it. We keep timestamps so
  // the UI can show live usage and the pacer can wait for a free slot
  // BEFORE issuing a call (no more 429s from normal use).
  const RENDER_WINDOW_MS = 60_000;
const DEFAULT_WINDOW_LIMIT = 10;
const windowLimitRef = useRef(DEFAULT_WINDOW_LIMIT);
const limitOverrideRef = useRef<number | null>(null);
// Figma's limit profile has MORE dimensions than our window (per-file
// rules, burst classes, priority tiers — see X-Figma-Rate-Limit-Type). ANY
// 429 or a 0-remaining header engages a session COOLDOWN during which no
// render starts; the window pacer covers the documented calls/min, the
// cooldown covers everything else.
const [cooldownUntil, setCooldownUntil] = useState(0);
const cooldownUntilRef = useRef(0);
// Ticking seconds-left for the SyncTab gate (Miro parity: button tapers
// off + "COOLDOWN · Ns"). Previously this returned a hardcoded 0, so the
// shared SyncTab never greyed the button in the mirror.
const [cooldownSeconds, setCooldownSeconds] = useState(0);
const [rateBudget, setRateBudget] = useState<{ remaining: number | null; resetAt: number | null }>({
  remaining: null,
  resetAt: null,
});
const apiWindowRef = useRef<number[]>([]);
const [rateWindow, setRateWindow] = useState<{ count: number; limit: number }>({ count: 0, limit: DEFAULT_WINDOW_LIMIT });
const [figmaTier, setFigmaTier] = useState<string | null>(null);
// Live-selection polling is a Pro-plan feature: on the free/Community tier
// (or when the tier was never detected) the toggle is ALWAYS greyed out and
// disabled — no override exists.
const figmaIsCommunity =
  figmaTier === null || /community|free|starter/i.test(figmaTier);
const [limitOverride, setLimitOverrideState] = useState<number | null>(() => {
  // Restore a persisted override lazily (no synchronous setState in an effect).
  try {
    const stored = localStorage.getItem('sb_figma_window_override');
    const n = stored ? Number(stored) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    // localStorage may be unavailable in embedded WebViews.
    return null;
  }
});
const effectiveLimit = useCallback((): number => {
  const overridden = limitOverrideRef.current;
  return overridden && overridden > 0 ? overridden : windowLimitRef.current;
}, []);
const pruneWindow = useCallback(() => {
  const now = Date.now();
  apiWindowRef.current = apiWindowRef.current.filter((t) => now - t < RENDER_WINDOW_MS);
}, []);
const refreshWindow = useCallback(() => {
  pruneWindow();
  setRateWindow({ count: apiWindowRef.current.length, limit: effectiveLimit() });
}, [pruneWindow, effectiveLimit]);
const bumpApiCalls = useCallback((n = 1) => {
  const now = Date.now();
  pruneWindow();
  for (let i = 0; i < n; i++) apiWindowRef.current.push(now);
  setFigmaApiCalls((c) => c + n);
  refreshWindow();
}, [pruneWindow, refreshWindow]);
// Manual override (Settings) — persisted across sessions.
const setFigmaWindowOverride = useCallback(
  (n: number | null) => {
    limitOverrideRef.current = n && n > 0 ? n : null;
    setLimitOverrideState(n && n > 0 ? n : null);
    try {
      if (n && n > 0) localStorage.setItem('sb_figma_window_override', String(n));
      else localStorage.removeItem('sb_figma_window_override');
    } catch {
      // localStorage may be unavailable in embedded WebViews.
    }
    refreshWindow();
  },
  [refreshWindow]
);
// Sync the persisted override into the ref consumed by effectiveLimit(),
// outside render (refs must not be touched during render), then refresh the
// window UI. No setState runs here — the value was restored lazily above.
useEffect(() => {
  limitOverrideRef.current = limitOverride;
  refreshWindow();
}, [limitOverride, refreshWindow]);
// Wait until a slot frees up in the rolling window (oldest call expires
// 60s after it was made). Cap each wait at 40s; if it stays full the
// 429 + Retry-After path still guards.
const waitForRateSlot = useCallback(async (): Promise<void> => {
  pruneWindow();
  while (apiWindowRef.current.length >= effectiveLimit()) {
    const now = Date.now();
    const oldest = apiWindowRef.current[0];
    const waitMs = oldest + RENDER_WINDOW_MS - now;
    if (waitMs <= 0) break;
    setRateWindow({ count: apiWindowRef.current.length, limit: effectiveLimit() });
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(waitMs, 5_000), 40_000)));
    pruneWindow();
  }
  // Cooldown gate: after a 429 or a zero-remaining header Figma's own
  // limiter is engaged (its rules are multi-dimensional: per-file, burst,
  // priority). No render starts until the cooldown passes.
  while (Date.now() < cooldownUntilRef.current) {
    const leftMs = cooldownUntilRef.current - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(leftMs, 1_000), 10_000)));
  }
}, [pruneWindow, effectiveLimit]);
// Keep the displayed window fresh (a slot frees 60s after its call) and
// tick the cooldownSeconds countdown for the sync gate.
useEffect(() => {
  const id = window.setInterval(() => {
    refreshWindow();
    const left =
      cooldownUntilRef.current > 0
        ? Math.max(0, Math.ceil((cooldownUntilRef.current - Date.now()) / 1000))
        : 0;
    setCooldownSeconds(left);
    if (cooldownUntilRef.current > 0 && left === 0) {
      cooldownUntilRef.current = 0;
      setCooldownUntil(0);
    }
  }, 1_000);
  return () => window.clearInterval(id);
}, [refreshWindow]);
  // M3 live-push guard: a selection streamed from Figma does not overwrite a
  // link the user just pasted or a frame they just detected (10s window).
  const lastManualFigSourceRef = useRef(0);

  const cachedFetch = useCallback(async <T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> => {
    const hit = renderCacheRef.current.get(key) as { value: T; at: number } | undefined;
    if (hit && Date.now() - hit.at < ttlMs) {
      setFigmaCacheHits((h) => h + 1);
      return hit.value;
    }
    const value = await fetcher();
    renderCacheRef.current.set(key, { value, at: Date.now() });
    if (renderCacheRef.current.size > 40) {
      const oldest = Array.from(renderCacheRef.current.entries()).sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) renderCacheRef.current.delete(oldest[0]);
    }
    return value;
  }, []);

  const noteError = useCallback((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (/rate.?limit|429|cooldown/i.test(msg)) {
      setRateLimited(true);
      window.setTimeout(() => setRateLimited(false), 20_000);
    }
    return msg;
  }, []);
  useEffect(() => {
    tokenRef.current = figmaToken;
  }, [figmaToken]);

  const status = useCallback((message: string, type: SyncStatusType = 'info') => {
    setSyncStatus({ message, type });
  }, []);
  const resetRenderCache = useCallback(() => {
    renderCacheRef.current.clear();
    setFigmaCacheHits(0);
    status('Image cache cleared — next render fetches fresh', 'info');
  }, [status]);

  // M3 relay-pull, opt-in: only when the user enables "Live Figma selection"
  // in Settings does the mirror subscribe to the Figma companion's live
  // selection (figma:<pairing>, subscribe-only token) — the two-files timeline.
  useEffect(() => {
    if (typeof window === 'undefined' || !liveFigmaSelection) return;
    const pairingId = getOrCreatePairingId();
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;
    void subscribeRelayLive(pairingId, 'figma', 'selection', (payload) => {
      if (cancelled) return;
      const src = payload as { id?: string; name?: string; fileKey?: string };
      if (!src.id) return;
      if (Date.now() - lastManualFigSourceRef.current < 10_000) return;
      const fileKey = src.fileKey?.trim() || 'unknown';
      const name = decodeHtmlEntities(src.name || 'Figma Frame');
      setFigmaNodeInfo({ fileKey, nodeId: src.id, name });
      setFigmaInput(`https://www.figma.com/file/${fileKey}/?node-id=${encodeURIComponent(src.id)}`);
      setFigmaParseError(null);
      status(`Figma: "${name}" selected`, 'info');
    })
      .then((cleanup) => {
        if (cancelled) {
          cleanup();
        } else {
          unsubscribe = cleanup;
        }
      })
      .catch(() => {
        // Companion channel may be empty right now — the detect button
        // still performs an explicit one-shot pull later.
      });
    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, [status, liveFigmaSelection]);

  // Mirrored board state + presence from the plugin.
  useEffect(() => {
    const onBridge = (event: MessageEvent) => {
      const msg = event.data as BridgeMsg | null;
      if (!msg || typeof msg !== 'object' || typeof msg.action !== 'string') return;

      switch (msg.action) {
        case 'figjam-selection': {
          // Selection-driven (Miro): the tab shows ONLY the tracked mirrors
          // selected on the FigJam canvas — empty selection = empty Sync (0),
          // never the full board registry.
          setRawSelectedItems(trackedToSynced(msg.tracked ?? []));
          const foreign = Array.isArray(msg.foreign) ? msg.foreign : [];
          setForeignSelection(
            foreign
              .filter((f: unknown): f is { id: string; name: string } => {
                const row = f as { id?: unknown; name?: unknown };
                return typeof row?.id === 'string' && row.id.length > 0;
              })
              .map((f) => ({ id: f.id, name: String(f.name || '') }))
          );
          break;
        }
        case 'figjam-place-result': {
          if (placeWatchdogRef.current) {
            clearTimeout(placeWatchdogRef.current);
            placeWatchdogRef.current = null;
          }
          setIsSyncing(false);
          if (msg.ok) {
            const displayName = msg.name || msg.key || '';
            setSyncStatus({
              message: msg.created
                ? `✓ Synced ${displayName}`
                : msg.swap
                  ? `✓ Synced ${displayName} — node replaced (old component removed)`
                  : `✓ Updated ${displayName}`,
              type: 'success',
            });
          } else {
            setSyncStatus({ message: msg.error || 'Sync failed', type: 'error' });
          }
          postToPlugin({ action: 'figjam-list' });
          break;
        }
        case 'selection-result': {
          setIsDetectingLocal(false);
          if (msg.error) setSyncStatus({ message: `Selection: ${msg.error}`, type: 'error' });
          else if (msg.data) setSyncStatus({ message: `Detected board node: ${msg.data.name}`, type: 'info' });
          else setSyncStatus({ message: 'Nothing selected on the board', type: 'info' });
          break;
        }
        case 'editor-type': {
          if (msg.editorType !== undefined) {
            setEditorType(String(msg.editorType));
          }
          break;
        }
        default:
          break;
      }
    };

    window.addEventListener('message', onBridge);
    // Kick the initial selection state on open: the plugin replies with
    // figjam-selection for the current canvas selection.
    postToPlugin({ action: 'get-selection-state' });
    return () => window.removeEventListener('message', onBridge);
  }, []);

  // One Figma REST call for MANY nodeIds of the same file (the batch
  // endpoint accepts nodeIds[] — this is the multi-frame sync path, 1 call
  // per file instead of one per frame). Tunes the rolling-window counter +
  // tier from rate headers on ANY response (not only 429s), and retries
  // once after Figma's Retry-After on a 429.
  interface RenderBatchData {
    images?: Record<string, string | null>;
    error?: string;
    retryAfter?: number | null;
    planTier?: string | null;
    limitType?: string | null;
    rateLimit?: number | null;
    rateRemaining?: number | null;
    rateReset?: number | null;
  }
  const renderBatchImages = useCallback(
    async (
      fileKey: string,
      nodeIds: string[],
      format?: 'png' | 'svg',
      scale?: number
    ): Promise<Record<string, string | null>> => {
      const token = tokenRef.current;
      if (!token) throw new Error('Missing Figma connection — connect Figma in Settings.');
      const scaleSafe = scale ?? 1;
      const formatSafe = format ?? 'png';
      const url = '/api/figma/render-batch';
      const body = JSON.stringify({ fileKey, nodeIds, format: formatSafe, scale: scaleSafe });
      const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

      const tune = (data: RenderBatchData): void => {
        // Figma's own budget, when the header rides the response: remaining
        // 0 = the token/file limiter is out — cooldown until the reset
        // instant (X-RateLimit-Reset, epoch seconds) or 60s as fallback.
        if (data.rateRemaining !== undefined && data.rateRemaining !== null) {
          setRateBudget({ remaining: data.rateRemaining, resetAt: data.rateReset ?? null });
          if (data.rateRemaining === 0) {
            const until =
              data.rateReset && Number(data.rateReset) > 0 ? data.rateReset * 1000 : Date.now() + 60_000;
            cooldownUntilRef.current = until;
            setCooldownUntil(until);
          }
        }
        if (data.rateLimit && data.rateLimit > 0 && limitOverrideRef.current === null) {
          windowLimitRef.current = data.rateLimit;
        }
        if (data.planTier && data.planTier.trim()) setFigmaTier(data.planTier.trim());
        // Clear an expired cooldown.
        if (cooldownUntilRef.current && Date.now() >= cooldownUntilRef.current) {
          cooldownUntilRef.current = 0;
          setCooldownUntil(0);
        }
        refreshWindow();
      };

      const attempt = async (): Promise<Record<string, string | null>> => {
        // Rolling-window pacer: hold back until a free 60s slot.
        await waitForRateSlot();
        bumpApiCalls();
        const res = await fetch(url, { method: 'POST', headers, body });
        const data = (await res.json().catch(() => ({}))) as RenderBatchData;
        tune(data);
        if (!res.ok) {
          const errText = data.error || `Render HTTP ${res.status}`;
          // OUR own edge/per-endpoint cap (middleware.ts / withRateLimit
          // return error 'rate_limit_exceeded') — strictly NOT a Figma or
          // a Penpot limit; surface it as such and never arm Figma states.
          if (res.status === 429 && errText.trim() === 'rate_limit_exceeded') {
            const wait = data.retryAfter && data.retryAfter > 0 ? Math.ceil(data.retryAfter) : 10;
            throw new Error(
              `SyncingBoard server is momentarily at its own safety cap (own rate limiter: per-IP or per-pairing) — wait ${wait}s and retry. Neither Figma nor Penpot is limiting.`
            );
          }
          const isRate = res.status === 429;
          if (isRate) {
            const retryAfter = data.retryAfter && data.retryAfter > 0 ? data.retryAfter : 9;
            setRateInfo({
              planTier: String(data.planTier || 'unknown'),
              limitType: String(data.limitType || 'unknown'),
              retryAfter,
            });
            setRateLimited(true);
            window.setTimeout(() => setRateLimited(false), Math.max(retryAfter, 5) * 1000 + 5_000);
            // Engage the session cooldown; the Sync button tapers the
            // countdown. Miro parity: we do NOT auto-retry on a 429 — the
            // action errors out, Figma's Retry-After drives the cooldown.
            const until = Date.now() + (retryAfter + 2) * 1000;
            cooldownUntilRef.current = until;
            setCooldownUntil(until);
            const durationStr = formatDuration(retryAfter);
            throw new Error(
              `Figma is rate-limiting (plan: ${String(data.planTier || 'unknown')}) — the button tapers and re-arms in ~${durationStr}.`
            );
          }
          throw new Error(
            errText.includes('rate_limit_exceeded')
              ? `SyncingBoard server cap briefly hit (error: rate_limit_exceeded) — wait a few seconds and retry.`
              : errText
          );
        }
        if (!data.images) throw new Error('Figma render returned no images.');
        // A plain success means Figma is NOT limiting — clear stale 429
        // telemetry so Settings no longer freezes the last retry line.
        setRateInfo(null);
        setRateLimited(false);
        return data.images;
      };
      return attempt();
    },
    [bumpApiCalls, waitForRateSlot, refreshWindow]
  );

  const renderNode = useCallback(
    async (fileKey: string, nodeId: string, scale?: number, format?: 'png' | 'svg') => {
      const images = await renderBatchImages(fileKey, [nodeId], format, scale);
      const dataUrl = images[nodeId];
      if (!dataUrl) throw new Error('Figma render returned no image for the node.');
      return dataUrl;
    },
    [renderBatchImages]
  );

  const placeOnBoard = useCallback(
    (payload: {
      fileKey: string;
      nodeId: string;
      name: string;
      scale: number;
      dataUrl: string;
      format: 'png' | 'svg';
      platform?: 'figma' | 'penpot';
      nodeIds?: string[];
      forceNodeIds?: string[];
      allCopies?: boolean;
      preserveSize?: boolean;
      width?: number;
      height?: number;
      replace?: boolean;
      placeNew?: boolean;
    }) => {
      setIsSyncing(true);
      // Watchdog: if the plugin never confirms (figjam-place-result), don't
      // leave the UI stuck in "Rendering…" forever — surface it instead.
      if (placeWatchdogRef.current) clearTimeout(placeWatchdogRef.current);
      placeWatchdogRef.current = setTimeout(() => {
        placeWatchdogRef.current = null;
        setIsSyncing(false);
        setSyncStatus({
          message: 'Placement sent but the plugin did not confirm (re-import the plugin; check the plugin console).',
          type: 'error',
        });
      }, 25000);
      postToPlugin({
        // Replace mode reads the plugin's OWN selection — the plugin rewrites
        // whatever nodes are selected right now (tracked mirrors AND foreign
        // images), so the mirror never guesses ids.
        action: payload.replace ? 'figjam-replace' : 'figjam-place',
        requestId: 'fjs-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        payload: {
          fileKey: payload.fileKey,
          nodeId: payload.nodeId,
          name: payload.name,
          format: payload.format,
          platform: payload.platform || 'figma',
          scale: payload.scale,
          dataUrl: payload.dataUrl,
          nodeIds: payload.nodeIds,
          forceNodeIds: payload.forceNodeIds,
          allCopies: payload.allCopies,
          preserveSize: payload.preserveSize,
          width: payload.width,
          height: payload.height,
          placeNew: payload.placeNew,
        },
      });
    },
    []
  );

  // ---- Import (Figma link -> render -> place) ----
  const parseFigmaLink = useCallback(
    async (url: string): Promise<void> => {
      const parsed = parseFigmaUrl(url);
      if (!parsed) {
        setFigmaParseError('Not a Figma frame link — copy the frame share link from Figma (needs ?node-id=…).');
        status('That does not look like a Figma file link', 'error');
        return;
      }
      lastManualFigSourceRef.current = Date.now();
      setFigmaParseError(null);
      setFigmaInput(url);
      const capture: { fileKey: string; nodeId: string; name: string } = {
        fileKey: parsed.fileKey,
        nodeId: parsed.nodeId,
        name: parsed.nodeId,
      };
      if (tokenRef.current) {
        await waitForRateSlot();
        bumpApiCalls();
        try {
          const res = await fetch(
            `/api/figma/node-info?fileKey=${encodeURIComponent(parsed.fileKey)}&nodeId=${encodeURIComponent(parsed.nodeId)}`,
            { headers: { Authorization: 'Bearer ' + tokenRef.current } }
          );
          if (res.ok) {
            const data = (await res.json()) as { name?: string };
            if (data.name) capture.name = data.name;
          }
        } catch {
          // name falls back to nodeId
        }
      }
      setFigmaNodeInfo(capture);
      status('Figma frame ready to place', 'info');
      return;
    },
    [status]
  );

  const importFigmaScreen = useCallback(
    async (format?: 'png' | 'svg', scale?: number) => {
      if (!figmaNodeInfo) {
        status('Paste a Figma file link first', 'error');
        return;
      }
      const safeScale = scale ?? 1;
      const safeFormat = format ?? 'png';
      setIsSyncing(true);
      status(`Rendering ${figmaNodeInfo.name || figmaNodeInfo.nodeId}…`, 'progress');
      try {
        let dataUrl = await cachedFetch(
          `figma|${figmaNodeInfo.fileKey}|${figmaNodeInfo.nodeId}|${safeScale}|${safeFormat}`,
          90_000,
          () => renderNode(figmaNodeInfo.fileKey, figmaNodeInfo.nodeId, safeScale, safeFormat)
        );
        // FigJam rejects SVG images — rasterize in the browser first.
        if (safeFormat === 'svg') {
          dataUrl = await svgToPngDataUrl(dataUrl, safeScale);
        }
        placeOnBoard({
          fileKey: figmaNodeInfo.fileKey,
          nodeId: figmaNodeInfo.nodeId,
          name: figmaNodeInfo.name || 'Unnamed',
          scale: safeScale,
          dataUrl,
          format: safeFormat,
          placeNew: true,
        });
      } catch (err) {
        setIsSyncing(false);
        status(noteError(err), 'error');
      }
    },
    [figmaNodeInfo, cachedFetch, noteError, renderNode, placeOnBoard, status, waitForRateSlot]
  );

  const detectLocalFigmaSelection = useCallback(async () => {
    setIsDetectingLocal(true);
    status('Waiting for the Figma Companion — select a frame in Figma…', 'progress');
    try {
      const pairingId = getOrCreatePairingId();
      if (!pairingId) {
        throw new Error('Pairing ID is not set. Open settings and copy a valid pairing ID first.');
      }
      // M3 relay-pull: ask the Figma design companion (same Pairing ID) for
      // its current selection over the figma:<pairing> channel.
      const data = await callRelay({
        pairingId,
        platform: 'figma',
        action: 'select',
        timeoutMs: 8000,
      });
      const payload = data as { id?: string; name?: string; fileKey?: string } | null;
      if (!payload?.id) {
        throw new Error('No frame currently selected in the Figma file.');
      }
      const fileKey = payload.fileKey?.trim() || 'unknown';
      const nodeId = payload.id;
      const name = decodeHtmlEntities(payload.name || 'Figma Frame');
      lastManualFigSourceRef.current = Date.now();
      setFigmaNodeInfo({ fileKey, nodeId, name });
      setFigmaInput(`https://www.figma.com/file/${fileKey}/?node-id=${encodeURIComponent(nodeId)}`);
      status(`Detected Figma frame: "${name}"`, 'info');
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      status(`Detection failed: ${errMsg} — open the Figma Companion plugin and connect the same Pairing ID.`, 'error');
    } finally {
      setIsDetectingLocal(false);
    }
  }, [status]);

  // ---- Sync all mirrors ----
  // Sync = up to MAX_IMAGES_PER_SYNC distinct frame keys per action (Miro
  // parity — community plans feel render limits hard, so cap the blast
  // radius and let the rest sync on the next press). Frame keys from the
  // SAME Figma file are batched into ONE render request (nodeIds[]): a
  // 3-frame sync of one file costs exactly 1 Figma REST call.
  const syncSelectedScreens = useCallback(async () => {
    const MAX_IMAGES_PER_SYNC = 3;
    const frames = selectedItems.filter((n) => n.fileKey && n.nodeId);
    if (frames.length === 0) {
      status('Nothing selected on the canvas', 'info');
      return;
    }
    const byKey = new Map<string, SyncedImage[]>();
    for (const f of frames) {
      const k = `${f.fileKey}|${f.nodeId}`;
      const list = byKey.get(k) ?? [];
      list.push(f);
      byKey.set(k, list);
    }
    const keys = Array.from(byKey.keys());
    if (keys.length > MAX_IMAGES_PER_SYNC) {
      // Mirrors Miro's useMiroSync defensive throw — the SyncTab button is
      // already disabled (banner) above 3 groups; this guards non-UI paths.
      throw new Error(`Can only sync up to ${MAX_IMAGES_PER_SYNC} different images at once. Deselect some to continue.`);
    }
    status(`Syncing ${keys.length} frame(s)...`, 'progress');
    setIsSyncing(true);
    try {
      // Group by (platform, file, format, scale): same-file Figma frames
      // share ONE batch call; Penpot exports ride the relay (unlimited).
      const groups = new Map<
        string,
        {
          platform: 'figma' | 'penpot';
          fileKey: string;
          format: 'png' | 'svg';
          scale: number;
          entries: { nodeId: string; items: SyncedImage[] }[];
        }
      >();
      for (const key of keys) {
        const items = byKey.get(key) as SyncedImage[];
        const first = items[0];
        const format = (first.format === 'svg' ? 'svg' : 'png') as 'png' | 'svg';
        const scale = first.scale ?? 1;
        const platform = (first.platform ?? 'figma') as 'figma' | 'penpot';
        const groupKey = `${platform}|${first.fileKey}|${format}|${scale}`;
        const existing = groups.get(groupKey);
        if (existing) {
          existing.entries.push({ nodeId: first.nodeId, items });
        } else {
          groups.set(groupKey, {
            platform,
            fileKey: first.fileKey,
            format,
            scale,
            entries: [{ nodeId: first.nodeId, items }],
          });
        }
      }
      for (const group of groups.values()) {
        if (group.platform === 'figma') {
          const nodeIds = group.entries.map((e) => e.nodeId);
          // ONE Figma REST call for the whole file group.
          const images = await cachedFetch(
            `figma-batch|${group.fileKey}|${nodeIds.join('+')}|${group.scale}|${group.format}`,
            90_000,
            () => renderBatchImages(group.fileKey, nodeIds, group.format, group.scale)
          );
          for (const entry of group.entries) {
            let dataUrl = images[entry.nodeId];
            if (!dataUrl) {
              const nameLabel = entry.items[0]?.nodeName || entry.nodeId;
              throw new Error(`Frame "${nameLabel}" (ID: ${entry.nodeId}) was not found in Figma (node ID changed or deleted).`);
            }
            if (group.format === 'svg') {
              dataUrl = await svgToPngDataUrl(dataUrl, group.scale);
            }
            const first = entry.items[0];
            placeOnBoard({
              fileKey: group.fileKey,
              nodeId: entry.nodeId,
              name: first.nodeName || entry.nodeId,
              scale: group.scale,
              format: group.format,
              platform: 'figma',
              dataUrl,
              nodeIds: entry.items.map((it) => it.id).filter((id) => typeof id === 'string' && id.length > 0),
              allCopies: syncAllCopies,
              preserveSize,
            });
          }
        } else {
          // Penpot: export via the relay (not Figma-limited).
          for (const entry of group.entries) {
            const exported = await cachedFetch(
              `penpot|${entry.nodeId}|${group.scale}|${group.format}`,
              120_000,
              () => exportPenpotViaRelay(entry.nodeId, group.format, group.scale)
            );
            let dataUrl = exported.dataUrl;
            if (group.format === 'svg') {
              dataUrl = await svgToPngDataUrl(dataUrl, group.scale, exported.width, exported.height);
            }
            const first = entry.items[0];
            placeOnBoard({
              fileKey: group.fileKey,
              nodeId: entry.nodeId,
              name: first.nodeName || entry.nodeId,
              scale: group.scale,
              format: group.format,
              platform: 'penpot',
              dataUrl,
              nodeIds: entry.items.map((it) => it.id).filter((id) => typeof id === 'string' && id.length > 0),
              allCopies: syncAllCopies,
              preserveSize,
            });
          }
        }
        // Breathing room between file groups (plugin-side ops only) —
        // Figma REST calls are already throttled by the window pacer.
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    } catch (err) {
      setIsSyncing(false);
      status(noteError(err), 'error');
      return;
    }
    // Re-read the selection so the plugin's updated meta (format/scale)
    // round-trips back into the cards.
    postToPlugin({ action: 'get-selection-state' });
  }, [selectedItems, cachedFetch, noteError, renderBatchImages, placeOnBoard, status, preserveSize, syncAllCopies]);


  // ---- Replace a selected board node (Import → Replace Selected) ----
  // The plugin reads the CURRENT canvas selection at message time and
  // replaces those nodes in place — tracked mirrors AND foreign images work
  // identically, with no id round-trip between mirror and plugin.
  const replaceSelectedWidget = useCallback(
    async (
      platform: 'figma' | 'penpot',
      fileKey: string,
      nodeId: string,
      nodeName: string,
      format: 'png' | 'svg',
      scale: number
    ) => {
      if (selectedItems.length === 0 && foreignSelection.length === 0) {
        status('Select a FigJam shape or any image on the canvas to replace it.', 'error');
        return;
      }
      status(`Rendering ${nodeName || nodeId}…`, 'progress');
      setIsSyncing(true);
      try {
        let dataUrl: string;
        if (platform === 'penpot') {
          const exported = await cachedFetch(
            `penpot|${nodeId}|${scale}|${format}`,
            120_000,
            () => exportPenpotViaRelay(nodeId, format, scale)
          );
          dataUrl = exported.dataUrl;
          if (format === 'svg') {
            dataUrl = await svgToPngDataUrl(dataUrl, scale, exported.width, exported.height);
          }
        } else {
          dataUrl = await cachedFetch(
            `figma|${fileKey}|${nodeId}|${scale}|${format}`,
            90_000,
            () => renderNode(fileKey, nodeId, scale, format)
          );
          if (format === 'svg') {
            dataUrl = await svgToPngDataUrl(dataUrl, scale);
          }
        }
        placeOnBoard({
          fileKey,
          nodeId,
          name: nodeName || nodeId,
          scale,
          dataUrl,
          format,
          platform,
          preserveSize,
          replace: true,
        });
      } catch (err) {
        setIsSyncing(false);
        status(noteError(err), 'error');
      }
    },
    [selectedItems, foreignSelection, cachedFetch, noteError, renderNode, placeOnBoard, status, preserveSize, setIsSyncing]
  );

  // ---- Group setting changes (format/scale on the Sync cards) ----
  // Persist to the plugin nodes via figjam-set-meta; propagate extends to
  // sibling copies of the same frame key.
  const applyGroupSettings = useCallback(
    (itemIds: string[], key: 'format' | 'scale', value: unknown) => {
      const ids = itemIds.filter((id) => typeof id === 'string' && id.length > 0);
      if (ids.length === 0) return;
      const payload: Record<string, unknown> = { action: 'figjam-set-meta', nodeIds: ids };
      if (key === 'format') {
        const fmt = String(value);
        payload.format = fmt === 'svg' ? 'svg' : 'png';
      } else {
        const num = Number(value);
        if (Number.isFinite(num) && num > 0) payload.scale = num;
      }
      payload.propagate = propagate;
      postToPlugin(payload);
      // Optimistic card update.
      setRawSelectedItems((prev) =>
        prev.map((it) =>
          ids.includes(it.id)
            ? {
                ...it,
                format: payload.format ? (payload.format as 'png' | 'svg') : it.format,
                scale: payload.scale ? Number(payload.scale) : it.scale,
              }
            : it
        )
      );
    },
    [propagate]
  );

  // ---- Penpot (detect via the Penpot Companion relay) ----
  const detectLocalPenpotSelection = useCallback(async () => {
    setIsDetectingPenpotLocal(true);
    status('Waiting for the Penpot Companion — select a frame in Penpot…', 'progress');
    try {
      const pairingId = getOrCreatePairingId();
      if (!pairingId) {
        throw new Error('Pairing ID is not set. Open settings and copy a valid pairing ID first.');
      }
      const data = await callRelay({
        pairingId,
        platform: 'penpot',
        action: 'select',
        timeoutMs: 8000,
      });
      const payload = data as { id?: string; name?: string; fileId?: string } | null;
      if (!payload?.id) {
        throw new Error('No frame currently selected in Penpot.');
      }

      const fileId = payload.fileId || 'unknown-file';
      const nodeName = payload.name ? decodeHtmlEntities(payload.name) : 'Penpot Frame';

      setPenpotNodeInfo({
        fileId,
        objectId: payload.id,
        name: nodeName,
      });
      status(`Detected Penpot frame: "${payload.name || payload.id}"`, 'info');
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      status(`Detection failed: ${errMsg} (Tip: open the Penpot Companion and connect the same Pairing ID.)`, 'error');
    } finally {
      setIsDetectingPenpotLocal(false);
    }
  }, [status]);

  const importPenpotScreen = useCallback(
    async (format: 'png' | 'svg' = 'svg', scale: number = 1) => {
      if (!penpotNodeInfo) {
        status('Detect a Penpot frame first', 'error');
        return;
      }
      setIsSyncing(true);
      status('Waiting for the Penpot Companion (open it on the same Pairing ID)…', 'progress');
      try {
        const exported = await cachedFetch(
          `penpot|${penpotNodeInfo.objectId}|${scale}|${format}`,
          120_000,
          () => exportPenpotViaRelay(penpotNodeInfo.objectId, format, scale)
        );
        const responseName = exported.name;
        if (responseName && responseName !== 'Selected Frame') {
          setPenpotNodeInfo((prev) => (prev ? { ...prev, name: responseName } : prev));
        }
        let dataUrl = exported.dataUrl;
        // FigJam rejects SVG images — rasterize in the browser first.
        if (format === 'svg') {
          dataUrl = await svgToPngDataUrl(dataUrl, scale, exported.width, exported.height);
        }
        const naturalWidth = exported.width && exported.width > 0 ? Math.round(exported.width * scale) : 0;
        const naturalHeight =
          exported.height && exported.height > 0 ? Math.round(exported.height * scale) : 0;
        const resolvedName =
          (responseName && responseName !== 'Selected Frame' ? responseName : penpotNodeInfo.name) ||
          'Penpot Frame';
        status(`Rendering ${resolvedName}…`, 'progress');
        placeOnBoard({
          fileKey: penpotNodeInfo.fileId,
          nodeId: penpotNodeInfo.objectId,
          name: resolvedName,
          scale,
          format,
          platform: 'penpot',
          dataUrl,
          width: naturalWidth || undefined,
          height: naturalHeight || undefined,
          preserveSize,
          placeNew: true,
        });
      } catch (err: unknown) {
        setIsSyncing(false);
        const errMsg = noteError(err);
        status(`${errMsg} — open the Penpot Companion window and re-try.`, 'error');
      }
    },
    [penpotNodeInfo, cachedFetch, noteError, placeOnBoard, status, preserveSize]
  );

  const pairingId = getOrCreatePairingId();

  const resetImportState = useCallback(() => {
    setFigmaNodeInfo(null);
    setPenpotNodeInfo(null);
    setFigmaInput('');
    setFigmaParseError(null);
  }, []);

  return {
    isInitMode: false,
    editorType,
    figmaToken,
    miroToken: null,
    tokensLoading,
    selectedItems,
    rawSelectedItems,
    deselectedIds,
    handleDeselectGroup,
    handleClearDeselected,
    setSelectedItems: setRawSelectedItems,
    isSyncing,
    syncStatus,
    figmaParseError,
    figmaInput,
    figmaNodeInfo,
    isDetectingLocal,
    connectFigma,
    connectMiro: () => {},
    disconnectFigma,
    disconnectMiro: async (): Promise<void> => undefined,
    parseFigmaLink,
    detectLocalFigmaSelection,
    importFigmaScreen,
    penpotNodeInfo,
    isDetectingPenpotLocal,
    detectLocalPenpotSelection,
    importPenpotScreen,
    syncSelectedScreens,
    syncAllCopies,
    setSyncAllCopies,
    preserveSize,
    setPreserveSize,
    propagate,
    setPropagate,
    applyGroupSettings,
    cooldownSeconds,
    isAnyImageSelected: selectedItems.length > 0 || foreignSelection.length > 0,
    replaceSelectedWidget,
    pairingId,
    liveFigmaSelection,
    setLiveFigmaSelection,
    rateLimited,
    figmaApiCalls,
    figmaCacheHits,
    rateInfo,
    rateWindow,
    figmaTier,
    figmaIsCommunity,
    limitOverride,
    setFigmaWindowOverride,
    cooldownUntil,
    rateBudget,
    resetRenderCache,
    resetImportState,
  } as const;
}