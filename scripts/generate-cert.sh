#!/usr/bin/env bash
set -euo pipefail

CERT_DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
mkdir -p "$CERT_DIR"

# Auto-detect LAN IP
if command -v ip &>/dev/null; then
  LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' | head -1)
elif command -v ifconfig &>/dev/null; then
  LAN_IP=$(ifconfig | grep 'inet ' | grep -v '127.0.0.1' | awk '{print $2}' | head -1)
fi

if [ -z "${LAN_IP:-}" ]; then
  echo "Could not detect LAN IP. Using localhost."
  LAN_IP="127.0.0.1"
fi

echo "Generating self-signed certificate for $LAN_IP ..."

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$CERT_DIR/key.pem" \
  -out "$CERT_DIR/cert.pem" \
  -days 365 \
  -subj "/CN=sebicam" \
  -addext "subjectAltName=IP:$LAN_IP,IP:127.0.0.1,DNS:localhost"

echo "Certificate generated in $CERT_DIR"
echo "LAN IP: $LAN_IP"
echo "URL: https://$LAN_IP:3000"
