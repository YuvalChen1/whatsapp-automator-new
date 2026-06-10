#!/bin/bash
# Startup script: Clean up any stale Chromium lock files from previous container
# This runs BEFORE Node.js starts to ensure a clean state

echo "=== Pre-start cleanup ==="

# Kill any orphan Chromium/chrome processes from a previous container
echo "Killing any orphan Chromium processes..."
pkill -9 -f chromium 2>/dev/null || true
pkill -9 -f chrome 2>/dev/null || true

# Small delay to ensure processes are dead
sleep 1

# Remove all Chromium singleton/lock files from the persistent data directory
DATA_DIR="${DATA_DIR:-/app/data}"
echo "Cleaning lock files in $DATA_DIR..."

# Find and remove all SingletonLock, SingletonCookie, SingletonSocket files recursively
find "$DATA_DIR" -name "SingletonLock" -delete 2>/dev/null || true
find "$DATA_DIR" -name "SingletonCookie" -delete 2>/dev/null || true
find "$DATA_DIR" -name "SingletonSocket" -delete 2>/dev/null || true

# Also remove broken symlinks (SingletonLock is often a symlink)
find "$DATA_DIR" -xtype l -delete 2>/dev/null || true

echo "Cleanup complete. Starting Node.js..."

# Start the Node.js application
exec node index.js
