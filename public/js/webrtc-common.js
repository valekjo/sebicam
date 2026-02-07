// Shared WebRTC configuration and helpers

export const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

/**
 * Create a configured RTCPeerConnection
 * @param {SignalingClient} signaling
 * @returns {RTCPeerConnection}
 */
export function createPeerConnection(signaling) {
  const pc = new RTCPeerConnection(ICE_CONFIG);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      signaling.send({
        type: 'ice-candidate',
        candidate: event.candidate.toJSON(),
      });
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log('ICE state:', pc.iceConnectionState);
  };

  return pc;
}

/**
 * Get connection quality stats from RTCPeerConnection
 * @param {RTCPeerConnection} pc
 * @returns {Promise<{bitrate: number, packetsLost: number, roundTripTime: number, jitter: number} | null>}
 */
export async function getConnectionStats(pc) {
  if (pc.connectionState !== 'connected') return null;

  const stats = await pc.getStats();
  let result = { bitrate: 0, packetsLost: 0, roundTripTime: 0, jitter: 0 };

  for (const report of stats.values()) {
    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
      result.roundTripTime = report.currentRoundTripTime ?? 0;
    }
    if (report.type === 'inbound-rtp' && report.kind === 'video') {
      result.packetsLost = report.packetsLost ?? 0;
      result.jitter = report.jitter ?? 0;
    }
  }

  return result;
}

/**
 * Compute audio level from a MediaStream using Web Audio API
 * @param {MediaStream} stream
 * @returns {{ getLevel: () => number, destroy: () => void }}
 */
export function createAudioMeter(stream) {
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  const dataArray = new Uint8Array(analyser.frequencyBinCount);

  return {
    getLevel() {
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      return sum / dataArray.length / 255; // 0..1
    },
    destroy() {
      source.disconnect();
      audioCtx.close();
    },
  };
}
