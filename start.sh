#!/bin/bash
set -e

echo "Starting FlareSolverr on port 8191..."
cd /opt/flaresolverr
CHROME_PATH=/usr/bin/google-chrome-stable \
HEADLESS=true \
LOG_LEVEL=info \
PORT=8191 \
HOST=0.0.0.0 \
/opt/flaresolverr/venv/bin/python -u src/flaresolverr.py &

FLARESOLVERR_PID=$!

# Wait for FlareSolverr to be ready (up to 30 seconds)
echo "Waiting for FlareSolverr to start on port 8191..."
for i in $(seq 1 30); do
    if curl -s http://localhost:8191/ > /dev/null 2>&1; then
        echo "FlareSolverr is ready!"
        break
    fi
    if ! kill -0 $FLARESOLVERR_PID 2>/dev/null; then
        echo "FlareSolverr process died!"
        break
    fi
    sleep 1
done

echo "Starting Node.js app on port 8080..."
cd /app
export PORT=8080
exec node server.js
