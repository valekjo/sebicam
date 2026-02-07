// Signaling message types exchanged over WebSocket

// Server relays these as opaque JSON — no need for full WebRTC types.
interface SdpPayload {
  type: string;
  sdp?: string;
}

interface IceCandidatePayload {
  candidate?: string;
  sdpMLineIndex?: number | null;
  sdpMid?: string | null;
}

// Client → Server messages
export type ClientMessage =
  | { type: 'create-room' }
  | { type: 'join-room'; roomId: string; authToken: string }
  | { type: 'sdp-offer'; sdp: SdpPayload }
  | { type: 'sdp-answer'; sdp: SdpPayload }
  | { type: 'ice-candidate'; candidate: IceCandidatePayload }
  | { type: 'status-update'; status: StatusData }
  | { type: 'leave-room' };

// Server → Client messages
export type ServerMessage =
  | { type: 'room-created'; roomId: string; authToken: string }
  | { type: 'room-joined'; roomId: string }
  | { type: 'viewer-joined' }
  | { type: 'viewer-left' }
  | { type: 'broadcaster-left' }
  | { type: 'sdp-offer'; sdp: SdpPayload }
  | { type: 'sdp-answer'; sdp: SdpPayload }
  | { type: 'ice-candidate'; candidate: IceCandidatePayload }
  | { type: 'status-update'; status: StatusData }
  | { type: 'error'; message: string };

export interface StatusData {
  battery?: { level: number; charging: boolean };
  audioLevel?: number;
  streamDuration?: number;
}

export interface Room {
  roomId: string;
  authToken: string;
  broadcaster: import('ws').WebSocket;
  viewer: import('ws').WebSocket | null;
  createdAt: number;
}
