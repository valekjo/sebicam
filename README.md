# Sebicam

Local-network baby monitor. Phone A streams encrypted video/audio; Phone B views it in a browser. Media flows peer-to-peer via WebRTC — the server only handles signaling.

## Architecture

```
Phone A (Broadcaster)  <--WebSocket-->  Express+WSS Server  <--WebSocket-->  Phone B (Viewer)
         \                                                                    /
          \================== WebRTC P2P (encrypted media) =================/
```

- **Server**: HTTPS (self-signed cert for LAN) + WebSocket signaling only
- **Transport**: WebRTC peer-to-peer with built-in DTLS-SRTP encryption
- **Auth**: Server generates `roomId` + `authToken` per session, encoded in a QR code
- **No bundler**: Vanilla JS with ES modules

## Quick Start

```bash
npm install
npm run generate-cert   # one-time: generates self-signed TLS cert in certs/
npm run dev             # starts HTTPS server on port 3000
```

Open the printed Network URL (e.g. `https://192.168.1.x:3000`) on Phone A. Accept the certificate warning, then tap **Start**. A QR code appears — scan it with Phone B to begin viewing.

## Usage

### Phone A — Broadcaster

1. Open `https://<LAN_IP>:3000` on the phone that will be placed near the baby
2. Allow camera and microphone access
3. Tap **Start** — camera preview and a QR code appear
4. Place the phone with a view of the baby

### Phone B — Viewer

1. Scan the QR code shown on Phone A (any QR scanner app works — the code is a URL)
2. Accept the certificate warning
3. Video and audio stream from Phone A appears

Alternatively, if you already have the URL with `?room=...&token=...` parameters, open it directly — the viewer page will skip the QR scanner and connect automatically.

## Features

- **Dark theme** — designed for nighttime use
- **Battery status** — broadcaster's battery level shown on both phones
- **Audio level meter** — visual indicator of sound in the room
- **Connection quality** — round-trip time displayed on the viewer
- **Stream duration** — elapsed time counter
- **Wake Lock** — keeps the viewer screen on during monitoring
- **Fullscreen** — tap the fullscreen button on the viewer video
- **Auto-reconnect** — WebSocket reconnects automatically on disconnect
- **Secure by default** — HTTPS required (for `getUserMedia`), WebRTC media encrypted via DTLS-SRTP, auth tokens use `crypto.randomBytes` with timing-safe comparison

## Project Structure

```
sebicam/
├── package.json
├── tsconfig.json
├── scripts/
│   └── generate-cert.sh          # Self-signed TLS cert generator
├── certs/                         # Gitignored — generated TLS certs
├── src/server/
│   ├── index.ts                   # HTTPS + Express + WSS entry point
│   ├── signaling.ts               # Room management, auth, message relay
│   └── types.ts                   # Signaling message types
├── public/
│   ├── broadcaster.html           # Phone A page
│   ├── viewer.html                # Phone B page
│   ├── css/styles.css             # Dark theme, mobile-first
│   ├── js/
│   │   ├── broadcaster.js         # Camera capture, WebRTC offer, QR generation
│   │   ├── viewer.js              # QR scan, WebRTC answer, stream display
│   │   ├── webrtc-common.js       # Shared ICE config, stats, audio meter
│   │   └── signaling-client.js    # WebSocket client wrapper
│   └── lib/
│       ├── qrcode.min.js          # Vendored QR generation (qrcodejs)
│       └── html5-qrcode.min.js    # Vendored QR scanning (html5-qrcode)
```

## Requirements

- Node.js 18+
- Both phones on the same local network
- openssl (for certificate generation)

## Limitations

- LAN only — no TURN server, so it won't work across different networks
- Single viewer per session
- Self-signed certificate requires manually accepting the browser warning on each device
