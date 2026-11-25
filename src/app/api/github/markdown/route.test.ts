import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/rate-limit', () => ({
  withRateLimit: () => (fn: (req: Request) => Promise<Response>) => fn,
}));

import { GET } from './route';

describe('GET /api/github/markdown', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rejects invalid / non-GitHub URLs with 400', async () => {
    const req = new Request('http://localhost:3000/api/github/markdown?url=https://evil.example.com/a.md');
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it('returns 304 Not Modified when upstream ETag matches', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 304 }));
    globalThis.fetch = fetchMock;

    const req = new Request(
      'http://localhost:3000/api/github/markdown?url=https://github.com/org/repo/blob/main/README.md',
      { headers: { 'If-None-Match': 'W/"etag-123"' } }
    );
    const res = await GET(req);
    expect(res.status).toBe(304);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callInit = fetchMock.mock.calls[0]?.[1];
    const headers = callInit?.headers as Record<string, string> | undefined;
    expect(headers?.['If-None-Match']).toBe('W/"etag-123"');
  });

  it('applies branch override, forwards Bearer token, and parses sections', async () => {
    const md = '# Intro\n\nHello **world**\n\n## Setup\n\nRun `yarn dev`';
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(md, {
          status: 200,
          headers: { etag: 'W/"abc"' },
        })
    );
    globalThis.fetch = fetchMock;

    const req = new Request(
      'http://localhost:3000/api/github/markdown?url=https://github.com/org/repo/blob/main/README.md&branch=feat/docs-sync',
      { headers: { Authorization: 'Bearer ghu_test_token' } }
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      branch: string;
      canonicalUrl: string;
      etag: string;
      sections: { id: string; title: string }[];
    };
    expect(body.branch).toBe('feat/docs-sync');
    expect(body.canonicalUrl).toBe('https://github.com/org/repo/blob/feat/docs-sync/README.md');
    expect(body.etag).toBe('W/"abc"');
    expect(body.sections.map((s) => s.id)).toEqual(['intro', 'setup']);

    const upstreamUrl = String(fetchMock.mock.calls[0]?.[0] ?? '');
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(upstreamUrl).toContain('ref=feat%2Fdocs-sync');
    expect(headers?.Authorization).toBe('Bearer ghu_test_token');
  });

  it('returns 413 when Markdown payload exceeds 512 KB', async () => {
    const huge = 'a'.repeat(513 * 1024);
    globalThis.fetch = vi.fn(async () => new Response(huge, { status: 200 })) as unknown as typeof fetch;

    const req = new Request(
      'http://localhost:3000/api/github/markdown?url=https://github.com/org/repo/blob/main/BIG.md'
    );
    const res = await GET(req);
    expect(res.status).toBe(413);
  });

  it('returns 404 with private-repo GitHub App / PAT hint', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch;

    const req = new Request(
      'http://localhost:3000/api/github/markdown?url=https://github.com/org/private/blob/main/README.md'
    );
    const res = await GET(req);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('GitHub App');
  });
});
