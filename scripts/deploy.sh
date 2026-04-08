#!/usr/bin/env bash
# openwps 生产部署脚本
# 用法：bash scripts/deploy.sh
# 效果：打包前端 → 重启后端（5174），单端口统一托管

set -e
cd "$(dirname "$0")/.."

echo "📦 Building frontend..."
npm run build

echo "🔄 Restarting backend..."
pkill -f "python3 server/main.py" 2>/dev/null || true
sleep 1

nohup python3 server/main.py &>/tmp/openwps-backend.log &
echo "⏳ Waiting for backend..."
sleep 3

STATUS=$(curl -s http://localhost:5174/api/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null || echo "error")
if [ "$STATUS" = "ok" ]; then
  echo "✅ openwps running at http://localhost:5174"
else
  echo "❌ Backend health check failed. Check /tmp/openwps-backend.log"
  tail -20 /tmp/openwps-backend.log
  exit 1
fi
