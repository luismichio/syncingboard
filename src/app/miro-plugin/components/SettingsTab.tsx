import { useEffect, useState } from 'react';
import ThemeToggle from '@/components/ThemeToggle';
import { DEFAULT_BRIDGE_PORT, parseBridgePort } from '@/lib/sync/bridgeValidation';

interface SettingsTabProps {
  tokensLoading: boolean;
  figmaToken: string | null;
  miroToken: string | null;
  connectFigma: () => void;
  connectMiro: () => void;
  disconnectFigma: () => Promise<void>;
  disconnectMiro: () => Promise<void>;
  copiedPairing: boolean;
  pairingId: string;
  copyPairingId: () => void;
  onRegeneratePairingId: () => void;
  useTauri: boolean;
  onToggleTauri?: () => Promise<void> | void;
  figmaConnected?: boolean;
  defaultPngScale: number;
  onDefaultPngScaleChange: (value: number) => void;
  availableScales: number[];
  hideMiro?: boolean;
}

export function SettingsTab({
  tokensLoading,
  figmaToken,
  miroToken,
  connectFigma,
  connectMiro,
  disconnectFigma,
  disconnectMiro,
  copiedPairing,
  pairingId,
  copyPairingId,
  onRegeneratePairingId,
  useTauri,
  onToggleTauri,
  figmaConnected = false,
  defaultPngScale,
  onDefaultPngScaleChange,
  availableScales,
  hideMiro = false,
}: SettingsTabProps) {
  const [showPairingId, setShowPairingId] = useState(false);
  const [bridgePort, setBridgePort] = useState<string>(String(DEFAULT_BRIDGE_PORT));

  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      try {
        const saved = window.localStorage.getItem('syncingboard_bridge_port');
        const valid = parseBridgePort(saved);
        setBridgePort(String(valid ?? DEFAULT_BRIDGE_PORT));
      } catch {
        // Ignore storage errors
      }
    });
    return () => window.cancelAnimationFrame(rafId);
  }, []);
  return (
    <div className="flex-grow flex flex-col gap-6">
      <div>
        <h4 className="text-[10px] uppercase font-mono tracking-widest text-text-muted mb-2">
          Integrations
        </h4>
        <div className="space-y-2">
          <div className="p-3 rounded-lg bg-bg-card border border-border-card flex justify-between items-center">
            <div>
              <div className="text-xs font-semibold text-text-page">Figma Status</div>
              <div className="text-[10px] text-text-muted">OAuth connection for frame rendering</div>
            </div>
            {tokensLoading ? (
              <span className="h-2 w-2 rounded-full bg-yellow-500 animate-pulse"></span>
            ) : figmaToken ? (
              <div className="flex items-center gap-3">
                <span className="h-2 w-2 rounded-full bg-green-500"></span>
                <button
                  onClick={disconnectFigma}
                  className="text-[9px] font-mono font-bold tracking-wider text-text-muted hover:text-accent uppercase underline bg-transparent cursor-pointer"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                onClick={connectFigma}
                className="text-[10px] font-mono tracking-wider font-semibold border border-accent text-accent rounded px-2.5 py-1 bg-transparent hover:bg-accent hover:text-bg-page transition cursor-pointer"
              >
                CONNECT
              </button>
            )}
          </div>

          <div
            className="p-3 rounded-lg bg-bg-card border border-border-card flex justify-between items-center"
            style={hideMiro ? { display: 'none' } : undefined}
          >
            <div>
              <div className="text-xs font-semibold text-text-page">Miro REST Status</div>
              <div className="text-[10px] text-text-muted">OAuth connection for board image updates</div>
            </div>
            {tokensLoading ? (
              <span className="h-2 w-2 rounded-full bg-yellow-500 animate-pulse"></span>
            ) : miroToken ? (
              <div className="flex items-center gap-3">
                <span className="h-2 w-2 rounded-full bg-green-500"></span>
                <button
                  onClick={disconnectMiro}
                  className="text-[9px] font-mono font-bold tracking-wider text-text-muted hover:text-accent uppercase underline bg-transparent cursor-pointer"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                onClick={connectMiro}
                className="text-[10px] font-mono tracking-wider font-semibold border border-accent text-accent rounded px-2.5 py-1 bg-transparent hover:bg-accent hover:text-bg-page transition cursor-pointer"
              >
                CONNECT
              </button>
            )}
          </div>

          <div className="p-3 rounded-lg bg-bg-card border border-border-card flex flex-col gap-2">
            <div className="flex justify-between items-center">
              <div>
                <div className="text-xs font-semibold text-text-page">SyncingBridge (Local)</div>
                <div className="text-[10px] text-text-muted">
                  {useTauri
                    ? 'Auto-connect to local desktop bridge on launch'
                    : 'Auto-connect disabled — using Cloud Relay (Ably)'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {useTauri && <span className="h-2 w-2 rounded-full bg-green-500"></span>}
                <label className="relative inline-block w-8 h-[18px] shrink-0 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useTauri}
                    onChange={onToggleTauri}
                    className="opacity-0 w-0 h-0 peer"
                  />
                  <span className="absolute inset-0 bg-border-card rounded-full transition-colors duration-200 peer-checked:bg-accent before:content-[''] before:absolute before:h-3 before:w-3 before:left-[3px] before:bottom-[3px] before:bg-white before:rounded-full before:transition-transform before:duration-200 peer-checked:before:translate-x-3.5"></span>
                </label>
              </div>
            </div>
            <div className="pt-2 border-t border-border-card/60 flex justify-between items-center text-[10px]">
              <div>
                <span className="text-text-muted font-mono block">Broker Port</span>
                <span className="text-[9px] text-text-muted/60">Local WebSocket loopback port</span>
              </div>
              <input
                type="number"
                min={1024}
                max={65535}
                value={bridgePort}
                onChange={(e) => {
                  const next = e.target.value;
                  setBridgePort(next);
                  const valid = parseBridgePort(next);
                  if (valid !== null && typeof window !== 'undefined') {
                    window.localStorage.setItem('syncingboard_bridge_port', String(valid));
                  }
                }}
                onBlur={() => {
                  const valid = parseBridgePort(bridgePort);
                  const normalized = String(valid ?? DEFAULT_BRIDGE_PORT);
                  setBridgePort(normalized);
                  if (typeof window !== 'undefined') {
                    window.localStorage.setItem('syncingboard_bridge_port', normalized);
                  }
                }}
                className="w-16 font-mono text-[10px] text-accent bg-bg-page border border-border-card rounded px-1.5 py-0.5 text-right focus:outline-none focus:border-accent"
              />
            </div>
          </div>

          <div className="p-3 rounded-lg bg-bg-card border border-border-card flex flex-col gap-2 animate-fade-in">
            <div className="flex justify-between items-center">
              <span className="text-xs font-semibold text-text-page">Pairing ID</span>
              <div className="flex gap-1.5">
                <button
                  onClick={onRegeneratePairingId}
                  className="text-[9px] font-mono font-bold tracking-wider text-text-muted border border-border-card rounded px-1.5 py-0.5 bg-transparent hover:bg-bg-card hover:text-text-page transition cursor-pointer"
                  title="Generate a new pairing ID. Existing companion connections will need the new ID."
                >
                  REGENERATE
                </button>
                <button
                  onClick={copyPairingId}
                  className="text-[9px] font-mono font-bold tracking-wider text-accent border border-accent/40 rounded px-1.5 py-0.5 bg-transparent hover:bg-accent hover:text-bg-page transition cursor-pointer"
                >
                  {copiedPairing ? 'COPIED!' : 'COPY ID'}
                </button>
              </div>
            </div>
            <div className="relative">
              <input
                type={showPairingId ? 'text' : 'password'}
                value={pairingId}
                readOnly={true}
                placeholder="sb_xxxxx"
                className="w-full text-[10px] font-mono bg-bg-page border border-border-card rounded p-1.5 pr-8 text-text-page select-all focus:outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => setShowPairingId((v) => !v)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-page transition cursor-pointer"
                aria-label={showPairingId ? 'Hide pairing ID' : 'Show pairing ID'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {showPairingId ? (
                    <>
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </>
                  ) : (
                    <>
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </>
                  )}
                </svg>
              </button>
            </div>
            <p className="text-[9px] text-text-muted leading-tight mt-0.5">
              {hideMiro
                ? 'Paste this pairing ID inside the Penpot Companion Plugin to link FigJam and Penpot.'
                : 'Paste this pairing ID inside the Penpot Companion Plugin to link Miro and Penpot.'}
            </p>
            <p className="text-[9px] text-text-muted leading-tight mt-0.5">
              Also needed to detect your selection in the Figma app (Figma Companion uses the same pairing ID).
            </p>
            <p className="text-[9px] text-text-muted leading-tight mt-0.5">
              {useTauri
                ? `Transport mode: Local SyncingBridge (Tauri on ws://127.0.0.1:${parseBridgePort(bridgePort) ?? DEFAULT_BRIDGE_PORT}).`
                : 'Transport mode: Cloud relay (Ably).'}
            </p>
          </div>
        </div>
      </div>

      <div>
        <h4 className="text-[10px] uppercase font-mono tracking-widest text-text-muted mb-2">
          Preferences
        </h4>
        <div className="space-y-2">
          <div className="p-3 rounded-lg bg-bg-card border border-border-card flex justify-between items-center">
            <span className="text-xs font-semibold text-text-page">Default PNG Scale</span>
            <select
              value={defaultPngScale}
              onChange={(e) => onDefaultPngScaleChange(Number(e.target.value))}
              className="bg-bg-page border border-border-card text-xs rounded px-2 py-1 focus:outline-none focus:border-accent text-text-page cursor-pointer"
            >
              {availableScales.map((s) => (
                <option key={s} value={s}>{s}x</option>
              ))}
            </select>
          </div>


          <div className="p-3 rounded-lg bg-bg-card border border-border-card flex justify-between items-center">
            <span className="text-xs font-semibold text-text-page">Theme Select</span>
            <ThemeToggle />
          </div>
        </div>
      </div>

      <div className="mt-6 pt-4 border-t border-border-card">
        <a
          href="https://www.syncingboard.com/docs"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-1.5 text-[10px] font-mono text-text-muted hover:text-accent transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
          </svg>
          Documentation
        </a>
      </div>
    </div>
  );
}
