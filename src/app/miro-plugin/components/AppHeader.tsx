interface AppHeaderProps {
  tokensLoading: boolean;
  figmaToken: string | null;
  miroToken: string | null;
  useTauri?: boolean;
  hideMiro?: boolean;
}

export function AppHeader({ tokensLoading, figmaToken, miroToken, useTauri = false, hideMiro = false }: AppHeaderProps) {
  return (
    <header className="mb-4 flex items-center justify-between">
      <div className="flex items-start gap-2.5">
        <div
          className="w-6 h-6 mt-0.5 bg-accent shrink-0"
          style={{
            maskImage: 'url(/syncingboard_logo.svg)',
            WebkitMaskImage: 'url(/syncingboard_logo.svg)',
            maskSize: 'contain',
            maskRepeat: 'no-repeat',
            maskPosition: 'center',
          }}
        />
        <div>
          <h2 className="text-xl font-bold tracking-tight text-accent leading-none">SyncingBoard</h2>
          <p className="text-[10px] text-text-muted mt-0.5">Stateless Design-Board Pipeline</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div
          className="flex items-center justify-center cursor-default transition opacity-85 hover:opacity-100"
          title={useTauri ? 'Relay: SyncingBridge Local WebSocket active (127.0.0.1:4401)' : 'Relay: Cloud Relay (Ably) active'}
        >
          {useTauri ? (
            /* Local Bridge: Lucide Radio / Signal Icon */
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-500" aria-label="Local Bridge Active">
              <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/>
              <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/>
              <circle cx="12" cy="12" r="2"/>
              <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/>
              <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>
            </svg>
          ) : (
            /* Cloud Relay: Lucide Cloud Icon */
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent" aria-label="Cloud Relay Active">
              <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>
            </svg>
          )}
        </div>

        <div
          className={`w-3.5 h-5 transition duration-200 ${tokensLoading ? 'bg-yellow-500/50' : figmaToken ? 'bg-accent' : 'bg-text-muted/30'}`}
          style={{
            maskImage: 'url(/Figma.svg)',
            WebkitMaskImage: 'url(/Figma.svg)',
            maskSize: 'contain',
            maskRepeat: 'no-repeat',
            maskPosition: 'center',
          }}
        />

        {!hideMiro && (
        <div
          className={`w-[18px] h-[18px] transition duration-200 ${tokensLoading ? 'bg-yellow-500/50' : miroToken ? 'bg-accent' : 'bg-text-muted/30'}`}
          style={{
            maskImage: 'url(/Miro.svg)',
            WebkitMaskImage: 'url(/Miro.svg)',
            maskSize: 'contain',
            maskRepeat: 'no-repeat',
            maskPosition: 'center',
          }}
        />
        )}
      </div>
    </header>
  );
}
