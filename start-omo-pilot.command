#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

export HOME="$SCRIPT_DIR/.irixi-runtime/omo/home"
export OMO_CODING_AGENT_DIR="$SCRIPT_DIR/.irixi-runtime/omo/home/.omo/agent"
export PATH="$SCRIPT_DIR/.irixi-runtime/omo/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PORT="${PORT:-3848}"

echo "=========================================================="
echo "  iRIXI Personal Agent · OmO 5.0 (Pi Kernel) 独立验证副本"
echo "  工作区路径: $SCRIPT_DIR/omo-pilot"
echo "  内置 Harness: $SCRIPT_DIR/.irixi-runtime/omo/bin/omo"
echo "  访问地址:   http://127.0.0.1:${PORT}/?backend=openoffice"
echo "=========================================================="

exec node "$SCRIPT_DIR/omo-pilot/server.mjs"
