---
title: "SyncingBoard Design System Architecture & Specifications"
description: "Core design tokens, typography rules, component standards, and multi-surface guidelines across Miro, FigJam, Companion, and Web Documentation interfaces."
---

# SyncingBoard Design System Architecture & Specifications

> **Source of Truth for Visuals, UI Components, & Documentation Aesthetics**  
> **Philosophy:** "Systems, Not Patches." All user interface components across Miro, FigJam, Companion, and Web surfaces must strictly adhere to established design system tokens (`var(--accent)`, `var(--bg-card)`, `var(--border-card)`).

---

## 🎨 Core Design Tokens

SyncingBoard enforces a clean, modern dark-mode-first aesthetic with system-matching light mode fallbacks across all surfaces.

### 1. Palette & Surface Tokens

| Token Name | Light Mode Value | Dark Mode Value | Usage |
| :--- | :--- | :--- | :--- |
| **`--bg-page`** | `#FAF9F5` (Warm White) | `#0A0A0A` (Deep Charcoal) | Main background |
| **`--text-page`** | `#0A0A0A` (Dark Charcoal) | `#FAF9F5` (Soft White) | Primary text content |
| **`--bg-card`** | `#F2EFE9` (Warm Backdrop) | `#121212` (Surface Dark) | Card containers & form inputs |
| **`--border-card`** | `#E0DBD0` (Soft Border) | `#1F1F1F` (Dark Border) | Component & card borders |
| **`--text-muted`** | `#5E5E5E` (Muted Grey) | `#9A9997` (Warm Muted) | Help text, labels, hints, captions |
| **`--accent`** | `#00A2C9` (Deep Cyan) | `#01C8F1` (Bright Cyan) | Active states, primary buttons, focus rings |
| **`--bg-code-block`** | `#F4F1EA` | `#121212` | Code & log block container backdrop |
| **`--bg-code-inline`** | `#EDE9E0` | `#1A1A1A` | Inline code snippet backdrop |
| **`--border-code`** | `#D8D2C4` | `#262626` | Code block border |

### 2. Syntax Highlighting Tokens (Web Portal & Docs)

| Token Name | Light Mode Value | Dark Mode Value | Syntax Element |
| :--- | :--- | :--- | :--- |
| **`--code-keyword`** | `#006680` | `var(--accent)` (`#01C8F1`) | Language keywords, tags, selectors |
| **`--code-string`** | `#15803D` | `#4ADE80` | Text strings, regex literals, additions |
| **`--code-func`** | `#6B21A8` | `#C084FC` | Function calls, class names, built-ins |
| **`--code-number`** | `#C2410C` | `#F97316` | Numbers, booleans, constants |

---

## 🔤 Typography & Font Rules

1. **Interface Hierarchy**: Clean system sans-serif font stack for headings, navigation, settings, and standard body text:
   ```css
   font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
   ```
2. **Technical & Data Elements**: Monospace font stack for Node IDs, Pairing Keys (`sb_...`), scale multipliers, file keys, code blocks, and telemetry logs:
   ```css
   font-family: ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
   ```
3. **Accessibility**: All text colors must achieve **WCAG AA compliance ($\ge 4.5:1$ contrast ratio)** against their container background.

---

## 🧱 Component System Specifications

### 1. Buttons & Interactive Controls
* **Primary Button**: Background `var(--accent)`, text `#062026` (dark mode) / `#FAF9F5` (light mode), `font-weight: 600`, `border-radius: 6px` or `8px`. Focus ring `2px solid var(--accent)`.
* **Secondary Button**: Background `var(--bg-card)`, border `1px solid var(--border-card)`, text `var(--text-page)`.
* **Ghost / Dismiss Button**: Borderless or subtle border, text `var(--text-muted)` hovering to `var(--text-page)`.

### 2. Status Indicators & Badges
* **Pulsing Connection Dot**: `width: 8px; height: 8px; border-radius: 50%`.
  * **Connected / Idle**: Cyan (`var(--accent)`).
  * **Syncing / Rate-Limit Cooldown**: Amber (`#f59e0b`).
  * **Error / Disconnected**: Red (`#ef4444`).
* **Relay Capacity Banner**: Displays slot usage (e.g., `Community Relay: 14/40 Slots`) with manual refresh icon (`↻`) and cooldown timer.
* **No Emojis**: Emojis are strictly forbidden in user-facing UI screens. Vector outline icons (Lucide, `2px` stroke weight) must be used.

### 3. Card Containers & Inputs
* **Card Container**: Background `var(--bg-card)`, border `1px solid var(--border-card)`, radius `8px`, padding `12px` (standard) or `8px` (compact).
* **Form Inputs**: Background `var(--bg-card)`, border `1px solid var(--border-card)`, text `var(--text-page)`, monospace for IDs (`sb_...`). Focus state `outline: none; border-color: var(--accent)`.

### 4. Segmented Selectors & Options (`FormatScaleSelector`)
* **Format Switcher**: Compact pill container (PNG vs SVG), `font-size: 11px`, active segment highlighted with `var(--accent)`.
* **Scale Selector**: Monospace dropdown (`1x`, `2x`, `3x`, `4x`), compact padding (`4px 8px`).

### 5. Header & Navigation (`AppHeader`, `TabNav`)
* **Header Logo**: Brand dot (`8px` `--accent`), title sans-serif (`font-weight: 700`), version subtitle in monospace (`v0.16.1 Community`).
* **Tab Navigation Bar**: 3 main tabs (`Import`, `Sync`, `Settings`) with `var(--accent)` bottom border indicator on active tab.

### 6. Board Status Footer (`BoardStatusFooter`)
* **Fixed Bottom Bar**: Border top `1px solid var(--border-card)`, monospace status summary, tagline *"Stateless Design-Board Pipeline"*.

---

## 🌐 Web Documentation & Portal Components (`/docs`)

### 1. Code Blocks & Inline Snippets
* **Fenced Code Block (<pre>)**: Background `var(--bg-code-block)`, border `1px solid var(--border-code)`, radius `12px`, padding `1.25rem 1.5rem`.
* **Inline Code (`code`)**: Background `var(--bg-code-inline)`, border `1px solid var(--border-code)`, radius `6px`, font `13px var(--font-mono)`.

### 2. Callout & Alert Banners
* **GitHub Callouts**: Blocks (`> [!NOTE]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!TIP]`, `> [!CAUTION]`).
* **Styling**: Card backdrop `var(--bg-card)`, soft border `var(--border-card)`, and left accent bar.

### 3. Documentation Data Tables
* **Table Header**: Background `var(--bg-card)`, text `var(--text-page)`, `font-weight: 600`.
* **Table Rows**: Padding `0.75rem 1rem`, dividers `1px solid var(--border-card)`, text `var(--text-muted)`.

### 4. Mermaid Architecture Diagrams
* **Diagram Container**: Centered SVG canvas, `var(--bg-card)` backdrop, radius `12px`, border `1px solid var(--border-card)`.
* **Diagram Typography**: Monospace font (`14px`) for node labels, bold (`15px`) for section headers.

---

## 📐 Multi-Surface Parity Guidelines

| Surface | Width Context | Theme Support | Primary CSS Source |
| :--- | :--- | :--- | :--- |
| **Miro Sidebar Plugin** | Compact (320px–400px) | Light / Dark System | `src/app/globals.css` + `src/app/miro-plugin` |
| **FigJam App / Mirror** | Canvas Overlay | Light / Dark System | `src/app/figjam-mirror` + `figma-plugin/ui.html` |
| **Companion Plugins** | Plugin Panel | Light / Dark System | `public/figjam-companion-ui.html` |
| **Web Portal & Docs** | Responsive Full Page | Light / Dark System | `src/app/globals.css` + `src/app/docs` |
