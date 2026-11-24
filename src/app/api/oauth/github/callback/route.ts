import { NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/rate-limit';

function getCookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      const raw = trimmed.slice(name.length + 1);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return undefined;
}

const HTML_HEAD = `
<head>
  <title>GitHub Connection</title>
  <script>
    (function() {
      const savedTheme = localStorage.getItem('theme');
      let isDark = true;
      if (savedTheme === 'light') isDark = false;
      else if (savedTheme === 'dark') isDark = true;
      else isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const root = document.documentElement;
      if (isDark) {
        root.style.setProperty('--bg-page', '#0A0A0A');
        root.style.setProperty('--text-page', '#FAF9F5');
        root.style.setProperty('--text-muted', '#9A9997');
        root.style.setProperty('--accent', '#01C8F1');
        root.style.setProperty('--text-error', '#FFA27D');
      } else {
        root.style.setProperty('--bg-page', '#FAF9F5');
        root.style.setProperty('--text-page', '#0A0A0A');
        root.style.setProperty('--text-muted', '#5E5E5E');
        root.style.setProperty('--accent', '#00A2C9');
        root.style.setProperty('--text-error', '#D32F2F');
      }
    })();
  </script>
  <style>
    body { font-family: sans-serif; background: var(--bg-page); color: var(--text-page); text-align: center; padding: 40px; margin: 0; }
    .container { max-width: 480px; margin: 0 auto; }
    p { color: var(--text-muted); font-size: 14px; line-height: 1.5; }
    .error-msg { color: var(--text-error); font-weight: 500; }
    button { padding: 8px 16px; cursor: pointer; border-radius: 6px; border: none; background: var(--accent); color: var(--bg-page); font-weight: 600; margin-top: 12px; }
  </style>
</head>`;

function escapeHtml(raw: string): string {
  return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function handleGet(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');
  const storedState = getCookieValue(request, 'github_oauth_state');

  if (error) {
    return new NextResponse(
      `<!DOCTYPE html><html>${HTML_HEAD}<body><div class="container"><h3>GitHub Authorization Declined</h3><p class="error-msg">${escapeHtml(error)}</p><button onclick="window.close()">Close</button></div></body></html>`,
      { headers: { 'Content-Type': 'text/html' }, status: 400 }
    );
  }

  if (!code || !state || (storedState && storedState !== state)) {
    return new NextResponse(
      `<!DOCTYPE html><html>${HTML_HEAD}<body><div class="container"><h3>Invalid OAuth State</h3><p class="error-msg">Missing authorization code or mismatched state parameter.</p><button onclick="window.close()">Close</button></div></body></html>`,
      { headers: { 'Content-Type': 'text/html' }, status: 400 }
    );
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return new NextResponse(
      `<!DOCTYPE html><html>${HTML_HEAD}<body><div class="container"><h3>Server Configuration Missing</h3><p class="error-msg">GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET is not configured.</p></div></body></html>`,
      { headers: { 'Content-Type': 'text/html' }, status: 500 }
    );
  }

  let host = request.headers.get('host') || 'localhost:3000';
  if (host === 'syncingboard.com') host = 'www.syncingboard.com';
  const protocol = request.headers.get('x-forwarded-proto') || (host.includes('localhost') ? 'http' : 'https');
  const appUrl = `${protocol}://${host}`;
  const redirectUri = `${appUrl}/api/oauth/github/callback`;

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!tokenRes.ok || !tokenData.access_token) {
      const msg = tokenData.error_description || tokenData.error || 'Token exchange failed';
      return new NextResponse(
        `<!DOCTYPE html><html>${HTML_HEAD}<body><div class="container"><h3>GitHub Connection Failed</h3><p class="error-msg">${escapeHtml(msg)}</p><button onclick="window.close()">Close</button></div></body></html>`,
        { headers: { 'Content-Type': 'text/html' }, status: 400 }
      );
    }

    // Classic GitHub OAuth tokens do not expire (default 30d local TTL); GitHub Apps return expires_in
    const expiresInSec = typeof tokenData.expires_in === 'number' && tokenData.expires_in > 0
      ? tokenData.expires_in
      : 30 * 24 * 3600;

    const tokenPayload = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || '',
      expiresAt: Date.now() + expiresInSec * 1000,
    };

    // Store ephemerally in /api/oauth/store for stateless iframe polling
    try {
      await fetch(`${appUrl}/api/oauth/store`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, tokens: tokenPayload }),
      });
    } catch {
      // BroadcastChannel + postMessage fallback below still delivers tokens
    }

    const safePayloadJson = JSON.stringify(tokenPayload).replace(/</g, '\\u003c');
    const html = `<!DOCTYPE html>
<html>
${HTML_HEAD}
<body>
  <div class="container">
    <h2>GitHub Connected</h2>
    <p>You can close this window and return to SyncingBoard.</p>
    <button onclick="window.close()">Close Window</button>
  </div>
  <script>
    (function() {
      const tokens = ${safePayloadJson};
      try {
        const bc = new BroadcastChannel('syncingboard_oauth');
        bc.postMessage({ type: 'GITHUB_AUTH_SUCCESS', tokens });
        bc.close();
      } catch (e) {}
      try {
        if (window.opener) {
          window.opener.postMessage({ type: 'GITHUB_AUTH_SUCCESS', tokens }, window.location.origin);
        }
      } catch (e) {}
      setTimeout(() => { try { window.close(); } catch (e) {} }, 800);
    })();
  </script>
</body>
</html>`;

    const response = new NextResponse(html, { headers: { 'Content-Type': 'text/html' } });
    response.cookies.delete('github_oauth_state');
    return response;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unexpected OAuth error';
    return new NextResponse(
      `<!DOCTYPE html><html>${HTML_HEAD}<body><div class="container"><h3>GitHub Connection Error</h3><p class="error-msg">${escapeHtml(msg)}</p><button onclick="window.close()">Close</button></div></body></html>`,
      { headers: { 'Content-Type': 'text/html' }, status: 500 }
    );
  }
}

export const GET = withRateLimit({ endpoint: 'oauth:callback' })(handleGet);
