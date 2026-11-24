---
title: Features & Video Demos
description: Explore SyncingBoard's core capabilities in action with short video walkthroughs, GIFs, and screenshots.
---

# SyncingBoard Features & Video Demos

Explore how SyncingBoard bridges design tools (**Figma** & **Penpot**) with interactive canvas whiteboards (**Miro** and **FigJam**) in real time.

<VideoTabs figma="https://www.youtube-nocookie.com/embed/7vckK-sSsOE" />

---

## Getting Started - Figma & Penpot Setup

Set up **SyncingBoard** by installing the **Miro** app, then setting up **Figma** and **Penpot**.

<VideoTabs figma="https://www.youtube-nocookie.com/embed/pO_-icohQhQ" penpot="https://www.youtube-nocookie.com/embed/qEVvAl1ohoE" />

---

## Frame Selection & Detection Relay

SyncingBoard's companion plugins stream active canvas selections in real time over **Ably WebSockets**. Selecting a frame in Figma Desktop/Web or Penpot instantly populates the Miro sidebar panel - with **zero server polling** and **zero Redis overhead**.

<VideoTabs figma="coming-soon" penpot="coming-soon" />

* **Key Highlights:**
  * Active selection relay across open design tabs and companion plugins.
  * Direct WebSocket channel pairing (`penpot:${pairingId}`).
  * Multi-selection grouping in the sidebar.

---

## One-Click Sync & Multi-Copy Board Propagation

Update selected screens in-place on Miro canvas. Toggle **"Also update all board copies"** to scan the canvas and update every duplicate of that frame in one pass; **"Propagate format & scale to all copies"** additionally applies the group format/scale settings across all copies (the FigJam app shows "Propagate scale to all copies" — PNG-only there).

<VideoTabs figma="coming-soon" penpot="coming-soon" />

* **Key Highlights:**
  * Single-click in-place screen updates.
  * Community batch protection (up to 3 unique images per sync).
  * Auto-refresh frame names directly from Figma/Penpot APIs.

---

## Widget Adoption & Retargeting ("Replace Selected")

Adopt any existing image widget on your Miro board (even non-SyncingBoard imports or copy-pasted screenshots) or retarget an existing widget to a new Figma/Penpot frame **without changing widget IDs**.

<VideoTabs figma="coming-soon" penpot="coming-soon" />

* **Key Highlights:**
  * Widget IDs remain intact.
  * Preserves canvas connectors, sticky note links, frame memberships, and comments.
  * Easy retargeting to updated design variants.

---

## Geometry Preservation ("Preserve Size")

Update image pixel content on Miro canvas while preserving custom layout dimensions, manual crops, and widget aspect ratios.

<VideoTabs figma="coming-soon" penpot="coming-soon" />

* **Key Highlights:**
  * Preserves manual widget resizes and crop layouts.
  * Independent toggle per sync operation.

---

## Vector SVG vs. HD PNG Resolution Control

Choose between crisp vector **SVG** exports (ideal for responsive text and icons with ~10x less bandwidth) or high-resolution **PNG** scaling (1x, 2x, and up to 4x for self-hosters).

> **FigJam note:** the FigJam app target is PNG-only — FigJam rejects SVG image pixels, so SVG renders are rasterized to PNG in-browser before placement (1x = design size, 2x = double, crisp). Miro keeps both PNG and SVG.

<VideoTabs figma="coming-soon" penpot="coming-soon" />

---

## FigJam App Target (M1)

The same SyncingBoard panel runs inside **FigJam** (Figma's free-form whiteboard) as a first-class target alongside Miro, driven by the Figma plugin (`editorType: ["figma", "figjam"]`) hosting the hosted panel at `/figjam-mirror`.

* **In-place updates:** tracked rectangles are located by `fileKey|nodeId` plugin data and updated in place — no duplicates.
* **Replace Selected (selection-only):** rewrites whatever is selected at message time (tracked rectangles or foreign images).
* **Penpot & Figma sources:** detect and import work the same as Miro (companion relay). "Detect Selection" reads the Figma/Penpot relay, never FigJam nodes.
* **PNG-only:** SVG renders are rasterized to PNG before placement (FigJam rejects SVG image pixels).
* **Import workflow:** 90s render cache with a "Reset image cache" link; Import/Replace buttons disable while placing.

---

## Password-Masked Pairing Key Security

To prevent unauthorized users on public whiteboards from reading your live design selection channel, SyncingBoard uses cryptographically random **16-character Pairing IDs** (`pairingId.ts`).

In the Miro sidebar UI, the Pairing ID input field is masked (`????????`) with an interactive toggle button to reveal or copy the key securely.

```text
Pairing ID:  [ ???????????????? ]  [ Reveal ]  [ Copy ]
```

* **Key Security Highlights:**
  * Generated client-side via `window.crypto.getRandomValues()`.
  * Input field defaults to password masking (`type="password"`).
  * 1-click reveal and copy controls for pairing with Figma or Penpot companions.

---

## SyncingBridge (Optional Zero-Cloud Local Mode)

For power users running **Figma Desktop** and **Miro Desktop**, the optional **SyncingBridge** (Tauri v2) desktop app replaces the cloud relay with a local Rust broker on `localhost:4401`:

* **Zero-Cloud Figma Pipeline:** Exports open Figma frames locally via `node.exportAsync()` (0 Figma REST API calls, bypassing Figma's Starter 20/month REST cap) and uploads directly to Miro REST API v2 from Rust (0 Vercel calls, 50 MB payload limit).
* **Hybrid Dual-Transport:** Figma Desktop runs locally over SyncingBridge (up to **50 frames per batch**), while Penpot Web automatically uses Ably Cloud Relay (up to **3 frames per batch**) side by side with zero cross-talk.
* **Live Figma Auto-Detect:** Clicking any frame in Figma Desktop updates Miro's **Import → Figma** tab automatically in real time — no manual "Detect" click needed.
* **Configurable Global Shortcuts:** Trigger **Import** (`Ctrl/Cmd+Shift+I`), **Replace** (`Ctrl/Cmd+Shift+R`), or **Sync** (`Ctrl/Cmd+Shift+S`) directly from Figma or Miro without touching the sidebar. Click any shortcut box in **SyncingBridge → Settings** to record custom bindings.

---

## GitHub Docs-as-Code Text Sync (Miro MVP)

Keep product specs, architecture notes, and release documentation in sync between GitHub Markdown files and your Miro boards:

* **Deterministic Section Picker:** Paste any GitHub `.md` URL (public or private) in **Import → DOCS** to parse headings (`#`–`######`) into selectable sections, then import them as Miro `text`, `shape`, or `sticky_note` widgets.
* **In-Place Updates & Section Switching:** Select any bound GitHub widget on the Miro canvas to refresh it from the unified **Sync** tab — preserving position, size, connectors, and comments. Use the inline **Section** dropdown on any Sync card to retarget a widget to another heading in the same file.
* **Private Repo OAuth:** Connect your GitHub account once in **Settings → GitHub Status** (stateless OAuth stored only in your browser) to read authorized private repositories without pasting Personal Access Tokens.

---

## Explore More Documentation

* [Quickstart Setup Guide](/docs/setup) - Learn how to set up SyncingBoard in 2 minutes.
* [System Architecture](/docs/architecture) - Learn how SyncingBoard's 3-layer adapter system works.
* [Frequently Asked Questions](/docs/faq) - Common questions about pricing, privacy, and self-hosting.
