#!/usr/bin/env bash
# OViiAI 開發環境 — Ubuntu (WSL) 端設定
# 用法：bash ~/oviiai/scripts/setup-wsl.sh
# 會做：安裝 git/make/Python 3.11+/Node 22、取得程式碼、建立 .env、安裝套件、啟動資料庫等服務、跑測試
set -euo pipefail

ok()   { printf '\033[32m[OK]\033[0m   %s\n' "$*"; }
warn() { printf '\033[33m[注意]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[錯誤]\033[0m %s\n' "$*"; exit 1; }

REPO_URL="https://github.com/ecenter3/oviiai.git"
DIR="$HOME/oviiai"

# 0. 環境檢查
grep -qi microsoft /proc/version || warn "看起來不是在 WSL 裡執行"
[[ "$PWD" == /mnt/* ]] && warn "目前在 Windows 磁碟（/mnt/...）；程式碼會放在 $DIR（WSL 內）以求速度"
. /etc/os-release
ok "Ubuntu $VERSION_ID"

# 1. 系統套件
sudo apt-get update -y
sudo apt-get install -y build-essential git make curl ca-certificates netcat-openbsd
git config --global core.autocrlf input

# 2. Python 3.11 以上
PY=python3
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then
  sudo apt-get install -y software-properties-common
  sudo add-apt-repository -y ppa:deadsnakes/ppa
  sudo apt-get update -y
  sudo apt-get install -y python3.11 python3.11-venv python3.11-dev
  PY=python3.11
else
  sudo apt-get install -y python3-venv python3-dev python3-pip
fi
ok "Python: $($PY --version)"

# 3. Node 22
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1)" != "v22" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
ok "Node: $(node -v)"

# 4. 程式碼
if [[ -d "$DIR/.git" ]]; then
  git -C "$DIR" pull --ff-only || warn "git pull 失敗，沿用現有程式碼"
else
  git clone "$REPO_URL" "$DIR" || fail "clone 失敗。私有 repo 需登入：帳號填 GitHub 帳號，密碼貼 Personal Access Token（GitHub → Settings → Developer settings → Tokens）"
fi
cd "$DIR"
[[ -f .env ]] || { cp .env.example .env; ok "已建立 .env（密碼請自行修改）"; }

# 5. 轉接器（Python）
$PY -m venv adapters/.venv
adapters/.venv/bin/pip install -q --upgrade pip
adapters/.venv/bin/pip install -q -e 'adapters[dev]'
ok "轉接器套件已安裝"

# 6. 後端與前端（Node）
(cd backend && npm install --no-fund --no-audit)
(cd frontend && npm install --no-fund --no-audit)
ok "後端與前端套件已安裝"

# 7. Docker
if ! command -v docker >/dev/null || ! docker info >/dev/null 2>&1; then
  warn "WSL 裡找不到 Docker。請在 Docker Desktop → Settings → Resources → WSL integration 開啟此 Ubuntu，再重跑本腳本"
  exit 0
fi
make up
ok "資料庫、Redis、EMQX、MinIO 已啟動"

# 8. 測試
(cd adapters && .venv/bin/python -m pytest -q)
(cd backend && npm test --silent)
ok "測試通過"

cat <<EOF

完成。日常使用：
  cd ~/oviiai
  make up                                  # 啟動基礎服務
  make mock                                # 模擬 6 台機器人
  (cd backend && npm run start:dev)        # 後端 http://localhost:3000/api/health
  (cd frontend && npm run dev)             # 前端 http://localhost:5173
管理介面：EMQX http://localhost:18083 ／ MinIO http://localhost:9001

Claude 桌面版 Code 分頁請開啟此資料夾（WSL 內）：$DIR
EOF
