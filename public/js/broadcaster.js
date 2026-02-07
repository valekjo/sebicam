import { createPeerConnection, createAudioMeter } from './webrtc-common.js';
import { encodeSDP, decodeAnswerForOffer, waitForICEGathering, isCompactSDP } from './sdp-codec.js';
import { DataChannelSignaling } from './data-channel.js';

// DOM elements
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnScanResponse = document.getElementById('btn-scan-response');
const qrContainer = document.getElementById('qr-container');
const qrLabel = document.getElementById('qr-label');
const scannerContainer = document.getElementById('scanner-container');
const msgEl = document.getElementById('msg');

// Status elements
const dotConnection = document.getElementById('dot-connection');
const textConnection = document.getElementById('text-connection');
const textBattery = document.getElementById('text-battery');
const dotViewer = document.getElementById('dot-viewer');
const textViewer = document.getElementById('text-viewer');
const textDuration = document.getElementById('text-duration');
const audioMeter = document.getElementById('audio-meter');

// State
let pc = null;
let dataChannel = null;
let dcSignaling = null;
let audioStream = null;
let audioMeterInstance = null;
let streamStartTime = null;
let statusInterval = null;
let durationInterval = null;
let wakeLock = null;
let noSleepVideo = null;
let silentAudioCtx = null;
let silentOscillator = null;
let scanner = null;

// Keep alive strategy (3 layers):
//   1. Wake Lock API — prevents screen dimming
//   2. Silent video loop — prevents screen lock on some devices
//   3. Silent audio output + Media Session — keeps page alive when screen IS locked

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
      title: 'Sebicam Broadcasting',
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

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && audioStream) {
    if (!wakeLock) requestWakeLock();
    if (silentAudioCtx?.state === 'suspended') {
      silentAudioCtx.resume();
    }
  }
});

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
  } else {
    dotConnection.className = 'dot red';
    textConnection.textContent = 'Disconnected';
  }
}

function updateViewerStatus(connected) {
  if (connected) {
    dotViewer.className = 'dot green';
    textViewer.textContent = 'Viewer connected';
  } else {
    dotViewer.className = 'dot';
    textViewer.textContent = 'No viewer';
  }
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function startBatteryMonitor() {
  if (!('getBattery' in navigator)) {
    document.getElementById('badge-battery').classList.add('hidden');
    return;
  }
  try {
    const battery = await navigator.getBattery();
    const update = () => {
      const pct = Math.round(battery.level * 100);
      const icon = battery.charging ? '\u26A1' : '';
      textBattery.textContent = `Battery: ${pct}%${icon}`;
      if (dcSignaling?.connected) {
        dcSignaling.send({
          type: 'status-update',
          status: { battery: { level: battery.level, charging: battery.charging } },
        });
      }
    };
    battery.addEventListener('levelchange', update);
    battery.addEventListener('chargingchange', update);
    update();
  } catch {
    document.getElementById('badge-battery').classList.add('hidden');
  }
}

async function startAudio() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showMsg(
      'Media API not available. On Chrome Android with a self-signed certificate, open chrome://flags/#unsafely-treat-insecure-origin-as-secure, add ' +
      location.origin + ', relaunch Chrome, and reload this page.',
    );
    return false;
  }

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioMeterInstance = createAudioMeter(audioStream);
    return true;
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      showMsg(
        'Microphone permission denied (' + err.name + ': ' + err.message + '). ' +
        'Tap the lock/info icon in the address bar \u2192 Site settings \u2192 allow Microphone.',
      );
    } else if (err.name === 'NotFoundError') {
      showMsg('No microphone found on this device.');
    } else {
      showMsg(`Microphone error: ${err.message}`);
    }
    return false;
  }
}

// Negotiate audio over the data channel (renegotiation with real SDP)
async function negotiateAudio() {
  if (!pc || !dcSignaling?.connected || !audioStream) return;
  try {
    // Add audio tracks to the existing peer connection
    for (const track of audioStream.getAudioTracks()) {
      pc.addTrack(track, audioStream);
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Trickle ICE for renegotiation (usually no new candidates for BUNDLE)
    pc.onicecandidate = (event) => {
      if (event.candidate && dcSignaling?.connected) {
        dcSignaling.send({ type: 'ice-candidate', candidate: event.candidate.toJSON() });
      }
    };

    // Send the REAL SDP offer (not compact) over the data channel
    dcSignaling.send({ type: 'sdp-offer', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    console.log('Sent audio offer over data channel');
  } catch (err) {
    console.warn('Audio negotiation failed:', err);
  }
}

function stopAll() {
  if (audioStream) {
    audioStream.getTracks().forEach(t => t.stop());
    audioStream = null;
  }
  if (audioMeterInstance) {
    audioMeterInstance.destroy();
    audioMeterInstance = null;
  }
}

// Initial offer: data channel ONLY (no audio yet — audio is added after DC opens)
async function createOfferAndShowQR() {
  closePeerConnection();

  pc = createPeerConnection();

  // Create data channel before offer (so it's in the SDP)
  dataChannel = pc.createDataChannel('signaling');
  setupDataChannel(dataChannel);

  pc.oniceconnectionstatechange = () => {
    console.log('ICE state:', pc.iceConnectionState);
    if (pc.iceConnectionState === 'connected') {
      updateConnection('connected');
      updateViewerStatus(true);
      hideMsg();
      // Hide QR and scanner UI
      qrContainer.classList.add('hidden');
      qrLabel.classList.add('hidden');
      btnScanResponse.classList.add('hidden');
      scannerContainer.classList.add('hidden');
    } else if (pc.iceConnectionState === 'failed') {
      showMsg('Connection to viewer failed. Tap Stop and try again.', 'error');
      updateViewerStatus(false);
    } else if (pc.iceConnectionState === 'disconnected') {
      updateConnection('disconnected');
      updateViewerStatus(false);
      pc.restartIce();
      showMsg('Connection lost, attempting to reconnect...', 'info');
      setTimeout(() => {
        if (pc && pc.iceConnectionState !== 'connected') {
          showMsg('Connection lost. Tap Stop and start again to reconnect.', 'error');
        }
      }, 10000);
    }
  };

  // Create offer and wait for ICE gathering
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  showMsg('Gathering connection info...', 'info');

  const desc = await waitForICEGathering(pc);
  hideMsg();

  // Encode and display QR
  const encoded = encodeSDP(desc);
  console.log('Offer QR payload:', encoded.length, 'chars');
  showOfferQR(encoded);
}

function showOfferQR(encoded) {
  qrContainer.innerHTML = '';
  qrContainer.classList.remove('hidden');
  qrLabel.textContent = 'Step 1: Scan this QR with the viewer phone';
  qrLabel.classList.remove('hidden');
  btnScanResponse.classList.remove('hidden');

  new QRCode(qrContainer, {
    text: encoded,
    width: 200,
    height: 200,
    colorDark: '#000000',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.L,
  });
}

function setupDataChannel(channel) {
  dcSignaling = new DataChannelSignaling(channel);

  dcSignaling.on('connected', () => {
    console.log('Data channel open — negotiating audio');
    negotiateAudio();
  });

  // Handle renegotiation answers from viewer
  dcSignaling.on('sdp-answer', async (msg) => {
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      console.log('Set remote answer, audio should flow now');
    }
  });

  dcSignaling.on('ice-candidate', async (msg) => {
    if (pc) {
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch (e) {
        console.warn('ICE candidate error:', e);
      }
    }
  });
}

function startResponseScanner() {
  scannerContainer.classList.remove('hidden');
  qrContainer.classList.add('hidden');
  qrLabel.textContent = 'Step 2: Scan the QR shown on the viewer phone';
  btnScanResponse.classList.add('hidden');

  scanner = new Html5Qrcode('response-scanner');
  scanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 250, height: 250 } },
    (decodedText) => {
      if (isCompactSDP(decodedText)) {
        handleResponseQR(decodedText);
      }
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
  scannerContainer.classList.add('hidden');
}

async function handleResponseQR(encoded) {
  stopScanner();
  qrLabel.classList.add('hidden');

  try {
    const { type, sdp } = decodeAnswerForOffer(encoded, pc.localDescription.sdp);

    showMsg('Connecting...', 'info');
    await pc.setRemoteDescription(new RTCSessionDescription({ type, sdp }));
  } catch (err) {
    showMsg(`Failed to process viewer QR: ${err.message}`);
  }
}

function closePeerConnection() {
  if (pc) {
    pc.close();
    pc = null;
  }
  if (dcSignaling) {
    dcSignaling = null;
  }
  dataChannel = null;
}

function startStatusUpdates() {
  statusInterval = setInterval(() => {
    if (audioMeterInstance) {
      const level = audioMeterInstance.getLevel();
      audioMeter.style.width = `${Math.min(level * 100 * 3, 100)}%`;

      if (dcSignaling?.connected) {
        dcSignaling.send({
          type: 'status-update',
          status: { audioLevel: level },
        });
      }
    }
  }, 200);

  streamStartTime = Date.now();
  durationInterval = setInterval(() => {
    const elapsed = (Date.now() - streamStartTime) / 1000;
    textDuration.textContent = formatDuration(elapsed);

    if (dcSignaling?.connected) {
      dcSignaling.send({
        type: 'status-update',
        status: { streamDuration: elapsed },
      });
    }
  }, 1000);
}

function stopStatusUpdates() {
  if (statusInterval) clearInterval(statusInterval);
  if (durationInterval) clearInterval(durationInterval);
  statusInterval = null;
  durationInterval = null;
  streamStartTime = null;
  textDuration.textContent = '0:00';
  audioMeter.style.width = '0%';
}

// Start broadcasting
btnStart.addEventListener('click', async () => {
  hideMsg();
  btnStart.disabled = true;

  const ok = await startAudio();
  if (!ok) {
    btnStart.disabled = false;
    return;
  }

  startBatteryMonitor();
  startStatusUpdates();
  requestWakeLock();

  btnStart.classList.add('hidden');
  btnStop.classList.remove('hidden');

  await createOfferAndShowQR();
});

// Scan viewer response
btnScanResponse.addEventListener('click', () => {
  startResponseScanner();
});

// Stop broadcasting
btnStop.addEventListener('click', () => {
  stopScanner();
  closePeerConnection();
  stopAll();
  stopStatusUpdates();
  releaseWakeLock();
  updateConnection('disconnected');
  updateViewerStatus(false);

  qrContainer.classList.add('hidden');
  qrLabel.classList.add('hidden');
  btnScanResponse.classList.add('hidden');
  scannerContainer.classList.add('hidden');

  btnStop.classList.add('hidden');
  btnStart.classList.remove('hidden');
  btnStart.disabled = false;
});
