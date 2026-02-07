import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { ClientMessage, ServerMessage, Room } from './types.js';

const rooms = new Map<string, Room>();

// Cleanup stale rooms every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    // Remove rooms older than 12 hours
    if (now - room.createdAt > 12 * 60 * 60 * 1000) {
      cleanupRoom(id);
    }
  }
}, 5 * 60 * 1000);

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function generateId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function generateToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function findRoomBySocket(ws: WebSocket): { room: Room; role: 'broadcaster' | 'viewer' } | null {
  for (const room of rooms.values()) {
    if (room.broadcaster === ws) return { room, role: 'broadcaster' };
    if (room.viewer === ws) return { room, role: 'viewer' };
  }
  return null;
}

function cleanupRoom(roomId: string) {
  rooms.delete(roomId);
}

function handleMessage(ws: WebSocket, data: string) {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(data);
  } catch {
    send(ws, { type: 'error', message: 'Invalid JSON' });
    return;
  }

  switch (msg.type) {
    case 'create-room': {
      // Ensure this socket isn't already in a room
      const existing = findRoomBySocket(ws);
      if (existing) {
        send(ws, { type: 'error', message: 'Already in a room' });
        return;
      }

      const roomId = generateId();
      const authToken = generateToken();
      const room: Room = {
        roomId,
        authToken,
        broadcaster: ws,
        viewer: null,
        createdAt: Date.now(),
      };
      rooms.set(roomId, room);

      send(ws, { type: 'room-created', roomId, authToken });
      console.log(`Room ${roomId} created`);
      break;
    }

    case 'join-room': {
      const room = rooms.get(msg.roomId);
      if (!room) {
        send(ws, { type: 'error', message: 'Room not found' });
        return;
      }

      // Timing-safe token comparison
      const tokenBuf = Buffer.from(msg.authToken);
      const expectedBuf = Buffer.from(room.authToken);
      if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
        send(ws, { type: 'error', message: 'Invalid auth token' });
        return;
      }

      if (room.viewer) {
        send(ws, { type: 'error', message: 'Room already has a viewer' });
        return;
      }

      room.viewer = ws;
      send(ws, { type: 'room-joined', roomId: msg.roomId });
      send(room.broadcaster, { type: 'viewer-joined' });
      console.log(`Viewer joined room ${msg.roomId}`);
      break;
    }

    case 'sdp-offer': {
      const found = findRoomBySocket(ws);
      if (!found || found.role !== 'broadcaster' || !found.room.viewer) return;
      send(found.room.viewer, { type: 'sdp-offer', sdp: msg.sdp });
      break;
    }

    case 'sdp-answer': {
      const found = findRoomBySocket(ws);
      if (!found || found.role !== 'viewer') return;
      send(found.room.broadcaster, { type: 'sdp-answer', sdp: msg.sdp });
      break;
    }

    case 'ice-candidate': {
      const found = findRoomBySocket(ws);
      if (!found) return;
      const target = found.role === 'broadcaster' ? found.room.viewer : found.room.broadcaster;
      if (target) {
        send(target, { type: 'ice-candidate', candidate: msg.candidate });
      }
      break;
    }

    case 'status-update': {
      const found = findRoomBySocket(ws);
      if (!found) return;
      // Relay status to the other peer
      const target = found.role === 'broadcaster' ? found.room.viewer : found.room.broadcaster;
      if (target) {
        send(target, { type: 'status-update', status: msg.status });
      }
      break;
    }

    case 'leave-room': {
      handleDisconnect(ws);
      break;
    }

    default:
      send(ws, { type: 'error', message: 'Unknown message type' });
  }
}

function handleDisconnect(ws: WebSocket) {
  const found = findRoomBySocket(ws);
  if (!found) return;

  if (found.role === 'broadcaster') {
    if (found.room.viewer) {
      send(found.room.viewer, { type: 'broadcaster-left' });
    }
    cleanupRoom(found.room.roomId);
    console.log(`Room ${found.room.roomId} closed (broadcaster left)`);
  } else {
    found.room.viewer = null;
    send(found.room.broadcaster, { type: 'viewer-left' });
    console.log(`Viewer left room ${found.room.roomId}`);
  }
}

export function setupSignaling(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    ws.on('message', (data) => {
      handleMessage(ws, data.toString());
    });

    ws.on('close', () => {
      handleDisconnect(ws);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
      handleDisconnect(ws);
    });
  });
}
