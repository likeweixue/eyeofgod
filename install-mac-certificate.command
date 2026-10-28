#!/bin/bash
set -u
cd "$(dirname "$0")" || exit 1

CERT="$PWD/certs/ca.crt"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

printf '\n  ◉  上帝之眼 · 信任本地证书\n'
printf '  ─────────────────────────────────────────\n\n'

if [ ! -f "$CERT" ]; then
  printf '  还没有找到本地证书。\n'
  printf '  请先双击 start.command 启动一次服务，然后重新运行本脚本。\n\n'
  read -r -p '  按回车键关闭窗口…' _
  exit 1
fi

printf '  这会把“God’s Eye Local CA”加入你的登录钥匙串，并设为信任。\n'
printf '  系统会弹出一次 macOS 授权窗口，请输入你的 Mac 登录密码。\n\n'
printf '  证书文件：%s\n\n' "$CERT"
read -r -p '  按回车键继续，或按 Ctrl+C 取消…' _

if security add-trusted-cert -r trustRoot -k "$KEYCHAIN" "$CERT"; then
  printf '\n  ✓ 已信任本地证书。\n'
  printf '    请完全退出并重新打开 Safari / Chrome，然后访问启动终端中显示的\n'
  printf '    管理端地址，或先打开证书安装页确认。\n\n'
  printf '  如果浏览器仍然提示不安全，请打开“钥匙串访问”，找到：\n'
  printf '  God’s Eye Local CA → 双击 → 信任 → 始终信任。\n\n'
else
  printf '\n  ✕ 自动信任失败。请按 README 的“Mac 证书”步骤手动操作：\n'
  printf '    1. 双击 certs/ca.crt，加入“登录”钥匙串\n'
  printf '    2. 在钥匙串访问中把 God’s Eye Local CA 设为始终信任\n\n'
fi

read -r -p '  按回车键关闭窗口…' _
