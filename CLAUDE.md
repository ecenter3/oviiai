# OViiAI 機器人派工監控平台 — 開發規則

這份檔案給 Claude（以及任何工程師）在本 repo 工作時遵循。規格文件都在 `docs/spec/`，衝突時依序優先：
1. 工程開發手冊 `docs/spec/manual/`（SQL、API、訊息格式、工作清單 T-01～T-46）
2. 技術設計文件 `docs/spec/技術設計文件.md`（架構決策 D1–D12）
3. 系統規格書 `docs/spec/系統規格書.md`（功能需求與驗收標準）

**手冊與 repo 已知的差異（目錄名稱、MinIO→SeaweedFS、migration 方式等）列在 `docs/spec/README.md`，以 repo 為準。** 開始一個工作項目前，先讀手冊對應章節與這份差異表。

## 專案範圍
- 1F 辦公室：宇樹 B2 ×10（第一期）；2F 工廠：雲深處 X30 ×10（第二期）；B1 停車場：萬為 ANBOT-Y ×8（第一期）
- 每層 2 座充電座；約 100 支 IP 攝影機；人臉辨識為外部系統（API）
- 地端部署，直接接各品牌 SDK，不透過廠商雲平台。第一期上線 2027/1/1

## 架構
```
瀏覽器 ──HTTPS/WS──> backend (NestJS) ──MQTT──> adapters/<brand> (Python) ──SDK──> 機器人
                         │  PostgreSQL+TimescaleDB / Redis / S3 (SeaweedFS)
攝影機 RTSP ──> MediaMTX ──WebRTC(WHEP)──> 瀏覽器
```
- 後端是模組化單體，不拆微服務。品牌差異只存在 `adapters/`，後端與前端不得出現品牌判斷（能力用 capabilities 清單）。
- 轉接器與後端之間只走 MQTT，訊息格式定義在 `packages/contracts`（TS, zod）與 `adapters/common/contracts.py`（pydantic），兩邊必須同步修改；先改 `packages/contracts/fixtures/messages.json`，兩邊的測試都讀它。

## MQTT 主題（不可自行更名）
| 主題 | 方向 | QoS |
|---|---|---|
| `rms/robot/{code}/telemetry` | 轉接器→後端，1 Hz | 0 |
| `rms/robot/{code}/event` | 轉接器→後端 | 1 |
| `rms/robot/{code}/cmd` | 後端→轉接器 | 1 |
| `rms/robot/{code}/ack` | 轉接器→後端 | 1 |
| `rms/robot/{code}/teleop` | 後端→轉接器，10 Hz | 0 |
| `rms/robot/{code}/online` | 轉接器（retain + LWT） | 1 |
| `rms/adapter/{name}/status` | 轉接器心跳 | 1 |

機器人代碼：`B2-001`、`X30-001`、`ANBOT-001`。座標在 MQTT 上一律是**平台座標**（公尺），轉接器負責與機器人地圖座標互轉（仿射轉換）。

## 規則
- 指令非同步：API 回 202 + cmdId；轉接器先回 `accepted` 再回 `done`/`failed`；15 秒沒 ack 視為逾時。
- 遙控 100 ms 一筆，500 ms 沒收到就停車；同一台只能一人遙控（Redis 鎖）。
- 所有 API 用 `@RequirePerm('<code>')`；只需登入的用 `@Authenticated()`、免登入的用 `@Public()`（漏標會被 `route-coverage.spec.ts` 擋下）。會改變狀態的用 `@OpLog`。權限檢查一律在後端。
- 秘密只放 `.env`，不得 commit。攝影機帳密在資料庫以 pgcrypto 加密。
- 不存人臉特徵與名單照片。
- Migration 用 node-pg-migrate，SQL 檔放 `db/migrations/`，只能新增不能改舊檔。
- 時間一律 UTC 儲存、前端顯示 Asia/Taipei。

## 開發環境（Windows 筆電）
- 見 `docs/setup-windows.md`。Docker Desktop + WSL2（mirrored 網路），程式碼放在 WSL 檔案系統內（`~/oviiai`），不要放 `C:\`。
- 16 GB 記憶體：開發時只開需要的服務，`docker compose --profile media up` 才會啟動 MediaMTX。
- 轉接器要連機器人時，筆電必須接上機器人網段；沒有機器人時用 `adapters/mock` 模擬。

## 常用指令
```bash
make up            # 起資料庫、Redis、EMQX、S3
make down
make test          # 全部測試（contracts、轉接器、後端、前端）
make seed-mock     # 在資料庫登記 6 台模擬機器人（後端只接受已登記的機器人）
make mock          # 啟動模擬機器人（3 品牌各 2 台）
make contracts     # 改了 packages/contracts 後重新編譯，後端才看得到
cd backend && npm run start:dev
cd frontend && npm run dev
```

## 各品牌 SDK 現況（2026-10-15 確認）
- **X30**：robotserver_sdk，TCP 連 106 導航主機 `192.168.1.106:30000`，16 byte 標頭 + XML。只有狀態(1002)、導航(1003)、取消(1004)、查詢(1007)。已在 `adapters/deep_x30/protocol.py` 以 Python 重寫。**上位機斷線會自動停止任務**（錯誤碼 41802）。充電、影像、遙控介面待原廠提供。
- **B2**：unitree_sdk2（C++，DDS）。只有運動控制（Move / MoveToPos / TrajectoryFollow）、狀態、單張影像，**沒有地圖導航與充電**。導航方案待宇樹回覆。
- **ANBOT-Y**：SDK 待提供。

## 提交
- 分支：`main` 受保護；功能分支 `feat/<模組>-<簡述>`，PR 合併。
- Commit 訊息用中文或英文皆可，第一行 ≤ 72 字。
- PR 前必須 `make test` 通過。
