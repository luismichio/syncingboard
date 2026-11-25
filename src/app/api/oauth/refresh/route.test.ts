import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/rate-limit', () => ({
  withRateLimit: () => (fn: (req: Request) => Promise<Response>) => fn,
}));

import { POST } from './route';

describe('POST /api/oauth/refresh', () => {
  const originalFetch = globalThis.fetch;
  const prevGhId = process.env.GITHUB_CLIENT_ID;
  const prevGhSecret = process.env.GITHUB_CLIENT_SECRET;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.GITHUB_CLIENT_ID = 'Iv23liTest';
    process.env.GITHUB_CLIENT_SECRET = 'gh_secret';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (prevGhId === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = prevGhId;
    if (prevGhSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
    else process.env.GITHUB_CLIENT_SECRET = prevGhSecret;
  });

  it('rejects unknown platform or missing refresh token with 400', async () => {
    const res = await POST(
      new Request('http://localhost:3000/api/oauth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Refresh-Token': 'rt_123' },
        body: JSON.stringify({ platform: 'unknown' }),
      })
    );
    expect(res.status).toBe(400);
  });

  it('refreshes GitHub App expiring user tokens via github.com/login/oauth/access_token', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          access_token: 'ghu_new_access',
          refresh_token: 'ghr_new_refresh',
          expires_in: 28800,
        }),
        { status: 200 }
      )
    );
    globalThis.fetch = fetchMock;

    const res = await POST(
      new Request('http://localhost:3000/api/oauth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Refresh-Token': 'ghr_old_refresh' },
        body: JSON.stringify({ platform: 'github' }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
    };
    expect(body.accessToken).toBe('ghu_new_access');
    expect(body.refreshToken).toBe('ghr_new_refresh');
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('returns 401 when GitHub responds with an OAuth error JSON payload', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' }),
        { status: 200 }
      )
    );

    const res = await POST(
      new Request('http://localhost:3000/api/oauth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Refresh-Token': 'ghr_expired' },
        body: JSON.stringify({ platform: 'github' }),
      })
    );
    expect(res.status).toBe(401);
  });
});
