# 介面規格（API）

所有 API 前綴 `/api/v1`，以 JSON 傳輸。後端用 NestJS Swagger 自動產生 OpenAPI 文件於 `/api/docs`，本分頁是實作依據。

## 1. 共通規則

- **驗證**：除登入外都需 `Authorization: Bearer <accessToken>`。每個端點標註所需權限碼，無權限回 403。
- **分頁**：`?page=1&size=20`，回應 `{ items: [...], total, page, size }`。
- **時間**：ISO 8601 UTC，前端轉 Asia/Taipei 顯示。
- **錯誤格式**：

```json
{ "error": { "code": "ROBOT_BUSY", "message": "ANBOT-003 正在執行任務", "details": {} } }
```

| HTTP | code | 意義 |
| --- | --- | --- |
| 400 | VALIDATION\_FAILED | 欄位不合法，details 列出欄位 |
| 401 | UNAUTHENTICATED / TOKEN\_EXPIRED | 未登入或需更新 token |
| 403 | FORBIDDEN | 無權限 |
| 404 | NOT\_FOUND | 資源不存在 |
| 409 | ROBOT\_BUSY / ROBOT\_OFFLINE / ROBOT\_ESTOP / TELEOP\_LOCKED / INVALID\_STATE | 狀態衝突 |
| 423 | ACCOUNT\_LOCKED | 登入失敗過多 |
| 504 | ROBOT\_TIMEOUT | 指令逾時未回覆 |

## 2. 端點清單

### 驗證與帳號

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| POST | /auth/login | — | `{username,password}` → `{accessToken, user, perms}`；設 refresh cookie |
| POST | /auth/refresh | — | 以 cookie 換新 accessToken |
| POST | /auth/logout | 登入 | 撤銷 refresh token |
| PUT | /auth/password | 登入 | `{oldPassword,newPassword}` |
| GET | /me | 登入 | 目前使用者與權限碼（前端用來隱藏選單） |
| GET/POST | /users | users | 列表／新增 |
| PATCH/DELETE | /users/:id | users | 修改、停用、刪除 |
| POST | /users/:id/reset-password | users | 系統產生臨時密碼 |
| GET/POST | /roles | roles | 角色列表／新增 |
| PATCH/DELETE | /roles/:id | roles | 改名、改權限；系統角色不可刪 |
| GET | /permissions | roles | 全部權限碼與中文名稱（樹狀） |
| GET | /oplogs | oplog | `?user&action&from&to`；`?format=csv` 匯出 |

### 場域與機器人

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| GET | /floors | 登入 | 含平面圖 URL、尺寸、配置台數 |
| PUT | /floors/:id | maps | 改名稱、尺寸、配置台數 |
| POST | /floors/:id/plan | maps | 上傳平面圖（multipart） |
| GET | /robots | robots | 含即時狀態（從 Redis）；`?floor&brand&state` |
| GET | /robots/:id | robots | 詳情＋最近 20 筆事件 |
| POST/PATCH/DELETE | /robots(/:id) | robotmgr | 新增、修改、停用機器人 |
| POST | /robots/:id/commands | 依指令 | 下達指令，見 §3 |
| POST | /robots/:id/teleop/acquire | op.remote | 取得遙控鎖 → `{lockId, ttlSec}` |
| POST | /robots/:id/teleop/release | op.remote | 釋放遙控鎖、歸還自動 |
| GET/PUT | /robots/:id/params | params / op.config | 參數四子系統 |
| POST | /robots/params/apply-floor | op.config | `{fromRobotId, floorId, subsystem}` |
| GET/PUT | /robots/:id/calibration | maps | 座標校正點與結果 |
| GET | /robots/:id/track | history | `?from&to` 軌跡（telemetry 降採樣） |
| GET/POST/PATCH/DELETE | /chargers, /cameras | maps | 充電樁與攝影機 |

### 導航與派工

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| CRUD | /pois, /zones, /paths | nav | 以 `?floor` 篩選；路徑被排程使用時不可刪（409） |
| CRUD | /patrol-schedules | nav | 巡邏排程 |
| POST | /patrol-schedules/:id/run | op.dispatch | 立即執行一次 |
| CRUD | /task-templates | dispatch | 任務範本 |
| GET | /tasks | dispatch | `?status&floor&robot&from&to` |
| POST | /tasks | op.dispatch | 建單，見下方範例 |
| GET | /tasks/:id | dispatch | 含 task\_events 歷程 |
| POST | /tasks/:id/approve | op.approve | 核准 |
| POST | /tasks/:id/reject | op.approve | `{reason}` |
| POST | /tasks/:id/cancel | op.dispatch | 取消（執行中則先停止機器人） |
| GET/PUT | /settings | settings / op.config | 派工、充電、告警門檻 |

建單範例：

```json
POST /api/v1/tasks
{
  "kind": "inspect",
  "priority": "P2",
  "floorId": "b1",
  "target": { "poiId": "7f1c..." },
  "robotId": null,
  "note": "確認 B1 出口閘門"
}
→ 201 { "id": "...", "code": "T-20261011-0042", "status": "pending_approval" }
```

### 告警

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| GET | /alarms | sysalarm 或 bizalarm | `?category&level&type&status&floor&robot&from&to`；`?format=csv` |
| GET | /alarms/:id | 同上 | 含處理歷程、截圖與影片 URL |
| POST | /alarms/:id/transition | op.alarm | `{to, note}`，合法轉換見後端邏輯 §5 |
| POST | /alarms/:id/report | op.alarm | 回報上位系統 |
| POST | /alarms/:id/dispatch | op.dispatch | 派最近機器人到告警位置 |
| GET/PUT | /alarm-rules | alarmset | 告警設置 |

### 媒體與整合

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| GET | /media | captures / records | `?kind&robot&from&to` |
| GET | /media/:id/url | 同上 | 回傳 5 分鐘有效的 MinIO 預簽名網址 |
| GET | /streams/:key/token | monitor | 取得 WebRTC 播放憑證，見「影像與整合」 |
| POST | /integrations/face/events | API 金鑰 | 人臉系統推送事件（若對方支援推送） |
| GET | /integrations/face/persons | face | 代理查詢人臉系統名單 |
| GET | /stats/summary | stats | 任務數、里程、告警、可用率（第二期） |
| GET | /health | — | 健康檢查：資料庫、Redis、MQTT、各轉接器心跳 |

### 場域快速設定

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| GET | /site/export | settings | 下載場域設定包（zip：`site.json`＋平面圖），不含密碼與連線密鑰 |
| POST | /site/import?dryRun=true | settings＋op.config | 上傳設定包，回傳新增／修改／刪除的差異清單，不寫入 |
| POST | /site/import | settings＋op.config | 確認後套用；在單一交易中完成，失敗全部還原 |
| GET | /import/templates/:kind | maps | 下載 cameras 或 robots 的 Excel／CSV 範本 |
| POST | /cameras/import、/robots/import | maps、robotmgr | 批次匯入；回傳每列結果（成功、錯誤原因），`?dryRun=true` 只檢查 |
| GET | /site/setup-status | settings | 設定精靈用：各步驟是否完成、缺什麼 |

`site.json` 含 `version` 欄位；匯入時版本不符先自動轉換，無法轉換則拒絕並說明原因。物件以代碼（如 `ANBOT-001`、`CAM-1F-07`）對應，不依賴 UUID，才能跨系統匯入。

## 3. 機器人指令

```json
POST /api/v1/robots/:id/commands
{ "type": "navigate", "args": { "x": 12.4, "y": 30.1, "yaw": 1.57 } }
→ 202 { "cmdId": "c_8f2...", "status": "sent" }
```

| type | args | 權限 |
| --- | --- | --- |
| navigate | x, y, yaw? | op.dispatch |
| stop | — | op.remote |
| estop / estop\_release | — | op.estop |
| charge | chargerId? | op.remote |
| pause / resume | — | op.remote |
| ptz | pan, tilt, zoom（-1..1） | op.remote |
| light | on, mode? | op.remote |
| snapshot | camera?: front\|rear | op.remote |
| record\_start / record\_stop | camera? | op.remote |
| speak | text 或 mediaId | op.remote |
| follow / follow\_stop | personId | op.remote |
| lift | height（第二期） | op.remote |

遙控速度不走 REST，由 WebSocket `teleop.cmd` 傳送。指令結果以 WebSocket `robot.cmdResult` 推送。

## 4. WebSocket

連線 `wss://<host>/ws?token=<accessToken>`（Socket.IO）。連線後送 `subscribe { floors: ["1f"] }` 只收關心樓層。

| 事件（伺服器 → 瀏覽器） | 內容 | 頻率 |
| --- | --- | --- |
| robot.state | `{robotId, x, y, yaw, battery, charging, state, taskId, rssi}` | 每台每秒最多 2 次（節流） |
| robot.cmdResult | `{cmdId, robotId, status, error?}` | 事件 |
| robot.online | `{robotId, online}` | 事件 |
| task.updated | 任務物件 | 事件 |
| alarm.new | 告警物件＋設定（popup、sound） | 事件 |
| alarm.updated | `{id, status, handler}` | 事件 |
| charger.updated | `{chargerId, occupiedBy, queue}` | 事件 |
| stats.tick | 首頁統計卡數字 | 每 5 秒 |

| 事件（瀏覽器 → 伺服器） | 內容 |
| --- | --- |
| subscribe | `{floors}` |
| teleop.cmd | `{robotId, lockId, vx, vy, wz}`，每 100 ms 一次；停送 500 ms 即停車 |
