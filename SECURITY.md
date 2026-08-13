---
title: "Security Policy & Disclosure"
description: "Security architecture, vulnerability reporting procedures, zero-persistent-storage guarantees, and token encryption standards."
---

# Security Policy

## Supported Versions

We actively monitor and patch security vulnerabilities in SyncingBoard. Security updates are applied to the following versions:

| Version  | Supported       |
| -------- | --------------- |
| 0.16.x   | Yes ✅          |
| < 0.16.x | No              |

Always ensure you are running the latest release to receive active security updates.

---

## Security Posture

SyncingBoard is designed with a **zero-persistent-storage, cloud-relay-first** architecture that minimizes attack surface:

### Authentication & Token Handling

- **OAuth tokens are stored in Miro board storage** (via `board.storage.set`), with a **localStorage fallback** for same-origin contexts. Tokens are never persisted server-side beyond an ephemeral Upstash Redis cache (300s TTL) used only during OAuth popup handoff.
- Token refresh uses an ephemeral Upstash Redis cache (300s TTL) with automatic deletion on consumption — no long-lived token storage on the server.
- **OAuth CSRF protection** via cryptographically secure `state` parameters generated with `window.crypto.getRandomValues()`. State values are validated server-side before accepting the callback.
- **Pairing IDs** (design-source ↔ whiteboard link, incl. the FigJam app) are read-only fields in the UI, generated client-side via crypto-secure randomness (`window.crypto.getRandomValues()`, per `src/lib/sync/pairingId.ts`, `sb_` + 16 chars), so users cannot inject custom values. **They are bearer access keys:** anyone who holds an ID can read from an open, connected Figma/Penpot companion. For **Penpot** the pairing ID is the *only* credential (no OAuth); for **Figma**, imports and syncs additionally require the user's own Figma OAuth. Treat IDs like secrets, use one per board/companion pair, and disconnect companions when done — see `doc/setup.md` "Security & Pairing Best Practices". An optional per-pairing passphrase (PIN) to protect sensitive pairings is **planned** for a future release.

### Canvas Metadata & Cross-Board Security

- **Metadata minimization on canvas widgets** — SyncingBoard attaches lightweight reference metadata to canvas elements (e.g., Miro images) to maintain live synchronization with Figma and Penpot. This metadata contains only public/structural identifiers (`fileKey`, `nodeId`, `format`, `scale`, `platform`). It **never** stores OAuth tokens, API keys, or secret credentials.
- **Cross-board & external safety** — If a synchronized element is copied to another board, workspace, or external account, unauthorized users cannot pull live design updates. Every sync request enforces Figma/Penpot OAuth 2.0 permissions server-side: if the user initiating the sync lacks access to the target `fileKey`, the upstream API rejects the request (`403 Forbidden` / `404 Not Found`).
- **Resource identifiers vs. credentials** — File keys (e.g., Figma `fileKey`) are non-secret resource identifiers (equivalent to Google Doc IDs or URL path segments). Knowing a `fileKey` grants zero access without an authenticated account authorized in the source platform's Access Control List (ACL).

### API Protection

- **Community Plan rate limiting** — per-user token-based throttling on all sync endpoints. Identifiers are hashed with SHA-256 to avoid storing raw tokens in rate-limit counters. A global daily backstop (500 syncs/day) prevents free-tier budget exhaustion regardless of attacker IP cycling.
- **Token-based identification** — rate limit keys use `SHA256(OAuth token)` or `SHA256(pairingId)` instead of client IP, making the limiter immune to VPN/proxy cycling. IP-level fallback: the edge middleware applies a global catch-all (240 requests/minute per IP) across `/api/*`, so unauthenticated or IP-based traffic is still bounded when token hashing is not available.
- **Host-derived OAuth redirects** — OAuth auth/callback URLs are built from the incoming request Host header (normalized; `syncingboard.com` → `www.syncingboard.com`) and bound to the initiating window via CSRF `state` validated server-side before any token exchange. Cross-origin companions communicate over the Ably relay on explicit pairing channels (`figma:`/`penpot:`), never through permissive API CORS.
- **Generic error responses** — API endpoints sanitize exceptions to avoid leaking stack traces or internal paths to clients.
- **Orphan endpoint cleanup** — unused relay routes (`/api/relay/penpot/poll`, `/api/relay/penpot/register`) have been removed to reduce the attack surface.

### Transport Security

- **Penpot sync uses the cloud relay** (Ably WebSocket + Upstash Redis over public HTTPS), not localhost WebSocket or HTTP calls. This avoids exposure to **Private Network Access (PNA)** restrictions and prevents browsers from making mixed-content requests from `https://` origins to local servers.
- **Figma sync is cloud-native** — the Figma Render API delivers images directly to Miro via the SyncingBoard relay. No local servers or desktop agents are required for day-to-day sync.
- **SyncBridge (Tauri)** is fully **optional** — only needed for large images (>4.5MB), Adobe UXP integration, or local LLMs. When enabled, it uses a locally-trusted HTTPS certificate (`mkcert`) for secure communication with Miro Desktop (Electron).

### Surface Area Reduction

- Legacy Tauri bridge routes (WebSocket, local polling, local export triggers) have been pruned — the desktop app now only serves the capability-extender role.
- Temporary/scratch files (`.html` stubs, `.txt` notes) are excluded from production builds.
- **Miro SDK is delivered globally but inert outside Miro** — miro.js is loaded on every page via a plain `<script defer>` in `src/app/layout.tsx`; it is only ever **booted** (`miro.boot` + app config, Miro SDK v2) by the `miro-plugin` page under a live Miro plugin environment. Dashboard, docs, marketing, companions, and the FigJam app receive the bundle but never instantiate a connected session. Origin-ancestry gating of the script itself was previously attempted, but every variant broke the Miro app and was reverted.
- **FigJam app is destination-only** — it subscribes as a read-only client on `figma:<pairing>` channels and never registers in the source presence set, so it can never impersonate a design-source companion.

---

### GDPR & Data Protection

SyncingBoard's architecture is designed for **data minimization by default**, making self-hosted deployments naturally GDPR-compliant:

#### Data Flow Summary

| Data type | Where it lives | Duration | PII? |
|---|---|---|---|
| OAuth tokens (Figma, Miro) | Browser memory (React state) + Upstash Redis (300s TTL) | Session / 5 minutes | Yes (could identify a user) |
| Penpot pairing IDs | Browser memory + Redis relay result | Session / 180s TTL | Indirect (linkable to a session) |
| Image content (frame screenshots) | Vercel function memory + Upstash Redis (180s TTL) + Miro API | Ephemeral (< 180s) | No (design frame, not personal) |
| Canvas widget metadata (fileKey, nodeId) | Miro board item storage (Miro API) | Retained with Miro widget | No (public structural reference) |
| Client IP addresses | Vercel edge logs (standard HTTP logs) | Retained per Vercel's policy | Yes |
| User agent, request paths | Vercel function logs | Retained per Vercel's policy | No |

#### Self-Hosting (Recommended for GDPR)

SyncingBoard is open source. Self-hosting on your own infrastructure (Docker, VPS, ECS) means **no data leaves your control**:

- All OAuth tokens stay in your browser session or your Redis instance
- Image data flows through your Vercel/Next.js deployment and your Redis
- No third party accesses your design data
- You are the data controller and processor — no DPA needed with SyncingBoard project

#### Public Instance (syncingboard.com)

If using the public demo instance, the operator acts as a **data processor**. The following sub-processors are involved:

| Sub-processor | Service | GDPR DPA | Data processed |
|---|---|---|---|
| **Vercel Inc.** | Serverless hosting | [Vercel DPA](https://vercel.com/legal/dpa) | HTTP requests, IP addresses, function logs |
| **Ably Inc.** | WebSocket relay | [Ably DPA](https://ably.com/legal/data-processing-agreement) | Penpot command messages (no PII, only pairing IDs) |
| **Upstash Inc.** | Redis cache | [Upstash DPA](https://upstash.com/gdpr) | OAuth tokens (300s TTL), relay results (180s TTL) |

#### Your Rights (Art. 15-22 GDPR)

Since SyncingBoard stores **no persistent user data**:

- **Right to access / erasure:** There is no database with user records to access or delete. OAuth tokens are ephemeral (300s TTL or browser session lifetime).
- **Right to data portability:** We do not store any personal data that could be exported.
- **Right to object:** Self-hosting eliminates all third-party data processing.

For any GDPR-related inquiries about the public instance, contact: `security@syncingboard.com`

---

## Reporting a Vulnerability

**Do not open public GitHub issues for security vulnerabilities.**

If you discover a security vulnerability or exploit in SyncingBoard, please report it privately:

- **Email:** security@syncingboard.com

When reporting, include:

1. A detailed description of the vulnerability.
2. Step-by-step instructions or proof-of-concept (PoC) to reproduce the issue.
3. The potential impact and any affected components (e.g., OAuth flow, relay transport, API endpoints).

We will:

- **Acknowledge** your report within **48 hours**.
- **Investigate** and determine a remediation plan.
- **Release a patch** and notify you when a fix is available.

Please keep the details confidential until we have had reasonable time to secure our users' environments and release a fix.

Thank you for helping keep SyncingBoard secure!
