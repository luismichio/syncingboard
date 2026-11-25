import { NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

interface GitHubBranchItem {
  name?: unknown;
}

async function handler(request: Request) {
  const { searchParams } = new URL(request.url);
  const owner = (searchParams.get('owner') || '').trim();
  const repo = (searchParams.get('repo') || '').trim();

  const isInvalid = (seg: string) =>
    !seg || !SAFE_SEGMENT.test(seg) || seg === '.' || seg === '..' || seg.includes('..');

  if (isInvalid(owner) || isInvalid(repo)) {
    return NextResponse.json(
      { error: 'Invalid owner or repo parameter.' },
      { status: 400 }
    );
  }

  const authHeader = request.headers.get('authorization');
  const ghHeaders: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'SyncingBoard-DocsSync',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (authHeader && /^Bearer\s+\S+$/i.test(authHeader.trim())) {
    ghHeaders.Authorization = authHeader.trim();
  }

  try {
    const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`;
    const res = await fetch(apiUrl, {
      method: 'GET',
      headers: ghHeaders,
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });

    if (!res.ok) {
      const status = res.status === 404 ? 404 : res.status === 401 || res.status === 403 ? res.status : 502;
      return NextResponse.json(
        { error: `Could not load branches (GitHub HTTP ${res.status}).` },
        { status }
      );
    }

    const raw = (await res.json()) as unknown;
    const list = Array.isArray(raw) ? (raw as GitHubBranchItem[]) : [];
    const branches = list
      .map((b) => (typeof b?.name === 'string' ? b.name : ''))
      .filter((name) => name.length > 0);

    return NextResponse.json({ owner, repo, branches });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch branches from GitHub';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

export const GET = withRateLimit({ endpoint: 'github:markdown' })(handler);
