# 規格文件

從 Claude 文件匯出（2026-10-15）。原始文件仍可線上編輯；兩邊不一致時，以線上版為準，並重新匯出到這裡。

| 檔案 | 內容 | 線上版 |
|---|---|---|
| `manual/00–08` | 工程開發手冊：SQL、API、MQTT 格式、後端邏輯、頁面、工作清單（T-01～T-46） | [連結](https://claude.ai/code/artifact/6d3985a6-3094-476b-97c2-87ea5547b793) |
| `技術設計文件.md` | 架構決策 D1–D12、容量、可靠性、安全 | [連結](https://claude.ai/code/artifact/7a46dd40-c87a-412e-a99a-97edcb96f57e) |
| `系統規格書.md` | 功能需求、權限表、驗收標準 | [連結](https://claude.ai/code/artifact/aebd84d6-236b-4036-8fa1-956c6e408842) |

可操作原型在 `docs/prototype/oviiai-monitor.html`（瀏覽器直接開啟）。

文件裡的架構圖、流程圖是互動元件，匯出後只剩「embedded content」佔位文字，請看線上版。

## 文件與 repo 的差異（以 repo 為準）

手冊寫於 repo 建立之前，以下幾點已經在 repo 裡改掉，實作時照右欄：

| 手冊寫的 | repo 實際 | 原因 |
|---|---|---|
| `apps/api/`、`apps/web/`、`packages/shared/` | `backend/`、`frontend/`、`packages/contracts/` | 骨架已建立，不再搬動 |
| `adapters/anbot\|unitree\|deep/`、`adapters/simulator/` | `adapters/anbot/`、`unitree_b2/`、`deep_x30/`、`mock/` | 同上 |
| `adapters/common/schema.py` | `adapters/common/contracts.py` | 同上；欄位與手冊 §2 相同 |
| MinIO | SeaweedFS（S3 相容，`S3_*` 環境變數） | MinIO 社群版 2025-10 停止發布映像檔 |
| `db/migrations/001_init.sql` 一次建 24 張表 | node-pg-migrate 時間戳檔名；已有 `1760500000000_extensions.sql`，之後依模組各自新增 | 每個模組一支 migration 較好審查 |
| `RobotDriver` 每個指令一個方法（navigate、stop…） | `RobotDriver.execute(cmd)` 統一入口＋`capabilities` | 由 `common/bridge.py` 統一處理 ack 流程 |
| pnpm workspaces | 各資料夾獨立 npm | 先求簡單，需要時再改 |
| 操作權限 6 個（後端邏輯 §6） | 7 個：多 `op.media`（刪除抓拍與錄影），預設只給系統管理員 | PR #12 審查：只有瀏覽權限不應能刪證據 |
| 機器人參數四個子系統只列在系統規格書 | 欄位、選項代碼、範圍定義在 `packages/contracts/src/params.ts`，前後端共用 | 避免兩邊各寫一份 |

## 機器人 SDK 實況（2026-10-15 讀過原始碼）

手冊「機器人接入 §4」的「待確認」已有部分答案：

- **X30**：SDK 只有狀態、導航到點、取消、查詢。沒有充電指令、影像、遙控介面。上位機斷線會停任務。見 `docs/x30-sdk-notes.md`。
- **B2**：unitree_sdk2 只有運動控制與單張影像，沒有地圖導航、定位、充電。導航方案待宇樹回覆。見 `adapters/unitree_b2/README.md`。
- **ANBOT-Y**：SDK 未到。

## 待辦（外部）

- [ ] 人臉辨識系統 API 文件
- [ ] 萬為 ANBOT-Y SDK
- [ ] 宇樹：B2 導航方案與介面文件
- [ ] 宇樹（優先）：B2 是否有自動充電座與對接介面（目前 B2 預設人工充電，1F 10 台每次低電量都要派人）
- [ ] 各原廠：上樁對接成功後回報「充電中」的欄位（平台以 `state=charging` 或 `battery.charging=true` 判斷到樁）
- [ ] 雲深處：充電指令、影像串流、遙控介面、多台 IP 規劃
