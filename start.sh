#!/usr/bin/env bash
# Run both halves of the hybrid voice system: the Python bot (brain) and the
# Node.js voice listener sidecar (ears). If either process dies, exit so the
# platform restarts the container.
node listener/index.js &
python main.py &
wait -n
echo "[start] a process exited — shutting down"
kill $(jobs -p) 2>/dev/null
exit 1
