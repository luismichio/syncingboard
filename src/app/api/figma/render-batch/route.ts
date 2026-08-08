import { NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/rate-limit';

const FILE_KEY_RE = /^[A-Za-z0-9_-]{3,128}$/;
const NODE_ID_RE = /^[A-Za-z0-9:_-]{1,128}$/;
const MAX_NODE_IDS = 50;

interface RenderBatchBody {
  fileKey: string;
  nodeIds: string[];
  format?: 'png' | 'svg';
  scale?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Figma's rate-limit headers are case-insensitive and may use several
// spellings (X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset
// per their docs; X-Figma-* appear on 429s). Read the candidates safely.
function collectRateHeaders(headers: Headers): {
  limit: number | null;
  remaining: number | null;
  reset: number | null;
  retryAfter: number | null;
  planTier: string | null;
  limitType: string | null;
} {
  const num = (values: Array<string | null>): number | null => {
    for (const v of values) {
      if (v) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    }
    return null;
  };
  const str = (values: Array<string | null>): string | null => {
    for (const v of values) {
      if (v && v.trim().length > 0) return v.trim();
    }
    return null;
  };
  const get = (name: string): string | null => headers.get(name);
  return {
    limit: num([get('x-ratelimit-limit'), get('x-figma-limit')]),
    remaining: num([get('x-ratelimit-remaining'), get('x-figma-remaining')]),
    reset: num([get('x-ratelimit-reset')]),
    retryAfter: num([get('retry-after')]),
    planTier: str([get('x-figma-plan-tier')]),
    limitType: str([get('x-figma-rate-limit-type')]),
  };
}

function normalizeRequestBody(raw: unknown): RenderBatchBody | null {
  if (!isRecord(raw)) return null;

  const fileKey = typeof raw.fileKey === 'string' ? raw.fileKey.trim() : '';
  const nodeIdsRaw = Array.isArray(raw.nodeIds) ? raw.nodeIds : [];
  const formatRaw = raw.format;
  const scaleRaw = raw.scale;

  if (!FILE_KEY_RE.test(fileKey)) return null;
  if (nodeIdsRaw.length === 0 || nodeIdsRaw.length > MAX_NODE_IDS) return null;

  const nodeIds: string[] = [];
  for (const value of nodeIdsRaw) {
    if (typeof value !== 'string') return null;
    const nodeId = value.trim();
    if (!NODE_ID_RE.test(nodeId)) return null;
    nodeIds.push(nodeId);
  }

  const format: 'png' | 'svg' = formatRaw === 'svg' ? 'svg' : 'png';

  let scale = 2;
  if (scaleRaw !== undefined) {
    if (typeof scaleRaw !== 'number' || !Number.isFinite(scaleRaw)) return null;
    if (scaleRaw < 1 || scaleRaw > 4) return null;
    scale = scaleRaw;
  }

  return {
    fileKey,
    nodeIds,
    format,
    scale,
  };
}

/**
 * POST /api/figma/render-batch
 *
 * Accepts multiple nodeIds from the same file and fetches their renders
 * in a SINGLE Figma API call, dramatically reducing quota consumption.
 * Supports dynamic format and scale selection per batch group.
 *
 * Body: { fileKey, nodeIds: string[], format?: string, scale?: number }
 * Auth: token via Authorization: Bearer <figmaToken> (not in body)
 * Returns: { images: { [nodeId]: dataUrl } }
 */
async function handler(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization') || '';
    const figmaToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    const bodyRaw: unknown = await request.json();

    const body = normalizeRequestBody(bodyRaw);

    if (!figmaToken || !body) {
      return NextResponse.json(
        { error: 'Missing or invalid parameters: Authorization token, fileKey, nodeIds[]' },
        { status: 400 }
      );
    }

    const { fileKey, nodeIds, format, scale } = body;

    const idsParam = nodeIds.join(',');
    const scaleQuery = format === 'svg' ? '' : `&scale=${scale}`;
    const figmaApiUrl = `https://api.figma.com/v1/images/${fileKey}?ids=${idsParam}${scaleQuery}&format=${format}`;

    const figmaResponse = await fetch(figmaApiUrl, {
      headers: { Authorization: `Bearer ${figmaToken}` },
    });

    const figmaDataUnknown: unknown = await figmaResponse.json().catch(() => ({}));
    const figmaData = isRecord(figmaDataUnknown) ? figmaDataUnknown : {};

    // Figma's rate-limit headers (per developers.figma.com/docs/rest-api/
    // rate-limits/) may arrive on ANY response, not only 429s. Forward them
    // so the mirror can auto-tune its rolling-window counter (10/min on Pro).
    const rateHeaders = collectRateHeaders(figmaResponse.headers);

    if (!figmaResponse.ok) {
      const errText = typeof figmaData.err === 'string'
        ? figmaData.err
        : typeof figmaData.message === 'string'
          ? figmaData.message
          : 'Rate limit exceeded';

      return NextResponse.json(
        {
          error: errText,
          retryAfter: rateHeaders.retryAfter ?? null,
          planTier: rateHeaders.planTier ?? null,
          limitType: rateHeaders.limitType ?? null,
          rateLimit: rateHeaders.limit ?? null,
          rateRemaining: rateHeaders.remaining ?? null,
        },
        { status: figmaResponse.status }
      );
    }

    const imageUrlsRaw = isRecord(figmaData.images) ? figmaData.images : {};
    const mimePrefix = format === 'svg' ? 'data:image/svg+xml;base64,' : 'data:image/png;base64,';

    const entries = await Promise.all(
      nodeIds.map(async (nodeId) => {
        const value = imageUrlsRaw[nodeId];
        const s3Url = typeof value === 'string' ? value : null;

        if (!s3Url) {
          return [nodeId, null] as [string, null];
        }

        try {
          const imgRes = await fetch(s3Url);
          if (!imgRes.ok) return [nodeId, null] as [string, null];

          const arrayBuffer = await imgRes.arrayBuffer();
          const base64 = Buffer.from(arrayBuffer).toString('base64');
          return [nodeId, `${mimePrefix}${base64}`] as [string, string];
        } catch {
          return [nodeId, null] as [string, null];
        }
      })
    );

    const images: Record<string, string | null> = Object.fromEntries(entries);
    return NextResponse.json({ images });
  } catch {
    return NextResponse.json({ error: 'Internal server error during batch rendering' }, { status: 500 });
  }
}

export const POST = withRateLimit({ endpoint: 'figma:render-batch' })(handler);
