# Windows 筆電開發環境

目標：Windows 11 + WSL2 (Ubuntu 22.04) + Docker Desktop。所有程式碼與指令都在 WSL 裡執行。

> 為什麼不直接在 Windows 跑？B2 的 SDK 只支援 Linux；X30 與後端雖然可以，但統一在 WSL 才不會遇到換行、路徑、權限問題。

## 自動安裝（建議）
兩個腳本會依序完成下面第 1–3 節：
1. **Windows 端**：以系統管理員開 PowerShell，切到下載的 `setup-windows.ps1` 所在資料夾，執行
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass -Force; .\setup-windows.ps1
   ```
   會檢查 Windows 版本與 WSL2、寫入 `.wslconfig`、開防火牆、提醒 Docker Desktop 設定。
2. **Ubuntu 端**：開 Ubuntu 終端機，執行
   ```bash
   git clone https://github.com/ecenter3/oviiai.git ~/oviiai && bash ~/oviiai/scripts/setup-wsl.sh
   ```
   會安裝 Python/Node、建立 `.env`、安裝套件、啟動資料庫等服務並跑測試。可重複執行。

以下為手動步驟，腳本出錯時對照用。

## 1. 安裝（約 30 分鐘）
以系統管理員開 PowerShell：
```powershell
wsl --install -d Ubuntu-22.04
```
重新開機後，Ubuntu 會要求設定帳號密碼。

1. 把 `infra/wslconfig.example` 的內容存成 `C:\Users\<帳號>\.wslconfig`，然後執行 `wsl --shutdown`。
   - `networkingMode=mirrored` 很重要：WSL 才能直接連到機器人網段、收到 B2 的 DDS 群播。
   - 需要 Windows 11 22H2 以上。Windows 10 不支援，請告知，要改用其他做法。
2. 安裝 [Docker Desktop](https://www.docker.com/products/docker-desktop/)，設定裡勾選 **Use the WSL 2 based engine**，並在 Resources → WSL integration 開啟 Ubuntu-22.04。
3. 在 Ubuntu 終端機：
   ```bash
   sudo apt update && sudo apt install -y build-essential git make python3.11 python3.11-venv python3-pip
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
   git config --global core.autocrlf input
   ```

## 2. 取得程式碼
程式碼放在 **WSL 的家目錄**（`~/oviiai`），不要放在 `C:\` 或 `/mnt/c`，否則 Docker 和 npm 會慢 5–10 倍。
```bash
git clone https://github.com/ecenter3/oviiai.git ~/oviiai
cd ~/oviiai && cp .env.example .env
```
在 Claude 桌面版的 Code 分頁選資料夾時，選 `\\wsl$\Ubuntu-22.04\home\<帳號>\oviiai`。

## 3. 啟動
```bash
make up                 # PostgreSQL、Redis、EMQX、S3
cd adapters && python3.11 -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]' && cd ..
make test-adapters
make mock               # 模擬機器人（預設 6 台）
```
管理介面：EMQX http://localhost:18083 ／ S3 檔案瀏覽 http://localhost:8888

`.env` 要設 `DATA_ENC_KEY`（攝影機、機器人連線密碼加密，`openssl rand -base64 48`）與 `ADAPTER_KEY_MOCK`（`openssl rand -hex 24`）。
有 `ADAPTER_KEY_MOCK` 時，模擬器每 10 秒向後端 `GET /api/v1/adapter-config/mock` 取機器人清單：在「機器人管理」新增 adapter 為 `mock` 的機器人，模擬器就會跟著出現；停用則移除。後端沒開時改用 `adapters/mock/robots.yaml`。

**已知的開發環境問題**：Windows 上的 Chrome 經過 Vite 開發伺服器的代理（`localhost:5173/api`）收超過約 50 KB 的回應會卡住收不完（例：平面圖），直接連後端 `localhost:3000` 或正式環境的 Nginx 不會。開發時看不到平面圖屬這個問題，不影響正式環境。

## 4. 連真機器人
| 品牌 | 筆電要做的事 |
|---|---|
| X30 | 筆電連上機器人的 Wi-Fi 或同網段，能 `ping 192.168.1.106`，然後 `nc -vz 192.168.1.106 30000` |
| B2 | 筆電與 B2 同網段（預設 192.168.123.x），DDS 用群播，Windows 防火牆要允許 UDP 7400–7500 |
| ANBOT-Y | 待 SDK |

Windows 防火牆（PowerShell 系統管理員）：
```powershell
New-NetFirewallRule -DisplayName "DDS" -Direction Inbound -Protocol UDP -LocalPort 7400-7500 -Action Allow
```

## 5. 記憶體（16 GB）
| 項目 | 約用量 |
|---|---|
| Windows + 瀏覽器 + Claude 桌面版 | 5–6 GB |
| WSL 上限（.wslconfig） | 10 GB |
| └ Docker 服務（已設上限） | 約 3.5 GB，含 MediaMTX 4 GB |
| └ 後端 + 前端 dev server + 轉接器 | 約 2 GB |

不需要看影像時不要開 MediaMTX（`make up` 預設不開）。

## 6. 注意：筆電不適合當正式主機
- X30 在上位機斷線時會自動停止任務；筆電睡眠、Windows 更新重開都會中斷所有巡邏。
- 開發、試營運可以；1/1 正式上線前請準備一台固定主機，程式不用改，直接搬過去。
- 試營運期間：電源選項設定「插電時永不睡眠」，Windows Update 設定使用時段。
