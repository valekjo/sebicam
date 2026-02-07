import { SignalingClient } from './signaling-client.js';
import { createPeerConnection, createAudioMeter } from './webrtc-common.js';

// DOM elements
const preview = document.getElementById('preview');
const videoContainer = document.getElementById('video-container');
const placeholder = document.getElementById('video-placeholder');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnCamera = document.getElementById('btn-camera');
const qrContainer = document.getElementById('qr-container');
const qrLabel = document.getElementById('qr-label');
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
let signaling = null;
let pc = null;
let audioStream = null;
let videoTrack = null;
let videoSender = null;
let audioMeterInstance = null;
let streamStartTime = null;
let statusInterval = null;
let durationInterval = null;
let roomId = null;
let authToken = null;
let wakeLock = null;
let noSleepVideo = null;
let silentAudioCtx = null;
let silentOscillator = null;

// Keep alive strategy (3 layers):
//   1. Wake Lock API — prevents screen dimming
//   2. Silent video loop — prevents screen lock on some devices
//   3. Silent audio output + Media Session — keeps page alive when screen IS locked
//      (Android Chrome keeps pages with audible media running in background)

async function requestWakeLock() {
  // 1. Wake Lock API
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {
      // Not critical
    }
  }

  // 2. Silent video fallback (NoSleep technique)
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

  // 3. Near-silent audio oscillator — Android Chrome keeps pages with audio
  //    output alive even when the screen is locked.
  if (!silentAudioCtx) {
    try {
      silentAudioCtx = new AudioContext();
      silentOscillator = silentAudioCtx.createOscillator();
      const gain = silentAudioCtx.createGain();
      gain.gain.value = 0.001; // near-inaudible
      silentOscillator.connect(gain);
      gain.connect(silentAudioCtx.destination);
      silentOscillator.start();
    } catch {
      // Not critical
    }
  }

  // 4. Media Session — shows persistent notification on Android lock screen
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

// Re-acquire when page becomes visible again
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && audioStream) {
    if (!wakeLock) requestWakeLock();
    // Resume AudioContext if browser suspended it
    if (silentAudioCtx?.state === 'suspended') {
      silentAudioCtx.resume();
    }
  }
});
let cameraOn = false;

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
    textConnection.textContent = 'Server connected';
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

// Battery monitoring — Battery API is Chromium-only, hide badge on Firefox etc.
async function startBatteryMonitor() {
  if (!('getBattery' in navigator)) {
    document.getElementById('badge-battery').classList.add('hidden');
    return;
  }
  try {
    const battery = await navigator.getBattery();
    const update = () => {
      const pct = Math.round(battery.level * 100);
      const icon = battery.charging ? '⚡' : '';
      textBattery.textContent = `Battery: ${pct}%${icon}`;
      if (signaling?.connected) {
        signaling.send({
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
        'Tap the lock/info icon in the address bar → Site settings → allow Microphone.',
      );
    } else if (err.name === 'NotFoundError') {
      showMsg('No microphone found on this device.');
    } else {
      showMsg(`Microphone error: ${err.message}`);
    }
    return false;
  }
}

async function enableCamera() {
  const attempts = [
    { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } },
    { video: { facingMode: 'environment' } },
    { video: true },
  ];

  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      videoTrack = stream.getVideoTracks()[0];

      // Show preview
      preview.srcObject = stream;
      placeholder.classList.add('hidden');
      videoContainer.classList.remove('hidden');

      // Add to peer connection if active
      if (pc) {
        videoSender = pc.addTrack(videoTrack, stream);
        await renegotiate();
      }

      cameraOn = true;
      btnCamera.textContent = 'Disable Camera';
      return true;
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        showMsg('Camera permission denied. Allow camera access and try again.');
        return false;
      }
      if (err.name === 'NotFoundError') {
        showMsg('No camera found on this device.');
        return false;
      }
      console.warn('getUserMedia failed with constraints:', constraints, err.name, err.message);
    }
  }

  showMsg('Could not access camera.');
  return false;
}

function disableCamera() {
  if (videoTrack) {
    videoTrack.stop();
    videoTrack = null;
  }

  // Remove from peer connection
  if (pc && videoSender) {
    pc.removeTrack(videoSender);
    videoSender = null;
    renegotiate();
  }

  preview.srcObject = null;
  placeholder.classList.remove('hidden');
  videoContainer.classList.add('hidden');

  cameraOn = false;
  btnCamera.textContent = 'Enable Camera';
}

async function renegotiate() {
  if (!pc || !signaling?.connected) return;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.send({ type: 'sdp-offer', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
  } catch (err) {
    console.warn('Renegotiation failed:', err);
  }
}

function stopAll() {
  if (audioStream) {
    audioStream.getTracks().forEach(t => t.stop());
    audioStream = null;
  }
  if (videoTrack) {
    videoTrack.stop();
    videoTrack = null;
  }
  videoSender = null;
  preview.srcObject = null;
  placeholder.classList.remove('hidden');
  if (audioMeterInstance) {
    audioMeterInstance.destroy();
    audioMeterInstance = null;
  }
  cameraOn = false;
}

function connectSignaling() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  signaling = new SignalingClient(`${proto}://${location.host}`);

  signaling.on('connected', () => {
    updateConnection('connected');
    signaling.send({ type: 'create-room' });
  });

  signaling.on('disconnected', () => {
    updateConnection('disconnected');
  });

  signaling.on('room-created', (msg) => {
    roomId = msg.roomId;
    authToken = msg.authToken;
    showQR();
  });

  signaling.on('viewer-joined', () => {
    updateViewerStatus(true);
    hideMsg();
    startWebRTC();
  });

  signaling.on('viewer-left', () => {
    updateViewerStatus(false);
    closePeerConnection();
  });

  signaling.on('sdp-answer', async (msg) => {
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    }
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

  signaling.on('error', (msg) => {
    showMsg(msg.message);
  });

  signaling.connect();
}

function showQR() {
  const viewerURL = `${location.protocol}//${location.host}/viewer.html?room=${roomId}&token=${encodeURIComponent(authToken)}`;
  qrContainer.innerHTML = '';
  qrContainer.classList.remove('hidden');
  qrLabel.classList.remove('hidden');

  new QRCode(qrContainer, {
    text: viewerURL,
    width: 200,
    height: 200,
    colorDark: '#000000',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M,
  });
}

function startWebRTC() {
  closePeerConnection();

  pc = createPeerConnection(signaling);

  // Add audio track
  if (audioStream) {
    for (const track of audioStream.getAudioTracks()) {
      pc.addTrack(track, audioStream);
    }
  }

  // Add video track if camera is on
  if (videoTrack) {
    const videoStream = preview.srcObject;
    videoSender = pc.addTrack(videoTrack, videoStream);
  }

  pc.oniceconnectionstatechange = () => {
    console.log('ICE state:', pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed') {
      showMsg('Connection to viewer failed. Ask them to try again.', 'error');
    }
  };

  // Create and send offer
  pc.createOffer()
    .then(offer => pc.setLocalDescription(offer))
    .then(() => {
      signaling.send({ type: 'sdp-offer', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    })
    .catch(err => {
      showMsg(`WebRTC offer error: ${err.message}`);
    });
}

function closePeerConnection() {
  if (pc) {
    pc.close();
    pc = null;
  }
  videoSender = null;
}

function startStatusUpdates() {
  statusInterval = setInterval(() => {
    if (audioMeterInstance) {
      const level = audioMeterInstance.getLevel();
      audioMeter.style.width = `${Math.min(level * 100 * 3, 100)}%`;

      if (signaling?.connected) {
        signaling.send({
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

    if (signaling?.connected) {
      signaling.send({
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

// Start broadcasting (audio only)
btnStart.addEventListener('click', async () => {
  hideMsg();
  btnStart.disabled = true;

  const ok = await startAudio();
  if (!ok) {
    btnStart.disabled = false;
    return;
  }

  connectSignaling();
  startBatteryMonitor();
  startStatusUpdates();
  requestWakeLock();

  btnStart.classList.add('hidden');
  btnCamera.classList.remove('hidden');
  btnStop.classList.remove('hidden');
});

// Toggle camera
btnCamera.addEventListener('click', async () => {
  btnCamera.disabled = true;
  if (cameraOn) {
    disableCamera();
  } else {
    await enableCamera();
  }
  btnCamera.disabled = false;
});

// Stop broadcasting
btnStop.addEventListener('click', () => {
  closePeerConnection();
  if (signaling) {
    signaling.send({ type: 'leave-room' });
    signaling.disconnect();
    signaling = null;
  }
  stopAll();
  stopStatusUpdates();
  releaseWakeLock();
  updateConnection('disconnected');
  updateViewerStatus(false);

  qrContainer.classList.add('hidden');
  qrLabel.classList.add('hidden');
  videoContainer.classList.add('hidden');

  btnStop.classList.add('hidden');
  btnCamera.classList.add('hidden');
  btnStart.classList.remove('hidden');
  btnStart.disabled = false;
  btnCamera.textContent = 'Enable Camera';
  roomId = null;
  authToken = null;
});
