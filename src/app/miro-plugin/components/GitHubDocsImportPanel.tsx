import { useState } from 'react';
import type { GitHubDocPayload } from '../useGitHubDocsImporter';

interface GitHubDocsImportPanelProps {
  githubUrl: string;
  onGithubUrlChange: (url: string) => void;
  githubPat: string;
  onGithubPatChange: (pat: string) => void;
  docData: GitHubDocPayload | null;
  selectedSectionId: string;
  onSelectedSectionChange: (id: string) => void;
  isLoadingDoc: boolean;
  isSyncingDocs: boolean;
  docError: string | null;
  onLoadDoc: () => Promise<void>;
  onPlaceText: () => Promise<void>;
  onBindSelected: () => Promise<void>;
}

export function GitHubDocsImportPanel({
  githubUrl,
  onGithubUrlChange,
  githubPat,
  onGithubPatChange,
  docData,
  selectedSectionId,
  onSelectedSectionChange,
  isLoadingDoc,
  isSyncingDocs,
  docError,
  onLoadDoc,
  onPlaceText,
  onBindSelected,
}: GitHubDocsImportPanelProps) {
  const [showPat, setShowPat] = useState(false);

  const selectedPreview = (() => {
    if (!docData) return '';
    if (selectedSectionId === '*') return docData.fullMarkdown;
    if (
      docData.lineRange &&
      selectedSectionId === `L${docData.lineRange.start}-L${docData.lineRange.end}` &&
      docData.lineRangeMarkdown !== null
    ) {
      return docData.lineRangeMarkdown;
    }
    return docData.sections.find((s) => s.id === selectedSectionId)?.markdown || '';
  })();

  return (
    <div className="flex-grow flex flex-col justify-between gap-4">
      <div className="space-y-3">
        <div>
          <h4 className="text-[10px] uppercase font-mono tracking-widest text-text-muted mb-1.5">
            GitHub Markdown URL
          </h4>
          <div className="flex gap-1.5">
            <input
              type="url"
              value={githubUrl}
              onChange={(e) => onGithubUrlChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onLoadDoc();
              }}
              placeholder="https://github.com/owner/repo/blob/main/README.md"
              className="flex-1 min-w-0 text-[11px] font-mono bg-bg-card border border-border-card rounded px-2 py-1.5 text-text-page placeholder:text-text-muted/50 focus:outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => void onLoadDoc()}
              disabled={isLoadingDoc || !githubUrl.trim()}
              className="px-2.5 py-1.5 rounded bg-accent text-bg-page font-mono font-bold text-[10px] uppercase tracking-wider hover:opacity-90 transition disabled:opacity-40 cursor-pointer shrink-0"
            >
              {isLoadingDoc ? '...' : 'LOAD'}
            </button>
          </div>
          {docError && (
            <p className="text-[10px] font-mono text-red-400 mt-1.5 leading-snug">{docError}</p>
          )}
        </div>

        <div>
          <button
            type="button"
            onClick={() => setShowPat((prev) => !prev)}
            className="text-[9px] font-mono uppercase tracking-wider text-text-muted hover:text-accent transition cursor-pointer"
          >
            {showPat ? '▾ Hide Private Repo Token' : '▸ Private Repo Token (Optional)'}
          </button>
          {showPat && (
            <input
              type="password"
              value={githubPat}
              onChange={(e) => onGithubPatChange(e.target.value)}
              placeholder="ghp_... (stored locally in browser)"
              className="mt-1.5 w-full text-[10px] font-mono bg-bg-card border border-border-card rounded px-2 py-1.5 text-text-page placeholder:text-text-muted/50 focus:outline-none focus:border-accent"
            />
          )}
        </div>

        {docData && (
          <div className="p-2.5 rounded-lg bg-bg-card border border-border-card space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-mono font-semibold text-text-page truncate">
                {docData.owner}/{docData.repo}
              </span>
              <span className="text-[9px] font-mono text-accent shrink-0">{docData.branch}</span>
            </div>
            <div className="text-[9px] font-mono text-text-muted truncate">{docData.path}</div>

            <div>
              <label className="block text-[9px] uppercase font-mono tracking-wider text-text-muted mb-1">
                Section to Sync
              </label>
              <select
                value={selectedSectionId}
                onChange={(e) => onSelectedSectionChange(e.target.value)}
                className="w-full text-[11px] font-mono bg-bg-page border border-border-card rounded px-2 py-1.5 text-text-page focus:outline-none focus:border-accent"
              >
                <option value="*">Full Document ({docData.path})</option>
                {docData.lineRange && (
                  <option value={`L${docData.lineRange.start}-L${docData.lineRange.end}`}>
                    Lines {docData.lineRange.start}–{docData.lineRange.end}
                  </option>
                )}
                {docData.sections.map((sec) => (
                  <option key={sec.id} value={sec.id}>
                    {'#'.repeat(sec.level)} {sec.title} (#{sec.id})
                  </option>
                ))}
              </select>
            </div>

            {selectedPreview && (
              <pre className="max-h-28 overflow-y-auto text-[9px] font-mono text-text-muted bg-bg-page border border-border-card/70 rounded p-2 whitespace-pre-wrap break-words leading-relaxed">
                {selectedPreview.slice(0, 600)}
                {selectedPreview.length > 600 ? '\n…' : ''}
              </pre>
            )}
          </div>
        )}
      </div>

      <div className="space-y-2 pt-2 border-t border-border-card/60">
        <button
          type="button"
          onClick={() => void onPlaceText()}
          disabled={isSyncingDocs || !docData}
          className="w-full font-mono font-bold text-xs py-2.5 rounded bg-accent text-bg-page hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          {isSyncingDocs ? 'SYNCING...' : 'PLACE TEXT ON BOARD'}
        </button>
        <button
          type="button"
          onClick={() => void onBindSelected()}
          disabled={isSyncingDocs || !docData}
          className="w-full font-mono font-bold text-xs py-2 rounded border border-accent text-accent bg-transparent hover:bg-accent hover:text-bg-page transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          BIND SELECTED WIDGET
        </button>
      </div>
    </div>
  );
}
