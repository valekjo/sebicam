# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Sebicam is a local-network baby monitor. Phone A broadcasts encrypted audio via WebRTC; Phone B listens in a browser. The server only serves static files — signaling is done via QR codes, and media flows peer-to-peer.

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
Phone A (Broadcaster) ----QR codes----> Phone B (Viewer)
         \                                    /
          ======= WebRTC P2P (encrypted) ====
```

### Two-phase connection

**Phase 1 — QR-based (data channel only):**
1. Broadcaster creates a data-channel-only WebRTC offer, encodes it as compact binary (`SBC1:` prefix), and displays it as a QR code
2. Viewer scans the QR, creates an answer, and displays *its own* QR code back
3. Broadcaster scans the viewer's QR to complete the ICE/DTLS connection
4. Data channel opens

**Phase 2 — real SDP over data channel (audio):**
5. Broadcaster adds audio tracks to the peer connection, creates a new offer (full browser-generated SDP), and sends it over the data channel
6. Viewer receives the real offer, creates a real answer, sends it back over the data channel
7. Audio flows with properly negotiated codecs — no synthetic SDP, no codec mismatch

This two-phase design exists because compact QR-encoded SDPs can't faithfully represent all codec/extension details browsers need. The QR exchange only bootstraps connectivity; real media negotiation uses full SDPs over the data channel.

### Server (TypeScript, `src/server/`)

- `index.ts` — HTTPS server (self-signed cert) + Express static file serving from `docs/`. Auto-detects LAN IP. No signaling logic on the server.

### Frontend (Vanilla JS, `docs/`)

- `index.html` — Landing page with role selection (broadcaster vs viewer). Registers the service worker.
- `sw.js` — Service worker for offline/PWA support. Cache-first strategy with background version checks via `version.json`.
- `js/sdp-codec.js` — Compact binary SDP encoding (`SBC1:` format v2): extracts DTLS fingerprint, ICE credentials (ufrag/pwd), and up to 3 ICE candidates (IPv4 or mDNS `.local`) into ~100-byte binary, base64url-encoded. Used only for the initial data-channel-only handshake. `decodeAnswerForOffer` transforms the broadcaster's real offer SDP into an answer by substituting the viewer's credentials.
- `js/data-channel.js` — `DataChannelSignaling` class: RTCDataChannel wrapper with event emitter pattern (`on`/`off`/`send`). Carries `sdp-offer`, `sdp-answer`, `ice-candidate`, and `status-update` messages as JSON.
- `js/webrtc-common.js` — Shared WebRTC utilities: peer connection factory (Google STUN), connection stats, audio meter via Web Audio API.
- `js/broadcaster.js` — Audio capture, data-channel-only offer creation, QR code generation, QR scanning for viewer's answer, audio renegotiation over data channel, 3-layer keep-alive (Wake Lock + silent video loop + silent audio oscillator + Media Session API), battery/audio status updates via DataChannel.
- `js/viewer.js` — QR scanning for broadcaster's offer, answer QR display, audio renegotiation handling via DataChannel, remote audio playback with autoplay/unmute handling.
- `lib/` — Vendored minified libraries (qrcodejs, html5-qrcode). No npm frontend dependencies.

### Key design decisions

- No bundler — pure vanilla JS with ES modules in the browser.
- ES modules throughout (`"type": "module"` in package.json, `"module": "NodeNext"` in tsconfig).
- Server is TypeScript; frontend is plain JavaScript (no compilation step for frontend).
- Dark theme CSS optimized for nighttime use, mobile-first with safe area insets.
- HTTPS is mandatory (browsers require it for `getUserMedia`).
- Audio-only: no video support currently.
- LAN-only design: uses Google STUN servers but no TURN relay. ICE candidates include mDNS `.local` hostnames for reliable LAN connectivity.
