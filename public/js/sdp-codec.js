// Compact SDP encoding/decoding for QR code exchange
//
// Used ONLY for the initial data-channel-only connection.
// Audio/video negotiation happens afterward over the data channel with real SDPs.
//
// Binary format (SBC1, version 2):
//   [0]      version + flags: bits 7-4 = version (2), bit 0 = isOffer
//   [1..32]  DTLS fingerprint (32 bytes, SHA-256)
//   [33]     ufrag length (1 byte)
//   [34..34+ufragLen-1]  ICE ufrag (UTF-8)
//   [next]   pwd length (1 byte)
//   [next..next+pwdLen-1]  ICE pwd (UTF-8)
//   [next]   candidate count (1 byte)
//   For each candidate:
//     [1 byte]  address type: 0=IPv4, 1=hostname (mDNS .local)
//     For type 0: [4 bytes] IPv4 address
//     For type 1: [1 byte] hostname length + [N bytes] hostname (UTF-8)
//     [2 bytes] port (big-endian)
//     [1 byte]  candidate type: 0=host, 1=srflx, 2=relay

const PREFIX = 'SBC1:';

/**
 * Wait for ICE gathering to complete (or timeout).
 */
export function waitForICEGathering(pc, timeout = 5000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve(pc.localDescription);
      return;
    }

    const timer = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onStateChange);
      resolve(pc.localDescription);
    }, timeout);

    function onStateChange() {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onStateChange);
        resolve(pc.localDescription);
      }
    }

    pc.addEventListener('icegatheringstatechange', onStateChange);
  });
}

/**
 * Encode an SDP into a compact base64url string for QR display.
 */
export function encodeSDP(desc) {
  const sdp = desc.sdp;
  const isOffer = desc.type === 'offer';

  // Extract DTLS fingerprint
  const fpMatch = sdp.match(/a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)/);
  if (!fpMatch) throw new Error('No DTLS fingerprint in SDP');
  const fpBytes = fpMatch[1].split(':').map(h => parseInt(h, 16));

  // Extract ICE ufrag and pwd
  const ufragMatch = sdp.match(/a=ice-ufrag:(\S+)/);
  const pwdMatch = sdp.match(/a=ice-pwd:(\S+)/);
  if (!ufragMatch || !pwdMatch) throw new Error('No ICE credentials in SDP');
  const ufrag = ufragMatch[1];
  const pwd = pwdMatch[1];

  // Extract ICE candidates — IPv4 and mDNS hostname (.local), UDP only, limit to 3
  const candidateRegex = /a=candidate:\S+\s+\d+\s+udp\s+\d+\s+(\S+)\s+(\d+)\s+typ\s+(host|srflx|relay)/g;
  const candidates = [];
  let m;
  while ((m = candidateRegex.exec(sdp)) !== null && candidates.length < 3) {
    const addr = m[1];
    const port = parseInt(m[2], 10);
    const type = m[3];
    if (/^\d+\.\d+\.\d+\.\d+$/.test(addr) || addr.endsWith('.local')) {
      candidates.push({ addr, port, type });
    }
  }

  if (candidates.length === 0) {
    console.warn('No usable ICE candidates found in SDP. Connection will likely fail.');
  }
  console.log('Encoded candidates:', candidates);

  // Build binary buffer
  const ufragBuf = new TextEncoder().encode(ufrag);
  const pwdBuf = new TextEncoder().encode(pwd);

  let candidateSize = 0;
  for (const c of candidates) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(c.addr)) {
      candidateSize += 1 + 4 + 2 + 1;
    } else {
      const addrBuf = new TextEncoder().encode(c.addr);
      candidateSize += 1 + 1 + addrBuf.length + 2 + 1;
    }
  }

  const totalSize = 1 + 32 + 1 + ufragBuf.length + 1 + pwdBuf.length + 1 + candidateSize;
  const buf = new Uint8Array(totalSize);
  let offset = 0;

  let flags = 0x20; // version 2
  if (isOffer) flags |= 0x01;
  buf[offset++] = flags;

  for (let i = 0; i < 32; i++) buf[offset++] = fpBytes[i];

  buf[offset++] = ufragBuf.length;
  buf.set(ufragBuf, offset);
  offset += ufragBuf.length;

  buf[offset++] = pwdBuf.length;
  buf.set(pwdBuf, offset);
  offset += pwdBuf.length;

  buf[offset++] = candidates.length;
  for (const c of candidates) {
    const isIPv4 = /^\d+\.\d+\.\d+\.\d+$/.test(c.addr);
    if (isIPv4) {
      buf[offset++] = 0x00;
      const parts = c.addr.split('.').map(Number);
      buf[offset++] = parts[0];
      buf[offset++] = parts[1];
      buf[offset++] = parts[2];
      buf[offset++] = parts[3];
    } else {
      buf[offset++] = 0x01;
      const addrBuf = new TextEncoder().encode(c.addr);
      buf[offset++] = addrBuf.length;
      buf.set(addrBuf, offset);
      offset += addrBuf.length;
    }
    buf[offset++] = (c.port >> 8) & 0xff;
    buf[offset++] = c.port & 0xff;
    buf[offset++] = c.type === 'host' ? 0 : c.type === 'srflx' ? 1 : 2;
  }

  return PREFIX + arrayToBase64url(buf.slice(0, offset));
}

/**
 * Parse the compact binary into structured fields.
 */
function parseCompact(encoded) {
  if (!encoded.startsWith(PREFIX)) throw new Error('Invalid SBC1 prefix');
  const buf = base64urlToArray(encoded.slice(PREFIX.length));
  let offset = 0;

  const flags = buf[offset++];
  const version = (flags >> 4) & 0x0f;
  if (version !== 1 && version !== 2) throw new Error(`Unsupported SBC version: ${version}`);
  const isOffer = !!(flags & 0x01);

  const fpBytes = [];
  for (let i = 0; i < 32; i++) fpBytes.push(buf[offset++]);
  const fingerprint = fpBytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');

  const ufragLen = buf[offset++];
  const ufrag = new TextDecoder().decode(buf.slice(offset, offset + ufragLen));
  offset += ufragLen;

  const pwdLen = buf[offset++];
  const pwd = new TextDecoder().decode(buf.slice(offset, offset + pwdLen));
  offset += pwdLen;

  const candidateCount = buf[offset++];
  const candidates = [];

  if (version === 1) {
    for (let i = 0; i < candidateCount; i++) {
      const addr = `${buf[offset++]}.${buf[offset++]}.${buf[offset++]}.${buf[offset++]}`;
      const port = (buf[offset++] << 8) | buf[offset++];
      const typeNum = buf[offset++];
      const type = typeNum === 0 ? 'host' : typeNum === 1 ? 'srflx' : 'relay';
      candidates.push({ addr, port, type });
    }
  } else {
    for (let i = 0; i < candidateCount; i++) {
      const addrType = buf[offset++];
      let addr;
      if (addrType === 0x00) {
        addr = `${buf[offset++]}.${buf[offset++]}.${buf[offset++]}.${buf[offset++]}`;
      } else {
        const addrLen = buf[offset++];
        addr = new TextDecoder().decode(buf.slice(offset, offset + addrLen));
        offset += addrLen;
      }
      const port = (buf[offset++] << 8) | buf[offset++];
      const typeNum = buf[offset++];
      const type = typeNum === 0 ? 'host' : typeNum === 1 ? 'srflx' : 'relay';
      candidates.push({ addr, port, type });
    }
  }

  return { isOffer, fingerprint, ufrag, pwd, candidates };
}

/**
 * Decode a compact offer string to a data-channel-only SDP for the viewer.
 */
export function decodeSDP(encoded) {
  const parsed = parseCompact(encoded);
  const type = parsed.isOffer ? 'offer' : 'answer';
  const sdp = buildDataChannelSDP({ ...parsed, type });
  return { type, sdp };
}

/**
 * Decode a compact answer, building an SDP that matches the broadcaster's
 * real offer by substituting the viewer's ICE/DTLS credentials.
 */
export function decodeAnswerForOffer(encoded, offerSdp) {
  const parsed = parseCompact(encoded);

  const candidateLines = parsed.candidates.map((c, i) => {
    const priority = c.type === 'host' ? 2130706431 - i : c.type === 'srflx' ? 1694498815 - i : 16777215 - i;
    return `a=candidate:${i} 1 udp ${priority} ${c.addr} ${c.port} typ ${c.type}`;
  });

  let sdp = offerSdp;

  // Replace ICE credentials with viewer's
  sdp = sdp.replace(/a=ice-ufrag:\S+/g, `a=ice-ufrag:${parsed.ufrag}`);
  sdp = sdp.replace(/a=ice-pwd:\S+/g, `a=ice-pwd:${parsed.pwd}`);
  sdp = sdp.replace(/a=fingerprint:sha-256\s+[0-9A-Fa-f:]+/g, `a=fingerprint:sha-256 ${parsed.fingerprint}`);

  // Change DTLS role: offer actpass → answer active
  sdp = sdp.replace(/a=setup:actpass/g, 'a=setup:active');

  // Remove offer-specific lines
  sdp = sdp.replace(/a=candidate:[^\r\n]*\r?\n/g, '');
  sdp = sdp.replace(/a=end-of-candidates[^\r\n]*\r?\n/g, '');

  // Insert viewer's candidates into the first m-section (BUNDLE shares transport)
  const lines = sdp.split('\r\n');
  const result = [];
  let firstMediaFound = false;
  let candidatesInserted = false;

  for (let i = 0; i < lines.length; i++) {
    result.push(lines[i]);

    if (lines[i].startsWith('m=')) {
      if (!firstMediaFound) {
        firstMediaFound = true;
      } else if (!candidatesInserted) {
        const mLine = result.pop();
        for (const cl of candidateLines) result.push(cl);
        candidatesInserted = true;
        result.push(mLine);
      }
    }
  }

  if (!candidatesInserted && candidateLines.length > 0) {
    while (result.length > 0 && result[result.length - 1] === '') {
      result.pop();
    }
    for (const cl of candidateLines) result.push(cl);
    result.push('');
  }

  return { type: 'answer', sdp: result.join('\r\n') };
}

export function isCompactSDP(text) {
  return text.startsWith(PREFIX);
}

/**
 * Build a minimal data-channel-only SDP.
 * Audio/video negotiation happens later over the data channel with real SDPs.
 */
function buildDataChannelSDP({ type, fingerprint, ufrag, pwd, candidates }) {
  const sessionId = Math.floor(Date.now() / 1000);
  const candidateLines = candidates.map((c, i) => {
    const priority = c.type === 'host' ? 2130706431 - i : c.type === 'srflx' ? 1694498815 - i : 16777215 - i;
    return `a=candidate:${i} 1 udp ${priority} ${c.addr} ${c.port} typ ${c.type}`;
  }).join('\r\n');

  const lines = [
    'v=0',
    `o=- ${sessionId} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS *',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    `a=fingerprint:sha-256 ${fingerprint}`,
    type === 'offer' ? 'a=setup:actpass' : 'a=setup:active',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ];

  if (candidateLines) lines.push(candidateLines);

  return lines.join('\r\n') + '\r\n';
}

function arrayToBase64url(arr) {
  let binary = '';
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToArray(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return arr;
}
