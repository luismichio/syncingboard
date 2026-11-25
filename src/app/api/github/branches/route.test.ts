import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/rate-limit', () => ({
  withRateLimit: () => (fn: (req: Request) => Promise<Response>) => fn,
}));

import { GET } from './route';

describe('GET /api/github/branches', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rejects missing or path-traversal owner/repo with 400', async () => {
    const res1 = await GET(new Request('http://localhost:3000/api/github/branches?owner=..&repo=test'));
    expect(res1.status).toBe(400);

    const res2 = await GET(new Request('http://localhost:3000/api/github/branches?owner=org/evil&repo=test'));
    expect(res2.status).toBe(400);
  });

  it('returns branch names and forwards Bearer token', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify([{ name: 'main' }, { name: 'dev' }, { name: 'feat/docs' }]), {
        status: 200,
      })
    );
    globalThis.fetch = fetchMock;

    const req = new Request('http://localhost:3000/api/github/branches?owner=org&repo=repo', {
      headers: { Authorization: 'Bearer ghu_abc' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { owner: string; repo: string; branches: string[] };
    expect(body).toEqual({ owner: 'org', repo: 'repo', branches: ['main', 'dev', 'feat/docs'] });

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe('Bearer ghu_abc');
  });

  it('propagates 404 when repo is not found or inaccessible', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch;

    const res = await GET(new Request('http://localhost:3000/api/github/branches?owner=org&repo=secret'));
    expect(res.status).toBe(404);
  });
});
