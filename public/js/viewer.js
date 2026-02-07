import { SignalingClient } from './signaling-client.js';
import { createPeerConnection, getConnectionStats } from './webrtc-common.js';

// DOM elements
const remoteVideo = document.getElementById('remote-video');
const placeholder = document.getElementById('video-placeholder');
const scannerSection = document.getElementById('scanner-section');
const streamSection = document.getElementById('stream-section');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnScanAgain = document.getElementById('btn-scan-again');
const unmuteBanner = document.getElementById('unmute-banner');
const msgEl = document.getElementById('msg');

// Status elements
const dotConnection = document.getElementById('dot-connection');
const textConnection = document.getElementById('text-connection');
const textBattery = document.getElementById('text-battery');
const textDuration = document.getElementById('text-duration');
const audioMeter = document.getElementById('audio-meter');
const textQuality = document.getElementById('text-quality');

// State
let signaling = null;
let pc = null;
let scanner = null;
let statsInterval = null;
let wakeLock = null;
let roomId = null;
let authTokenValue = null;

function showMsg(text, type = 'error') {
  msgEl.textContent = text;
  msgEl.className = `message message-${type}`;
  msgEl.classList.remove('hidden');
}

function hideMsg() {
  msgEl.classList.add('hidden');
}

function updateConnection(state) {
  if (state === 'connected') {
    dotConnection.className = 'dot green';
    textConnection.textContent = 'Connected';
  } else if (state === 'connecting') {
    dotConnection.className = 'dot yellow';
    textConnection.textContent = 'Connecting';
  } else {
    dotConnection.className = 'dot red';
    textConnection.textContent = 'Disconnected';
  }
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

let noSleepVideo = null;
let silentAudioCtx = null;
let silentOscillator = null;

// Keep alive: Wake Lock + silent video + silent audio + Media Session
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {
      // Not critical
    }
  }

  if (!noSleepVideo) {
    noSleepVideo = document.createElement('video');
    noSleepVideo.setAttribute('playsinline', '');
    noSleepVideo.setAttribute('muted', '');
    noSleepVideo.muted = true;
    noSleepVideo.loop = true;
    noSleepVideo.style.position = 'fixed';
    noSleepVideo.style.top = '-1px';
    noSleepVideo.style.left = '-1px';
    noSleepVideo.style.width = '1px';
    noSleepVideo.style.height = '1px';
    noSleepVideo.style.opacity = '0.01';
    noSleepVideo.src = 'data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwH/////////FUmpZpkq17GDD0JATYCGQ2hyb21lV0WGQ2hyb21lFlSua7+uvdeBAXPFh2UBnmCBgoSBAlOAe1xzuEcAAAABBRFzd2V0AAAAABRFZ29tcAAAAAAAARqFlnOrg4OBACBsb2cAAAAQ4BIFaWRyAAAAeOnXhA==';
    document.body.appendChild(noSleepVideo);
  }
  noSleepVideo.play().catch(() => {});

  // Silent audio keeps page alive when screen is locked (Android Chrome)
  if (!silentAudioCtx) {
    try {
      silentAudioCtx = new AudioContext();
      silentOscillator = silentAudioCtx.createOscillator();
      const gain = silentAudioCtx.createGain();
      gain.gain.value = 0.001;
      silentOscillator.connect(gain);
      gain.connect(silentAudioCtx.destination);
      silentOscillator.start();
    } catch {
      // Not critical
    }
  }

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Sebicam Monitoring',
      artist: 'Baby Monitor',
    });
    navigator.mediaSession.playbackState = 'playing';
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
  if (noSleepVideo) {
    noSleepVideo.pause();
    noSleepVideo.remove();
    noSleepVideo = null;
  }
  if (silentOscillator) {
    silentOscillator.stop();
    silentOscillator = null;
  }
  if (silentAudioCtx) {
    silentAudioCtx.close();
    silentAudioCtx = null;
  }
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'none';
  }
}

// Re-acquire when page becomes visible again
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && pc) {
    if (!wakeLock) requestWakeLock();
    if (silentAudioCtx?.state === 'suspended') {
      silentAudioCtx.resume();
    }
  }
});

// Unmute on tap — must call play() within the user gesture for Chrome to allow audio
unmuteBanner.addEventListener('click', () => {
  remoteVideo.muted = false;
  remoteVideo.play().then(() => {
    unmuteBanner.classList.add('hidden');
  }).catch(() => {
    remoteVideo.muted = true;
  });
});

// Fullscreen toggle
btnFullscreen.addEventListener('click', () => {
  const container = document.getElementById('video-container');
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    container.requestFullscreen?.() || container.webkitRequestFullscreen?.();
  }
});

// QR Scanner
function startScanner() {
  scannerSection.classList.remove('hidden');
  streamSection.classList.add('hidden');

  scanner = new Html5Qrcode('qr-scanner');
  scanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 250, height: 250 } },
    (decodedText) => {
      handleQRCode(decodedText);
    },
    () => {
      // QR scan error (no code found) — ignore
    },
  ).catch((err) => {
    showMsg(`Camera error: ${err}`);
  });
}

function stopScanner() {
  if (scanner) {
    scanner.stop().catch(() => {});
    scanner = null;
  }
}

function handleQRCode(text) {
  try {
    const url = new URL(text);
    const room = url.searchParams.get('room');
    const token = url.searchParams.get('token');
    if (room && token) {
      stopScanner();
      joinRoom(room, token);
    }
  } catch {
    // Not a valid URL, ignore
  }
}

// Check URL params on load
function checkURLParams() {
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  const token = params.get('token');
  if (room && token) {
    joinRoom(room, token);
    return true;
  }
  return false;
}

// Join room via signaling
function joinRoom(room, token) {
  roomId = room;
  authTokenValue = token;

  scannerSection.classList.add('hidden');
  streamSection.classList.remove('hidden');
  updateConnection('connecting');

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  signaling = new SignalingClient(`${proto}://${location.host}`);

  signaling.on('connected', () => {
    signaling.send({ type: 'join-room', roomId: room, authToken: token });
  });

  signaling.on('disconnected', () => {
    updateConnection('disconnected');
  });

  signaling.on('room-joined', () => {
    updateConnection('connecting');
    hideMsg();
    showMsg('Waiting for broadcaster to connect...', 'info');
    requestWakeLock();
  });

  signaling.on('sdp-offer', async (msg) => {
    hideMsg();
    await handleOffer(msg.sdp);
  });

  signaling.on('ice-candidate', async (msg) => {
    if (pc) {
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch (e) {
        console.warn('ICE candidate error:', e);
      }
    }
  });

  signaling.on('status-update', (msg) => {
    const s = msg.status;
    if (s.battery) {
      const pct = Math.round(s.battery.level * 100);
      const icon = s.battery.charging ? '⚡' : '';
      textBattery.textContent = `Battery: ${pct}%${icon}`;
      document.getElementById('badge-battery').classList.remove('hidden');
    }
    if (s.audioLevel !== undefined) {
      audioMeter.style.width = `${Math.min(s.audioLevel * 100 * 3, 100)}%`;
    }
    if (s.streamDuration !== undefined) {
      textDuration.textContent = formatDuration(s.streamDuration);
    }
  });

  signaling.on('broadcaster-left', () => {
    showMsg('Broadcaster disconnected.', 'error');
    updateConnection('disconnected');
    closePeerConnection();
    btnScanAgain.classList.remove('hidden');
    releaseWakeLock();
  });

  signaling.on('error', (msg) => {
    showMsg(msg.message);
    if (msg.message === 'Invalid auth token' || msg.message === 'Room not found') {
      btnScanAgain.classList.add('hidden');
    }
  });

  signaling.connect();
}

async function handleOffer(sdp) {
  const isRenegotiation = pc && pc.signalingState !== 'closed';

  if (!isRenegotiation) {
    closePeerConnection();
    pc = createPeerConnection(signaling);
    setupPeerConnectionHandlers();
  }

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  signaling.send({ type: 'sdp-answer', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });

  // Check if the offer includes video
  const hasVideo = sdp.sdp && sdp.sdp.includes('m=video') && !sdp.sdp.includes('m=video 0');
  showVideoState(hasVideo);
}

function setupPeerConnectionHandlers() {
  const connectingMsg = document.getElementById('connecting-msg');
  const audioOnlyMsg = document.getElementById('audio-only-msg');
  let hasReceivedTrack = false;

  pc.ontrack = (event) => {
    console.log('ontrack:', event.track.kind);

    // Use the stream the broadcaster associated with addTrack
    if (event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
    } else {
      if (!remoteVideo.srcObject) {
        remoteVideo.srcObject = new MediaStream();
      }
      remoteVideo.srcObject.addTrack(event.track);
    }

    if (!hasReceivedTrack) {
      hasReceivedTrack = true;
      updateConnection('connected');
      startStatsMonitor();
      connectingMsg.classList.add('hidden');
      remoteVideo.play().catch(() => {});
      unmuteBanner.classList.remove('hidden');
    }

    if (event.track.kind === 'video') {
      showVideoState(true);
      event.track.onended = () => showVideoState(false);
      event.track.onmute = () => showVideoState(false);
      event.track.onunmute = () => showVideoState(true);
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log('ICE state:', pc.iceConnectionState);
    if (pc.iceConnectionState === 'connected') {
      updateConnection('connected');
    } else if (pc.iceConnectionState === 'failed') {
      showMsg('Connection failed.', 'error');
      updateConnection('disconnected');
      btnScanAgain.classList.remove('hidden');
    } else if (pc.iceConnectionState === 'disconnected') {
      updateConnection('connecting');
    }
  };
}

function showVideoState(hasVideo) {
  const audioOnlyMsg = document.getElementById('audio-only-msg');
  const connectingMsg = document.getElementById('connecting-msg');

  if (hasVideo) {
    placeholder.classList.add('hidden');
  } else {
    connectingMsg.classList.add('hidden');
    audioOnlyMsg.classList.remove('hidden');
    placeholder.classList.remove('hidden');
  }
}

function closePeerConnection() {
  if (pc) {
    pc.close();
    pc = null;
  }
  remoteVideo.srcObject = null;
  placeholder.classList.remove('hidden');
  stopStatsMonitor();
}

function startStatsMonitor() {
  stopStatsMonitor();
  statsInterval = setInterval(async () => {
    if (!pc) return;
    const stats = await getConnectionStats(pc);
    if (stats) {
      const rtt = Math.round(stats.roundTripTime * 1000);
      if (rtt < 100) {
        textQuality.textContent = `Quality: Good (${rtt}ms)`;
      } else if (rtt < 300) {
        textQuality.textContent = `Quality: Fair (${rtt}ms)`;
      } else {
        textQuality.textContent = `Quality: Poor (${rtt}ms)`;
      }
    }
  }, 3000);
}

function stopStatsMonitor() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
  textQuality.textContent = 'Quality: --';
}

// Scan again — tear down everything and go back to QR scanner
btnScanAgain.addEventListener('click', () => {
  btnScanAgain.classList.add('hidden');
  hideMsg();
  closePeerConnection();
  if (signaling) {
    signaling.disconnect();
    signaling = null;
  }
  roomId = null;
  authTokenValue = null;
  history.replaceState(null, '', location.pathname);
  startScanner();
});

// Initialize
if (!checkURLParams()) {
  startScanner();
}
