/**
 * Hybrid batch limit evaluation for SyncingBoard.
 * - Cloud users (useTauri === false): max 3 unique items total (protects Vercel/Ably/Upstash quotas).
 * - Local Tauri users (useTauri === true):
 *     - Figma items: up to 50 unique items (runs locally via Tauri + within Miro's ~90–200/min credit budget).
 *     - Penpot items: max 3 unique items (Penpot still routes over Cloud Ably Relay).
 */

export const CLOUD_BATCH_LIMIT = 3;
export const LOCAL_FIGMA_BATCH_LIMIT = 50;
export const PENPOT_BATCH_LIMIT = 3;

export interface BatchGroupLike {
  platform?: 'figma' | 'penpot';
}

export interface BatchLimitResult {
  blocked: boolean;
  reason: string | null;
  figmaCount: number;
  penpotCount: number;
  totalCount: number;
}

export function evaluateBatchLimits(
  groups: readonly BatchGroupLike[],
  useTauri: boolean
): BatchLimitResult {
  let figmaCount = 0;
  let penpotCount = 0;

  for (const g of groups) {
    if (g.platform === 'penpot') {
      penpotCount += 1;
    } else {
      figmaCount += 1;
    }
  }

  const totalCount = figmaCount + penpotCount;

  if (!useTauri) {
    if (totalCount > CLOUD_BATCH_LIMIT) {
      return {
        blocked: true,
        reason: `Only ${CLOUD_BATCH_LIMIT} items can be synced at once. Deselect some to continue.`,
        figmaCount,
        penpotCount,
        totalCount,
      };
    }
    return { blocked: false, reason: null, figmaCount, penpotCount, totalCount };
  }

  if (penpotCount > PENPOT_BATCH_LIMIT) {
    const excess = penpotCount - PENPOT_BATCH_LIMIT;
    return {
      blocked: true,
      reason: `Max ${PENPOT_BATCH_LIMIT} Penpot items per cloud sync — dismiss ${excess} Penpot ${excess === 1 ? 'card' : 'cards'} to continue.`,
      figmaCount,
      penpotCount,
      totalCount,
    };
  }

  if (figmaCount > LOCAL_FIGMA_BATCH_LIMIT) {
    const excess = figmaCount - LOCAL_FIGMA_BATCH_LIMIT;
    return {
      blocked: true,
      reason: `Max ${LOCAL_FIGMA_BATCH_LIMIT} Figma items per local sync — dismiss ${excess} Figma ${excess === 1 ? 'card' : 'cards'} to continue.`,
      figmaCount,
      penpotCount,
      totalCount,
    };
  }

  return { blocked: false, reason: null, figmaCount, penpotCount, totalCount };
}
