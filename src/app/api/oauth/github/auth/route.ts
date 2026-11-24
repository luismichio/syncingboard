import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

export async function GET(request: NextRequest) {
  const githubClientId = process.env.GITHUB_CLIENT_ID;
  let host = request.headers.get('host') || 'localhost:3000';
  if (host === 'syncingboard.com') host = 'www.syncingboard.com';
  const protocol = request.headers.get('x-forwarded-proto') || (host.includes('localhost') ? 'http' : 'https');
  const appUrl = `${protocol}://${host}`;
  const redirectUri = `${appUrl}/api/oauth/github/callback`;

  if (!githubClientId) {
    return new NextResponse(
      `<!DOCTYPE html>
<html>
<head>
  <title>GitHub OAuth Setup Required</title>
  <style>
    body { font-family: sans-serif; background: #0A0A0A; color: #FAF9F5; padding: 40px; margin: 0; }
    h2 { margin-top: 0; }
    p { color: #9A9997; line-height: 1.5; }
  </style>
</head>
<body>
  <h2>GITHUB_CLIENT_ID is missing</h2>
  <p>Set <strong>GITHUB_CLIENT_ID</strong> and <strong>GITHUB_CLIENT_SECRET</strong> in your deployment environment to enable GitHub OAuth (or paste a Personal Access Token in Import → DOCS).</p>
</body>
</html>`,
      { headers: { 'Content-Type': 'text/html' }, status: 500 }
    );
  }

  const { searchParams } = new URL(request.url);
  const state = searchParams.get('state') || crypto.randomBytes(16).toString('hex');

  // Supports both GitHub Apps (fine-grained Contents: Read) and classic OAuth Apps (repo scope)
  const scope = process.env.GITHUB_OAUTH_SCOPE ?? 'repo';
  const scopeParam = scope.trim() ? `&scope=${encodeURIComponent(scope.trim())}` : '';
  const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(
    githubClientId
  )}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}${scopeParam}`;

  const response = NextResponse.redirect(authUrl);
  response.cookies.set('github_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 300,
    path: '/',
  });

  return response;
}
