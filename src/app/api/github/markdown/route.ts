import { NextResponse } from 'next/server';
import {
  computeContentHash,
  extractLineRange,
  parseGitHubMarkdownUrl,
  parseMarkdownSections,
} from '@/lib/sync/markdownParser';
import { withRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const MAX_MARKDOWN_BYTES = 512 * 1024; // 512 KB safety cap

async function handler(request: Request) {
  const urlParam = new URL(request.url).searchParams.get('url') || '';
  const parsed = parseGitHubMarkdownUrl(urlParam);
  if (!parsed) {
    return NextResponse.json(
      { error: 'Invalid GitHub Markdown URL. Expected https://github.com/owner/repo/blob/branch/file.md' },
      { status: 400 }
    );
  }

  const authHeader = request.headers.get('authorization');
  const ifNoneMatch = request.headers.get('if-none-match');

  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/contents/${parsed.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(parsed.branch)}`;

  const ghHeaders: Record<string, string> = {
    Accept: 'application/vnd.github.raw+json',
    'User-Agent': 'SyncingBoard-DocsSync',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (authHeader && /^Bearer\s+\S+$/i.test(authHeader.trim())) {
    ghHeaders.Authorization = authHeader.trim();
  }
  if (ifNoneMatch) {
    ghHeaders['If-None-Match'] = ifNoneMatch;
  }

  try {
    const res = await fetch(apiUrl, {
      method: 'GET',
      headers: ghHeaders,
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });

    if (res.status === 304) {
      return new NextResponse(null, { status: 304 });
    }

    if (!res.ok) {
      const status = res.status === 404 ? 404 : res.status === 401 || res.status === 403 ? res.status : 502;
      const hint =
        res.status === 404
          ? 'File not found on GitHub (if private repo, provide a GitHub Personal Access Token).'
          : res.status === 401 || res.status === 403
            ? 'GitHub denied access (check your token permissions or rate limit).'
            : `GitHub API returned HTTP ${res.status}.`;
      return NextResponse.json({ error: hint }, { status });
    }

    const rawText = await res.text();
    if (rawText.length > MAX_MARKDOWN_BYTES) {
      return NextResponse.json(
        { error: 'Markdown file exceeds 512 KB limit.' },
        { status: 413 }
      );
    }

    const etag = res.headers.get('etag') || null;
    const rawSections = parseMarkdownSections(rawText);
    const sections = await Promise.all(
      rawSections.map(async (s) => ({
        ...s,
        contentHash: await computeContentHash(s.markdown),
      }))
    );

    const fullHash = await computeContentHash(rawText);
    const lineRangeMarkdown = parsed.lineRange
      ? extractLineRange(rawText, parsed.lineRange.start, parsed.lineRange.end)
      : null;
    const lineRangeHash = lineRangeMarkdown !== null ? await computeContentHash(lineRangeMarkdown) : null;

    return NextResponse.json({
      owner: parsed.owner,
      repo: parsed.repo,
      branch: parsed.branch,
      path: parsed.path,
      canonicalUrl: parsed.canonicalUrl,
      sectionId: parsed.sectionId,
      lineRange: parsed.lineRange,
      lineRangeMarkdown,
      lineRangeHash,
      etag,
      fullHash,
      fullMarkdown: rawText,
      sections,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch Markdown from GitHub';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

export const GET = withRateLimit({ endpoint: 'figma:node-info' })(handler);
