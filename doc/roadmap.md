---
title: Product Roadmap
description: Strategic milestones, upcoming features, and future architecture plans for SyncingBoard.
---

# Product Roadmap

This roadmap outlines planned features, architecture expansions, and research targets for SyncingBoard.

---

* **Push-Sync from Figma & Penpot Companion Plugins to Miro:** Trigger sync operations directly from inside Figma and Penpot companion plugins without opening the Miro sidebar.
* **Figma Webhook & Auto-Sync:** Subscribe to [Figma event webhooks](https://www.figma.com/developers/webhooks/index) so tracked file/page/frame changes refresh the Miro widgets automatically, without anyone touching the sidebar.
* **Locked Widget Guard:** Automatically skip locked Miro widgets during "Sync All" with an optional *"Ignore Lock"* override checkbox.
* **In-Plugin Card Deselection (not shipped):** a dismiss (`✕`) button that clears the card's source once a job completes, so Place/Replace/Sync are not left "active". The import card already has this; the sync cards do not — add it there too.
* **Selection Auto-Detect UX (partially shipped):** 0.16.1 added a live "Waiting for the Companion …" progress footer on Detect and clarified pairing copy on both surfaces. Remaining: further handshake/status refinements across the Penpot and Figma companions.
* **Animated GIF & Video Sync:** Export and sync Figma prototype animations and video frames into Miro as live animated GIF and playable video widgets.
* **Image Compression & Format Conversion:** Optimize synced image buffers with WebP/AVIF compression and format conversions before uploading to whiteboard widgets.
* **Local Document & Data Parsing:** Extend SyncingBoard to import and render local Office documents, PDFs, and Markdown files onto whiteboards.
* **MCP Server Integration:** Model Context Protocol (MCP) server integration (`mcp-roadmap.md`) allowing AI coding agents (Antigravity, Claude, Cursor) to inspect Miro canvas selections and trigger sync operations.
* **Multi-Whiteboard Platform Expansion (Target Whiteboards):** Expand target whiteboard adapters beyond Miro to support Mural, Microsoft Whiteboard, Excalidraw, and tldraw.
* ~~**FigJam Integration (Target Whiteboard)**~~ ✅ **Shipped in 0.16.1 (M1):** design screens sync into **FigJam** — Figma’s free-form whiteboard — as a first-class target alongside Miro, reusing the in-place / no-duplicates image model, the existing Figma OAuth, and Figma Companion pairing. Outstanding: FigJam-specific edge polish (PNG-only by design).
* **Adobe UXP Companion:** Extender plugin for Adobe XD / Photoshop canvas surfaces.
* **Tauri SyncBridge Desktop Extender:** Native desktop extender for streaming large image payloads (>4.5MB), local LLM canvas assistants, and two-way sync.
* **Additional Source Adapters:** Research adapters for UXPin, Framer, Lovable, and Stitch.
* **Canva Source Adapter:** Research Canva for importing Canva design assets (posters, social cards, docs) into a whiteboard, as an extension of the Figma/Penpot source adapters.
* **Optional Pairing Passphrase (PIN):** Protect sensitive projects with an opt-in passphrase that must be entered before detection, import, or sync can run against a protected pairing — planned for a future release.

* **SSO (Enterprise Single Sign-On):** Centralize sign-in with Google Workspace / Microsoft Entra ID so internal teams authenticate to the self-hosted app and its OAuth flows with their existing corporate identities.
* **SAML (Enterprise SSO):** Provide SAML 2.0 SSO for self-hosted / SyncBridge Enterprise onboarding. Note a platform constraint: Miro plugin tabs cannot render third-party IdP login screens directly (`X-Frame-Options: DENY` + third-party cookie blocking), so SAML onboarding routes through the SyncBridge desktop app or a dedicated portal instead of the sidebar iframe.

---

## Engineering & Quality (CI)
* **CI: Storybook & Playwright Harness:** Stand up Storybook for visual/component testing of the Miro sidebar and an end-to-end Playwright suite (OAuth pairing, relay sync, board operations) running in headless browsers against the deployed app.
* **CI: GitHub Actions Pipeline:** Automate the quality gate on every push/PR — run `yarn test`, `yarn build`, TypeScript checks, and the Storybook/Playwright suite, with branch-protection gates before release.
