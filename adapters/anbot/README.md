# 萬為 ANBOT-Y 轉接器（待 SDK）

SDK 文件到手後一週內完成對照表：狀態、導航、巡邏、充電、影像、遙控、PTZ、燈光、喊話各對應哪個介面。
SDK 到手時要確認：上樁對接成功後回報哪個欄位表示充電中（對應 `battery.charging`）。

實作方式同 `deep_x30/`：`protocol.py`（協定）、`client.py`（連線）、`driver.py`（RobotDriver）、`run.py`。

## 充電：上樁後必須回報的欄位（所有轉接器）

平台判斷「到樁開始充電」與「仍在樁上」只看遙測（`backend/src/charging/charge-plan.ts` 的 `onCharger`）：

- `state = "charging"`，**或**
- `battery.charging = true`

任一成立即可。真機上樁後若 state 仍是 `idle`，**一定要把 `battery.charging` 設為 true**；兩者都沒有的話，平台會在 20 秒後判定「前往充電樁未完成」並釋放樁，
連續 3 次就停止自動回充並發「回充失敗」告警。離樁後兩者都要回到 false／非 charging。

## 遙控、雲台、燈光、參數（所有轉接器；T-30、T-27）

- **遙控**：共通層（`common/bridge.py`）每收到一筆 teleop 就把平移速度限制在參數「導航速度」（`walk.speed`）以內再呼叫 `driver.teleop()`；500 ms 沒收到新的一筆就呼叫 `driver.stop_motion()`，品牌轉接器**必須**在 `stop_motion` 讓機器人停下。
- **雲台** `ptz {pan, tilt, zoom}`：**絕對位置**，正規化到 -1..1（zoom 0..1），轉接器換算成機型的角度範圍；`(0, 0)` 是回正。
- **燈光** `light {on, mode}`：`mode` 目前有 `alert`（警示燈光）、`fill`（補光燈），機型沒有的模式回 `failed`。
- **跟隨** `follow {personId}`／`follow_stop`：personId 是人臉系統的人員編號。
- **參數** `set_params {params}`：四個子系統的完整值（格式見 `packages/contracts/src/params.ts`），由共通層接收並存在 `driver.params`；
  要套用到機器人時覆寫 `driver.apply_params(params)`，只套用 SDK 支援的項目，並以 `split_params(params, 已套用的)` 回傳
  `{"applied": [...], "ignored": [...]}`（`"子系統.欄位"`），共通層放進 ack 的 `result`，參數頁顯示「已套用 N 項，此機型不支援：…」。
  哪些參數對應到 SDK 的哪個介面，寫在該品牌的 `MAPPING.md`（T-32、T-33、T-38）。
  預設實作只有共通層的遙控限速（`walk.speed`）；**導航時的速度上限要品牌 driver 實作才會生效**。
  後端在儲存後與機器人上線時都會送（上線補送 30 秒內最多一次）。
- 前端與後端依資料庫 `robots.caps`（機器人管理）顯示按鈕，請與轉接器的 `capabilities` 保持一致（例：沒有雲台就不要勾 `ptz`）。
