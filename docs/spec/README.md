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
| 能力清單 ptz、light、talk、follow、lift、env | 多 `talk_live`（能接收即時音訊，對講方案 A）；`talk` 表示能播放音檔（方案 B） | 依能力決定顯示哪種對講，不做品牌判斷 |
| 指令類型（機器人接入 §2） | 多 `talk_start`、`talk_stop`（方案 A）；`speak` 的參數多 `audio`（方案 B 音檔） | 雙向對講 T-31 |
| 操作權限 6 個（後端邏輯 §6） | 7 個：多 `op.media`（刪除抓拍與錄影），預設只給系統管理員 | PR #12 審查：只有瀏覽權限不應能刪證據 |
| 場域匯入的「刪除」 | 預設「合併」不刪；勾「同步刪除」才刪，且要輸入確認字。刪除時機器人改停用、有告警紀錄的攝影機與使用中的充電樁改停用、樓層與角色不刪；`auth.*` 與座標校正不在設定包 | 歷史紀錄參照、外鍵；登入政策與校正屬於各場域 |
| 機器人參數四個子系統只列在系統規格書 | 欄位、選項代碼、範圍定義在 `packages/contracts/src/params.ts`，前後端共用 | 避免兩邊各寫一份 |
| `.env` 的 `MQTT_API_USER`／`MQTT_API_PASSWORD`（EMQX 帳密） | EMQX 以 JWT 認證，`EMQX_JWT_SECRET` 與後端共用；後端自己簽（帳號 `backend`），轉接器的憑證由 `GET /adapter-config/{name}` 核發，權限只含自己的機器人主題 | 各轉接器各一組帳號，不能互相冒用（安全收尾 e；deploy.md 第 10 節） |
| 事件類型 | 多 `talk_failed`（轉接器拉對講音訊失敗或中斷） | PR #15 審查第 3 點 |
| 錯誤碼 | 多 `PASSWORD_CHANGE_REQUIRED`（403，管理員建立帳號或重設密碼後須先改密碼） | 安全收尾 a |
| 遙測電池欄位 `pct`、`charging`、`voltage` | 多 `current`（安培，充電為正）；telemetry 表加 `voltage`、`current` 欄位 | T-39 能耗頁的電壓、電流曲線（原型有）；SDK 沒提供就不填 |
| 能耗頁資料來源寫 `stats` | 新增 `GET /energy/:robotId`（曲線＋充電紀錄與統計）；任務報告 `GET /reports/tasks`、`/reports/tasks/:id`；運行日誌 `GET /runlog/:robotId`；`GET /robots/:id/track` 依介面規格 | `/stats/summary` 留給數據統計頁（T-40） |
| 閒置登出（安全收尾 d） | 「不自動登出」在角色上設定（`roles.no_idle_logout`），全站 `auth.idleMinutes` 只管 5～480 分鐘 | PR #16 審查第 1 點 |
| MQTT 憑證效期 | 轉接器 1 小時；機器人改派、停用時後端以 EMQX 管理 API 踢掉舊轉接器（`EMQX_API_KEY`／`EMQX_API_SECRET`） | PR #16 審查第 2 點 |
| 數據統計 `GET /stats/summary` 只寫「任務數、里程、告警、可用率」 | 依台北日期區間、樓層、機器人；另有 `GET /stats/export`（Excel）。每台每天的里程與狀態時長存 `robot_daily_stats`（每日排程＋查詢時補算） | 原始遙測每台每秒一筆，跨月統計不能每次重掃 |
| 歷史視頻「時間軸播放」 | `GET /media/history`：只列出已有的錄影片段、抓拍與告警時間點（沒有全天候錄影） | 本平台只有手動、告警、巡邏觸發的錄影 |
| 音視頻管理「上傳語音與警示圖」 | `/assets`（音訊、警示圖、詞條）＋推送 `POST /assets/:id/push`；新指令 `show_image`、新能力 `screen` | 手冊沒有對應 API 與指令 |
| 日誌「日誌下載」 | `/robot-logs`：新指令 `upload_logs`（轉接器 PUT 到預簽名網址），保存 30 天 | 手冊沒有對應 API 與指令 |
| 環境監測、定點檢測（`env_readings`） | 新表 `env_thresholds`（項目、上下限、告警類型）、`inspection_points`（興趣點＋頻率＋半徑），`env_readings` 加 `point_id`；API `/env/thresholds`、`/env/summary`、`/env/map`、`/env/points`（含 `measure`、`readings`）。遙測 `sensors` 只收門檻表列出的項目，30 秒取樣 | 手冊只有資料表；系統規格書寫「本期先預留介面」，這裡實作完整流程 |
| 選車只看樓層、電量、狀態 | 環境監測（`env`）、氣體檢測（`gas`）任務要 `env` 能力 | 沒有感測器的機器人去量測沒有意義 |
| 版本「韌體版本」 | `GET /versions`：後端、前端、轉接器版本；機器人韌體待 SDK，韌體上傳推送不做 | 各家 SDK 目前沒有韌體版本與 OTA 介面 |

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
