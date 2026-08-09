/**
 * Miro SDK — scoped to the /miro-plugin route ONLY.
 *
 * The  board iframe panel (`/miro-plugin`) and its headless icon-init
 * (`/miro-plugin?init=true`) are the only surfaces that ever touch
 * `window.miro`. The SDK used to load from the GLOBAL layout, which made
 * FigJam, companion sites, dashboard and marketing pages download+boot
 * miro.js and throw `SdkConnectionError` in their consoles.
 *
 * A plain server-rendered `<script defer>` is used here on purpose:
 * next/script's `afterInteractive` strategy failed — the SDK came too
 * late / was injected after hydration inside Miro's sandboxed panel
 * iframe, so the app never registered in the sidebar. A plain script
 * tag renders into the SSR HTML before `children` (defer executes after
 * document parse, exactly like the old head tag) — Miro opens as before,
 * and only this route carries the SDK. Our pollers (useMiroSelection:
 * 8s panel, 20s + retries headless) absorb any load jitter.
 */
export default function MiroPluginLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script src="https://miro.com/app/static/sdk/v2/miro.js" defer />
      {children}
    </>
  );
}