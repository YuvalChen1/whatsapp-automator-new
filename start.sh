#!/bin/bash
# Startup script for Render deployment
echo "=== Pre-start cleanup ==="

# Kill any orphan Chromium processes from a previous container
pkill -9 -f chromium 2>/dev/null || true
pkill -9 -f chrome 2>/dev/null || true
sleep 1

# Clean /tmp to ensure no stale local session data
rm -rf /tmp/wwebjs_auth 2>/dev/null || true

echo "Cleanup complete. Starting Node.js..."

# Limit Node.js memory to 256MB (Chromium gets the rest of the 512MB)
exec node --max-old-space-size=256 index.js
