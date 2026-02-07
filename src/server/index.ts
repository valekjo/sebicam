import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const PORT = Number(process.env.PORT) || 3000;
const CERT_DIR = path.resolve(import.meta.dirname, '../../certs');

// Load TLS certificates
let tlsOptions: { key: Buffer; cert: Buffer };
try {
  tlsOptions = {
    key: fs.readFileSync(path.join(CERT_DIR, 'key.pem')),
    cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem')),
  };
} catch {
  console.error('TLS certificates not found. Run: npm run generate-cert');
  process.exit(1);
}

const app = express();

// Serve static files from docs/
app.use(express.static(path.resolve(import.meta.dirname, '../../docs')));

// Serve index page at root
app.get('/', (_req, res) => {
  res.sendFile(path.resolve(import.meta.dirname, '../../docs/index.html'));
});

const server = https.createServer(tlsOptions, app);


// Detect LAN IP
function getLanIP(): string {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return '127.0.0.1';
}

server.listen(PORT, '0.0.0.0', () => {
  const lanIP = getLanIP();
  console.log(`Sebicam running at:`);
  console.log(`  Local:   https://localhost:${PORT}`);
  console.log(`  Network: https://${lanIP}:${PORT}`);
  console.log(`\nOpen the Network URL on your phone to start broadcasting.`);
});
