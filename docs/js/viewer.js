import { createPeerConnection } from './webrtc-common.js';
import { decodeSDP, encodeSDP, waitForICEGathering, isCompactSDP } from './sdp-codec.js';
import { DataChannelSignaling } from './data-channel.js';

// DOM elements
const remoteAudio = document.getElementById('remote-audio');
const audioStatus = document.getElementById('audio-status');
const scannerSection = document.getElementById('scanner-section');
const streamSection = document.getElementById('stream-section');
const btnScanAgain = document.getElementById('btn-scan-again');
const unmuteBanner = document.getElementById('unmute-banner');
const msgEl = document.getElementById('msg');
const answerQrContainer = document.getElementById('answer-qr-container');
const answerQrLabel = document.getElementById('answer-qr-label');

// Status elements
const dotConnection = document.getElementById('dot-connection');
const textConnection = document.getElementById('text-connection');
const textBattery = document.getElementById('text-battery');
const textDuration = document.getElementById('text-duration');
const audioMeter = document.getElementById('audio-meter');

// Spectrogram
const spectrogramCanvas = document.getElementById('spectrogram');
const spectrogramCtx = spectrogramCanvas.getContext('2d');
let spectrogramAudioCtx = null;
let spectrogramAnalyser = null;
let spectrogramSource = null;
let spectrogramAnimFrame = null;

function heatColor(value) {
  // 0–255 → black → purple → blue → cyan → green → yellow → red
  if (value < 32) return [0, 0, value * 4];
  if (value < 96) { const t = value - 32; return [t * 2, 0, 128 + t * 2]; }
  if (value < 160) { const t = value - 96; return [0, t * 4, 255 - t * 2]; }
  if (value < 224) { const t = value - 160; return [t * 4, 255, 0]; }
  const t = value - 224;
  return [255, 255 - t * 8, 0];
}

function startSpectrogram() {
  if (spectrogramAudioCtx) return; // already running

  const stream = remoteAudio.srcObject;
  if (!stream) return;

  spectrogramAudioCtx = new AudioContext();
  if (spectrogramAudioCtx.state === 'suspended') {
    spectrogramAudioCtx.resume();
  }
  spectrogramAnalyser = spectrogramAudioCtx.createAnalyser();
  spectrogramAnalyser.fftSize = 1024;
  spectrogramAnalyser.smoothingTimeConstant = 0.3;

  // Use createMediaStreamSource — createMediaElementSource doesn't work
  // with WebRTC MediaStream-backed audio elements.
  // Don't connect to destination: the <audio> element handles playback.
  spectrogramSource = spectrogramAudioCtx.createMediaStreamSource(stream);
  spectrogramSource.connect(spectrogramAnalyser);

  const freqData = new Uint8Array(spectrogramAnalyser.frequencyBinCount);
  const canvas = spectrogramCanvas;
  const ctx = spectrogramCtx;
  // Use half of bins (useful audio range)
  const binCount = Math.floor(spectrogramAnalyser.frequencyBinCount / 2);

  function draw() {
    spectrogramAnimFrame = requestAnimationFrame(draw);
    spectrogramAnalyser.getByteFrequencyData(freqData);

    // Scroll existing image 1px left
    const imageData = ctx.getImageData(1, 0, canvas.width - 1, canvas.height);
    ctx.putImageData(imageData, 0, 0);

    // Draw new rightmost column
    for (let i = 0; i < canvas.height; i++) {
      // Map canvas row to frequency bin (low freq at bottom)
      const binIndex = Math.floor((1 - i / canvas.height) * binCount);
      const [r, g, b] = heatColor(freqData[binIndex]);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(canvas.width - 1, i, 1, 1);
    }
  }

  draw();
}

function stopSpectrogram() {
  if (spectrogramAnimFrame) {
    cancelAnimationFrame(spectrogramAnimFrame);
    spectrogramAnimFrame = null;
  }
  if (spectrogramAnalyser) {
    spectrogramAnalyser.disconnect();
    spectrogramAnalyser = null;
  }
  if (spectrogramSource) {
    spectrogramSource.disconnect();
    spectrogramSource = null;
  }
  if (spectrogramAudioCtx) {
    spectrogramAudioCtx.close();
    spectrogramAudioCtx = null;
  }
  spectrogramCtx.clearRect(0, 0, spectrogramCanvas.width, spectrogramCanvas.height);
}

// State
let pc = null;
let dcSignaling = null;
let scanner = null;
let wakeLock = null;

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

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && pc) {
    if (!wakeLock) requestWakeLock();
    if (silentAudioCtx?.state === 'suspended') {
      silentAudioCtx.resume();
    }
  }
});

// Unmute on tap
unmuteBanner.addEventListener('click', () => {
  remoteAudio.muted = false;
  unmuteBanner.style.display = 'none';
  remoteAudio.play().catch(() => {});
});

// QR Scanner
function startScanner() {
  scannerSection.classList.remove('hidden');
  streamSection.classList.add('hidden');
  answerQrContainer.classList.add('hidden');
  answerQrLabel.classList.add('hidden');

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

async function handleQRCode(text) {
  if (isCompactSDP(text)) {
    stopScanner();
    await handleCompactOffer(text);
  }
}

async function handleCompactOffer(encoded) {
  scannerSection.classList.add('hidden');
  showMsg('Processing broadcaster signal...', 'info');
  requestWakeLock();

  try {
    const { type, sdp } = decodeSDP(encoded);
    if (type !== 'offer') {
      showMsg('Scanned QR is not a broadcaster offer.');
      return;
    }

    closePeerConnection();
    pc = createPeerConnection();
    setupPeerConnectionHandlers();

    // Listen for data channel from broadcaster
    pc.ondatachannel = (event) => {
      dcSignaling = new DataChannelSignaling(event.channel);
      setupDataChannelHandlers();
    };

    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    showMsg('Gathering connection info...', 'info');
    const desc = await waitForICEGathering(pc);
    hideMsg();

    // Encode and display answer QR
    const answerEncoded = encodeSDP(desc);
    console.log('Answer QR payload:', answerEncoded.length, 'chars');
    showAnswerQR(answerEncoded);
  } catch (err) {
    showMsg(`Failed to process broadcaster QR: ${err.message}`);
  }
}

function showAnswerQR(encoded) {
  answerQrContainer.innerHTML = '';
  answerQrContainer.classList.remove('hidden');
  answerQrLabel.textContent = 'Step 2: Show this QR to the broadcaster phone';
  answerQrLabel.classList.remove('hidden');

  new QRCode(answerQrContainer, {
    text: encoded,
    width: 256,
    height: 256,
    colorDark: '#000000',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.L,
  });
}

function setupDataChannelHandlers() {
  dcSignaling.on('connected', () => {
    console.log('Data channel open — waiting for audio offer');
  });

  // Handle audio offer from broadcaster (real SDP, sent over data channel)
  dcSignaling.on('sdp-offer', async (msg) => {
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Trickle ICE for renegotiation
      pc.onicecandidate = (event) => {
        if (event.candidate && dcSignaling?.connected) {
          dcSignaling.send({ type: 'ice-candidate', candidate: event.candidate.toJSON() });
        }
      };

      dcSignaling.send({ type: 'sdp-answer', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
      console.log('Sent audio answer over data channel');
    } catch (err) {
      console.warn('Failed to handle audio offer:', err);
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

  dcSignaling.on('status-update', (msg) => {
    const s = msg.status;
    if (s.battery) {
      const pct = Math.round(s.battery.level * 100);
      const icon = s.battery.charging ? '\u26A1' : '';
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
}

function setupPeerConnectionHandlers() {
  pc.ontrack = (event) => {
    console.log('ontrack:', event.track.kind, 'readyState:', event.track.readyState, 'muted:', event.track.muted);

    if (event.track.kind === 'audio') {
      // Attach the remote audio stream
      if (event.streams[0]) {
        remoteAudio.srcObject = event.streams[0];
      } else {
        remoteAudio.srcObject = new MediaStream([event.track]);
      }

      audioStatus.textContent = 'Audio stream active';

      // Start spectrogram visualization
      startSpectrogram();

      // Try autoplay; show unmute banner if it fails
      remoteAudio.play().then(() => {
        console.log('Audio playing');
      }).catch(() => {
        console.log('Autoplay blocked, showing unmute banner');
        remoteAudio.muted = true;
        remoteAudio.play().catch(() => {});
        unmuteBanner.style.display = 'block';
      });
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log('ICE state:', pc.iceConnectionState);
    if (pc.iceConnectionState === 'connected') {
      updateConnection('connected');
      streamSection.classList.remove('hidden');
      answerQrContainer.classList.add('hidden');
      answerQrLabel.classList.add('hidden');
    } else if (pc.iceConnectionState === 'failed') {
      showMsg('Connection failed.', 'error');
      updateConnection('disconnected');
      streamSection.classList.remove('hidden');
      answerQrContainer.classList.add('hidden');
      answerQrLabel.classList.add('hidden');
      btnScanAgain.classList.remove('hidden');
    } else if (pc.iceConnectionState === 'disconnected') {
      updateConnection('connecting');
      pc.restartIce();
      showMsg('Connection lost, attempting to reconnect...', 'info');
      setTimeout(() => {
        if (pc && pc.iceConnectionState !== 'connected') {
          showMsg('Connection lost. Tap Scan QR Again to reconnect.', 'error');
          btnScanAgain.classList.remove('hidden');
        }
      }, 10000);
    }
  };
}

function closePeerConnection() {
  stopSpectrogram();
  if (pc) {
    pc.close();
    pc = null;
  }
  if (dcSignaling) {
    dcSignaling = null;
  }
  remoteAudio.srcObject = null;
}

// Scan again — tear down everything and go back to QR scanner
btnScanAgain.addEventListener('click', () => {
  btnScanAgain.classList.add('hidden');
  hideMsg();
  closePeerConnection();
  releaseWakeLock();
  startScanner();
});

// Initialize
startScanner();
