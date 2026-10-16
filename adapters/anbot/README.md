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
