# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Sebicam is a local-network baby monitor. Phone A broadcasts encrypted video/audio via WebRTC; Phone B views it in a browser. The server only handles WebSocket signaling — media flows peer-to-peer.

## Commands

```bash
npm install                  # Install dependencies
npm run generate-cert        # One-time: self-signed TLS cert in certs/
npm run dev                  # Dev server (tsx, compiles TS on-the-fly), HTTPS on port 3000
npm run build                # Compile TypeScript to dist/server/ (tsc)
```

No test framework is configured. No linter is configured.

## Architecture

```
Phone A (Broadcaster) <--WebSocket--> Express+WSS Server <--WebSocket--> Phone B (Viewer)
         \                                                                /
          ================== WebRTC P2P (encrypted media) ===============
```

**Server (TypeScript, `src/server/`):**
- `index.ts` — HTTPS server (self-signed cert) + Express static file serving + WebSocket server setup. Auto-detects LAN IP.
- `signaling.ts` — Room management (in-memory Map), auth via `roomId` + `authToken` with `crypto.timingSafeEqual`, message relay between broadcaster/viewer. Rooms cleaned up every 5 min (12h TTL). One viewer per room.
- `types.ts` — Message type definitions for client/server WebSocket protocol.

**Frontend (Vanilla JS, `public/`):**
- `js/signaling-client.js` — WebSocket client wrapper with auto-reconnect (2s interval), event emitter pattern.
- `js/webrtc-common.js` — Shared WebRTC utilities: peer connection factory (Google STUN), connection stats, audio meter via Web Audio API.
- `js/broadcaster.js` — Camera/mic capture, WebRTC offer creation, QR code generation (room URL with auth params), 4-layer keep-alive (Wake Lock + silent video loop + silent audio oscillator + Media Session API), battery/audio status updates.
- `js/viewer.js` — QR scanning or direct URL params, WebRTC answer, remote stream display, connection quality monitoring.
- `lib/` — Vendored minified libraries (qrcodejs, html5-qrcode). No npm frontend dependencies.

**Key design decisions:**
- No bundler — pure vanilla JS with ES modules in the browser.
- ES modules throughout (`"type": "module"` in package.json, `"module": "NodeNext"` in tsconfig).
- Server is TypeScript; frontend is plain JavaScript (no compilation step for frontend).
- Dark theme CSS optimized for nighttime use, mobile-first with safe area insets.
- HTTPS is mandatory (browsers require it for `getUserMedia`).
