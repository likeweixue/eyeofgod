#!/bin/bash
set -u
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

printf '\n  正在启动上帝之眼局域网监控服务…\n\n'

if ! command -v node >/dev/null 2>&1; then
  printf '  ✕ 没有找到 Node.js。\n'
  printf '    请先安装 Node.js 20 或更高版本：https://nodejs.org/\n'
  printf '    安装完成后重新双击本文件。\n\n'
  read -r -p '  按回车键关闭窗口…' _
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  printf '  ✕ Node.js 版本过低（当前 %s），需要 20 或更高版本。\n\n' "$(node -v)"
  read -r -p '  按回车键关闭窗口…' _
  exit 1
fi

if [ ! -d node_modules ] || [ ! -d node_modules/ws ] || [ ! -d node_modules/qrcode ]; then
  printf '  首次运行，正在安装依赖（需要联网）…\n\n'
  if ! npm install --no-audit --no-fund; then
    printf '\n  ✕ 依赖安装失败，请检查网络后重试。\n\n'
    read -r -p '  按回车键关闭窗口…' _
    exit 1
  fi
  printf '\n'
fi

node server/index.js
STATUS=$?

printf '\n  ─────────────────────────────────────────\n'
if [ "$STATUS" -eq 0 ]; then
  printf '  服务已停止。\n'
else
  printf '  服务异常退出（代码 %s），请查看上方错误信息。\n' "$STATUS"
fi
printf '  窗口可以关闭。\n\n'
read -r -p '  按回车键关闭窗口…' _
exit "$STATUS"
