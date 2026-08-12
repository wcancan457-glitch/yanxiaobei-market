#!/bin/zsh

PROJECT_DIR="/Users/tw/Documents/Obsidian Vault/日常作业/个人项目/校园二手平台交易/mobile-web-demo"
PORT="5177"
BUNDLED_NODE="/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

if [ -x "$BUNDLED_NODE" ]; then
  NODE_BIN="$BUNDLED_NODE"
else
  NODE_BIN="$(command -v node)"
fi

if [ -z "$NODE_BIN" ]; then
  osascript -e 'display dialog "没有找到 Node.js，无法启动燕小北集市。" buttons {"知道了"} default button 1'
  exit 1
fi

cd "$PROJECT_DIR" || exit 1

if ! lsof -iTCP:$PORT -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  nohup "$NODE_BIN" server.js > server.log 2>&1 &
  sleep 1
fi

open "http://localhost:$PORT"

