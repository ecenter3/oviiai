# OViiAI 機器人派工監控平台

地端部署的多品牌機器人派工與監控平台：宇樹 B2、雲深處 X30、萬為 ANBOT-Y，三個樓層、約 100 支攝影機。

## 目錄
| 路徑 | 內容 |
|---|---|
| `backend/` | NestJS 後端（API、WebSocket、派工、告警） |
| `frontend/` | React + Vite 控制台 |
| `adapters/` | 各品牌轉接器（Python），經 MQTT 與後端溝通 |
| `packages/contracts/` | 後端與前端共用的訊息格式（zod） |
| `db/migrations/` | 資料庫 migration（SQL） |
| `infra/` | Docker Compose、EMQX、MediaMTX、Nginx 設定 |
| `docs/` | 開發環境與操作文件 |

## 快速開始（Windows 筆電）
1. 依 [docs/setup-windows.md](docs/setup-windows.md) 安裝 WSL2、Docker Desktop、Node 22、Python 3.11。
2. 在 WSL 終端機：
   ```bash
   git clone https://github.com/ecenter3/oviiai.git ~/oviiai && cd ~/oviiai
   cp .env.example .env
   make up        # 啟動資料庫等基礎服務
   make mock      # 啟動模擬機器人
   ```
3. 開 http://localhost:5173

開發規則見 [CLAUDE.md](CLAUDE.md)。
