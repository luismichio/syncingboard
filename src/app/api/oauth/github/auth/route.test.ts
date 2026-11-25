import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

describe('GET /api/oauth/github/auth', () => {
  const prevClientId = process.env.GITHUB_CLIENT_ID;
  const prevScope = process.env.GITHUB_OAUTH_SCOPE;

  beforeEach(() => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_OAUTH_SCOPE;
  });

  afterEach(() => {
    if (prevClientId === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = prevClientId;
    if (prevScope === undefined) delete process.env.GITHUB_OAUTH_SCOPE;
    else process.env.GITHUB_OAUTH_SCOPE = prevScope;
  });

  it('returns 500 HTML notice when GITHUB_CLIENT_ID is missing', async () => {
    const req = new NextRequest('http://localhost:3000/api/oauth/github/auth?state=test_state');
    const res = await GET(req);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain('GITHUB_CLIENT_ID is missing');
  });

  it('redirects to GitHub authorize with default repo scope and sets state cookie', async () => {
    process.env.GITHUB_CLIENT_ID = 'Iv23liTestClient';
    const req = new NextRequest('http://localhost:3000/api/oauth/github/auth?state=gh_12345', {
      headers: { host: 'localhost:3000' },
    });
    const res = await GET(req);
    expect(res.status).toBe(307);
    const loc = res.headers.get('location') || '';
    expect(loc).toContain('https://github.com/login/oauth/authorize');
    expect(loc).toContain('client_id=Iv23liTestClient');
    expect(loc).toContain('state=gh_12345');
    expect(loc).toContain('scope=repo');
    expect(res.cookies.get('github_oauth_state')?.value).toBe('gh_12345');
  });

  it('omits scope parameter when GITHUB_OAUTH_SCOPE is empty (GitHub App read-only)', async () => {
    process.env.GITHUB_CLIENT_ID = 'Iv23liTestClient';
    process.env.GITHUB_OAUTH_SCOPE = '';
    const req = new NextRequest('https://dev-test.protokoba.com/api/oauth/github/auth?state=gh_app', {
      headers: { host: 'dev-test.protokoba.com', 'x-forwarded-proto': 'https' },
    });
    const res = await GET(req);
    expect(res.status).toBe(307);
    const loc = res.headers.get('location') || '';
    expect(loc).not.toContain('scope=');
    expect(loc).toContain(
      encodeURIComponent('https://dev-test.protokoba.com/api/oauth/github/callback')
    );
  });
});
