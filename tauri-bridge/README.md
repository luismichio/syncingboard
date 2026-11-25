# SyncingBridge (Tauri v2 Desktop App)

Optional local zero-cloud companion broker for **SyncingBoard** (`ws://127.0.0.1:4401`). Unlocks local Figma `exportAsync()`, direct 50 MB Miro image `PATCH` uploads, live Figma selection auto-detect, up to 50 Figma frames per batch, and configurable OS-wide global shortcuts — with zero Figma REST, Vercel, Ably, or Upstash usage.

> **Note:** SyncingBridge is **not required** for cloud sync (Figma, Penpot, or GitHub Markdown docs).

## Current Distribution Status

- **Pre-built binaries are not yet published** on GitHub Releases; run or build from source using the commands below.
- **Unsigned builds:** Automated GitHub Actions releases (`.github/workflows/release-tauri.yml`) do not yet include Apple notarization or Windows Authenticode signing. See [doc/setup.md](../doc/setup.md#current-distribution--os-security-notes) for macOS Gatekeeper (`xattr -cr`) and Windows SmartScreen instructions.

## Development & Local Build

```bash
# Install dependencies (from tauri-bridge/)
yarn install

# Run in development mode (from repo root)
yarn tauri:dev

# Build native installer for your current OS (from tauri-bridge/)
yarn tauri build
```

For full prerequisites (Rust, OS build toolkits, troubleshooting, and release steps), see [doc/setup.md](../doc/setup.md#tauri-desktop-app-syncingbridge-optional).
