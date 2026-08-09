---
title: Target Adapters & Metadata Architecture
description: Miro SDK v2 image widget integration, stateless metadata title signatures, preserveSize geometry, and duplicate card consolidation.
---

# Target Adapters & Metadata Architecture

> **Overview:** SyncingBoard writes synchronized design data to whiteboard platforms through target adapters. **Miro** is the primary target; a **FigJam app** (M1) is shipped; **Mural**, **Microsoft Whiteboard**, **Excalidraw**, and **tldraw** are under research/design.

---

## Miro — Image Widgets

> **Status:** stable — implemented in production.

Miro is SyncingBoard's primary canvas target. SyncingBoard pushes screenshots to Miro image widgets via the **Miro REST API** (widget creation, image PATCH) and reads widget metadata via the **Miro Web SDK v2** (sidebar panel, selection detection).

### Transport & Operations
* **Create/Update Images:** `PATCH /v2/boards/{boardId}/images/{itemId}` with multipart image upload.
* **Read/Sync Metadata:** `miro.board.getById()` and `widget.setMetadata('syncingboard', ...)` via Web SDK.
* **Sidebar UI:** Miro Web SDK `miro.board.ui.openPanel()` for the SyncingBoard control panel.
* **Geometry Preservation (`preserveSize`):** Optional update mode (`preserveSize: true`) that pushes new image bytes to Miro without resetting custom canvas widget dimensions or aspect ratios.
* **Widget Adoption & Retargeting (`replaceSelectedWidget`):** Enables adopting non-SyncingBoard images or retargeting existing SyncingBoard widgets to a new Figma/Penpot frame without changing widget IDs. Connectors, comments, links, and frame memberships are preserved.

---

## FigJam — App Target

> **Status:** shipped (0.16.1, M1).

FigJam (Figma’s whiteboard) is SyncingBoard’s second whiteboard target. The same Figma plugin (`editorType: ["figma", "figjam"]`) hosts a hosted panel (route `/figjam-mirror`, reusing the Miro sidebar components) that drives in-place updates through the plugin’s `figjam-place` command:

* **In-place image swaps:** tracked rectangles are located by `fileKey|nodeId` plugin data and updated via IMAGE-fill swaps (or a clean rectangle swap when the node has children / is a component instance).
* **Selection-driven sync:** cards list every selected tracked instance; `figjam-place` receives the selected `nodeIds` and updates only those.
* **Replace Selected:** rewrites whatever is selected at message time (tracked rectangles or foreign images); selection-only (the earlier copy-propagation experiment was reverted per user decision).
* **PNG-only:** FigJam rejects SVG image pixels, so SVG renders are rasterized to PNG in-browser before placement; the FigJam surface offers PNG format only.
* **Propagate:** "Propagate scale to all copies" (Miro keeps "Propagate format & scale to all copies").
* **Never a source:** "Detect Selection" reads the Figma/Penpot companion relay, not FigJam nodes.

---

## Stateless Metadata Registry

SyncingBoard stores all design connection metadata directly in the Miro widget. No database is required to track which widget maps to which design frame.

### Signature & Metadata Schema
* **Figma Title Signature:** `Node Name [FigmaSync|fileKey|nodeId]`
* **Penpot Title Signature:** `Node Name [PenpotSync|fileKey|nodeId]`
* **Metadata Payload:** Stored on the Miro image widget via `widget.setMetadata('syncingboard', ...)`:

```json
{
  "fileKey": "UUID_or_FileKey",
  "nodeId": "Frame_Node_ID",
  "nodeName": "Home Screen",
  "format": "png" | "svg",
  "scale": 1 | 2 | 3 | 4,   // Community plan: 1x/2x (MAX_SCALE=2). Self-host: 1x–4x (MAX_SCALE=4).
  "platform": "figma" | "penpot",
  "width": 1200             // Stored natural width for Penpot vector scaling
}
```

### Why Duplicate Metadata in Title Signatures?
1. **Durable Copy/Paste Fallback:** Custom plugin metadata can occasionally be stripped when widgets are copied across boards. Standard title text is native to the widget and persists during duplication.
2. **Native Board Searchability:** Miro's native search bar indexes widget titles, enabling users to search their Miro board for specific Figma/Penpot nodes.
3. **Human-Readable Auditing:** Provides visual reference for frame mapping directly on the canvas without developer tools.
4. **HTML Entity Sanitization:** Frame titles are sanitized via `decodeHtmlEntities()` (`src/lib/decodeHtmlEntities.ts`) before being applied to `widget.title` via the Miro SDK, preventing raw XML entities (e.g. `&amp;`, `&quot;`) on canvas headers.

---

## Duplicate Card Consolidation & Grouping

> **Status:** stable — implemented in production via `useMiroSync` hook and `propagate` multi-copy sync toggle.

To prevent clutter in the Miro plugin sidebar, SyncingBoard groups identical selected canvas widgets (same `fileKey` + `nodeId` signature) into a single card:
* **Count Badges:** Displays a count badge (e.g. `x3`) in the top-right corner of the group card.
* **Batch Settings Updates:** Modifying resolution scale or format on the grouped card updates all matching widgets on the canvas simultaneously.
* **Multi-Copy Sync:** **"Also update all board copies"** scans the canvas and updates every copy of that frame in a single click; **"Propagate format & scale to all copies"** (Miro; FigJam shows "Propagate scale to all copies") pushes the group format/scale settings to all copies as well.

---

## Research Target Adapters

| Target Platform | Transport Model | Widget Type | Status |
|---|---|---|---|
| **Mural** | REST API | Sticky notes / images | Research needed — verify image POST endpoints |
| **Microsoft Whiteboard** | Graph API (`graph.microsoft.com`) | Surface API image strokes | Research needed |
| **Excalidraw** | Self-hosted REST (`POST /api/v2/scenes`) | Scene elements | Design — open API & self-host friendly |
| **tldraw** | Embedded SDK | `TldrawImage` component | Design — programmable embedded canvas |
