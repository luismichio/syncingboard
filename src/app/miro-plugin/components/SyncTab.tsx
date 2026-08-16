import { useState } from 'react';
import { decodeHtmlEntities } from '@/lib/decodeHtmlEntities';
import { formatDuration } from '@/lib/formatDuration';
import { GroupedSyncedImage } from '../types';

interface SyncTabProps {
  selectedItemsCount: number;
  groupedItems: GroupedSyncedImage[];
  syncAllCopies: boolean;
  setSyncAllCopies: (value: boolean) => void;
  preserveSize: boolean;
  setPreserveSize: (value: boolean) => void;
  propagate: boolean;
  setPropagate: (value: boolean) => void;
  isSyncing: boolean;
  cooldownSeconds: number;
  hasMiroToken: boolean;
  onSync: () => void;
  onGroupSettingChange: (itemIds: string[], key: 'format' | 'scale', value: unknown) => void;
  onRefreshNodeName?: (fileKey: string, nodeId: string, platform: 'figma' | 'penpot') => void;
  onRemoveGroup?: (groupKey: string, itemIds: string[]) => void;
  availableScales: number[];
  /** FigJam mirror mode: the list is a registry of placed mirrors, not a
   * Miro canvas selection — different wording and no 3-item cap. */
  mirrorMode?: boolean;
}

export function SyncTab({
  selectedItemsCount,
  groupedItems,
  syncAllCopies,
  setSyncAllCopies,
  preserveSize,
  setPreserveSize,
  propagate,
  setPropagate,
  isSyncing,
  cooldownSeconds,
  hasMiroToken,
  onSync,
  onGroupSettingChange,
  onRefreshNodeName,
  onRemoveGroup,
  availableScales,
  mirrorMode = false,
}: SyncTabProps) {
  const [copiedNodeId, setCopiedNodeId] = useState<string | null>(null);
  return (
    <div className="flex-grow flex flex-col justify-between">
      <div className="space-y-3">
        <h4 className="text-[10px] uppercase font-mono tracking-widest text-text-muted">
          {mirrorMode ? 'Selected FigJam Items' : 'Selected Canvas Screens'}
{!hasMiroToken && (
  <div className="p-3 rounded-md border border-amber-500/40 flex flex-col gap-1">
    <span className="text-[9px] font-mono text-text-muted leading-tight">
      Connect your Miro account in Settings to sync screens.
    </span>
  </div>
)}
        </h4>

        {selectedItemsCount > 0 ? (
          <div className="space-y-3">
            <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
              {groupedItems.map((group) => (
                <div
                  key={group.key}
                  className="p-3 rounded-md bg-bg-card border border-border-card flex flex-col gap-2 relative animate-fade-in"
                >
                  <div className="absolute top-2 right-2 flex items-center gap-1.5">
                    <span className="text-[8px] font-mono font-bold uppercase tracking-wider text-accent border border-accent/40 bg-transparent px-1.5 py-0.5 rounded">
                      {group.platform === 'penpot' ? 'Penpot' : 'Figma'}
                    </span>

                    {group.widgets.length > 1 && (
                      <span className="px-1.5 py-0.5 text-[8px] font-bold font-mono bg-accent/20 border border-accent/40 text-accent rounded-full">
                        x{group.widgets.length}
                      </span>
                    )}

                    {onRemoveGroup && (
                      <button
                        type="button"
                        onClick={() => onRemoveGroup(group.key, group.widgets.map((w) => w.id))}
                        disabled={isSyncing}
                        className="p-0.5 text-text-muted hover:text-text-page hover:bg-bg-page/40 rounded transition-colors disabled:opacity-40 cursor-pointer ml-0.5"
                        title="Deselect from sync list"
                        aria-label={`Deselect ${decodeHtmlEntities(group.nodeName)}`}
                      >
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    )}
                  </div>

                  <div className="flex flex-col pr-24">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-xs font-semibold text-text-page truncate">
                        {decodeHtmlEntities(group.nodeName)}
                      </span>
                      {onRefreshNodeName && (
                        <button
                          onClick={() => onRefreshNodeName(group.fileKey, group.nodeId, group.platform)}
                          disabled={isSyncing}
                          className="shrink-0 p-0.5 text-text-muted hover:text-accent transition-colors disabled:opacity-40 cursor-pointer"
                          title="Refresh frame name from source"
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
                          </svg>
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 min-w-0 mt-0.5">
                      {group.url ? (
                        <a
                          href={group.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[9px] font-mono text-text-muted hover:text-accent truncate cursor-pointer"
                          title={`Open in source app — ${group.url}`}
                        >
                          ID: {group.nodeId} ↗
                        </a>
                      ) : (
                        <span className="text-[9px] font-mono text-text-muted truncate">
                          ID: {group.nodeId}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          if (navigator.clipboard) {
                            navigator.clipboard.writeText(group.nodeId);
                            setCopiedNodeId(group.nodeId);
                            setTimeout(() => setCopiedNodeId(null), 1500);
                          }
                        }}
                        className="p-0.5 text-text-muted hover:text-accent transition cursor-pointer shrink-0"
                        title={copiedNodeId === group.nodeId ? 'Copied!' : 'Copy Node ID'}
                      >
                        {copiedNodeId === group.nodeId ? (
                          <span className="text-[8px] font-mono text-accent">✓</span>
                        ) : (
                          <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
                            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="flex gap-2 mt-1 pt-2 border-t border-border-card/30">
                    {!mirrorMode && (
                    <div className="flex-1 flex flex-col gap-0.5">
                      <span className="text-[8px] font-mono text-text-muted uppercase tracking-wider">Format</span>
                      <select
                        value={group.format}
                        onChange={(e) => onGroupSettingChange(group.widgets.map((w) => w.id), 'format', e.target.value as 'png' | 'svg')}
                        className="bg-bg-page border border-border-card text-[10px] rounded px-1.5 py-0.5 focus:outline-none focus:border-accent text-text-page w-full cursor-pointer"
                      >
                        <option value="png">PNG</option>
                        <option value="svg">SVG</option>
                      </select>
                    </div>
                    )}

                    {(mirrorMode || group.format === 'png') && (
                      <div className="flex-1 flex flex-col gap-0.5">
                        <span className="text-[8px] font-mono text-text-muted uppercase tracking-wider">Scale</span>
                        <select
                          value={group.scale}
                          onChange={(e) => onGroupSettingChange(group.widgets.map((w) => w.id), 'scale', Number(e.target.value))}
                          className="bg-bg-page border border-border-card text-[10px] rounded px-1.5 py-0.5 focus:outline-none focus:border-accent text-text-page w-full cursor-pointer"
                        >
                          {availableScales.map((s) => (
                            <option key={s} value={s}>{s}x</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <label className="flex items-center gap-2 mt-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={syncAllCopies}
                onChange={(e) => setSyncAllCopies(e.target.checked)}
                className="accent-accent w-3 h-3"
              />
              <span className="text-[10px] text-text-muted font-mono">
                Also update all board copies
              </span>
            </label>

            <label className="flex flex-col gap-0.5 mt-1.5 cursor-pointer select-none">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={preserveSize}
                  onChange={(e) => setPreserveSize(e.target.checked)}
                  className="accent-accent w-3 h-3"
                />
                <span className="text-[10px] text-text-muted font-mono">
                  Keep canvas size
                </span>
              </div>
              <p className="ml-5 text-[8px] font-mono text-text-muted/50 leading-tight">
                {mirrorMode ? 'Dimension and Crop locked.' : 'Size locked. Crop resets — Miro API limitation.'}
              </p>
            </label>

            {syncAllCopies && (
              <label className="flex items-center gap-2 mt-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={propagate}
                  onChange={(e) => {
                    setPropagate(e.target.checked);
                    if (e.target.checked) setPreserveSize(false);
                  }}
                  className="accent-accent w-3 h-3"
                />
                <span className="text-[10px] text-text-muted font-mono">
                  {mirrorMode
                    ? 'Propagate scale to all copies'
                    : 'Propagate format & scale to all copies'}
                </span>
              </label>
            )}

            {groupedItems.length > 3 && (
              <div className="flex items-start gap-2 p-2.5 mt-2 rounded-md bg-bg-card border border-amber-500/60">
                <svg className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                </svg>
                <span className="text-xs font-mono leading-snug text-text-page">
                  Only 3 items can be synced at once. Deselect some to continue.
                </span>
              </div>
            )}

            <button
              onClick={onSync}
              disabled={isSyncing || cooldownSeconds > 0 || !hasMiroToken || groupedItems.length > 3}
              className="w-full mt-2 font-mono font-bold text-xs py-2.5 rounded bg-accent text-bg-page hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {cooldownSeconds > 0
                ? `COMMUNITY COOLDOWN · ${formatDuration(cooldownSeconds)}`
                : mirrorMode
                ? (syncAllCopies ? 'SYNC + UPDATE ALL COPIES' : 'SYNC SELECTED')
                : (syncAllCopies ? 'SYNC + UPDATE ALL COPIES' : 'SYNC SELECTED')}
            </button>
          </div>
        ) : (
          <div className="p-8 rounded-md border border-dashed border-border-card text-center text-xs text-text-muted py-12">
            {mirrorMode
              ? 'Select FigJam shapes on the board to update them in place — or place one in Import first.'
              : 'Select one or more Figma or Penpot screenshots on the board canvas to update them in-place.'}
          </div>
        )}
      </div>
    </div>
  );
}
