import Script from 'next/script';

/**
 * Miro SDK is scoped to the Miro route ONLY.
 *
 * The board iframe panel (`/miro-plugin`) and its headless icon-init
 * (`/miro-plugin?init=true`) are the only surfaces that ever touch
 * `window.miro`. Loading miro.js from the global layout made every other
 * surface (FigJam mirror, Figma/Penpot companions, dashboard, docs)
 * download and boot the SDK, which then threw `SdkConnectionError: Miro
 * SDK is not connected...` in their consoles.
 *
 * Loaded after hydration (strategy="afterInteractive") — the SDK's own
 * handshake and our pollers (useMiroSelection waits up to 8s, 20s+retries
 * in headless mode) absorb the small delay; timing parity with the old
 * global `defer` script is preserved.
 */
export default function MiroPluginLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Script strategy="afterInteractive" src="https://miro.com/app/static/sdk/v2/miro.js" />
      {children}
    </>
  );
}