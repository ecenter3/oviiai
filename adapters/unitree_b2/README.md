# 宇樹 B2 轉接器（待定）

unitree_sdk2（C++、DDS）對 B2 提供：
- `SportClient`：Damp、StandUp/StandDown、`Move(vx, vy, vyaw)`、`MoveToPos(x, y, yaw)`、`TrajectoryFollow`、步態切換等
- `RobotStateClient`、`MotionSwitcherClient`、`ConfigClient`
- `FrontVideoClient` / `BackVideoClient`：`GetImageSample` 單張影像
- 低階狀態 `rt/lowstate`（含 BMS 電量）

**沒有**：地圖建立、定位、導航到地圖上的點、自動充電、即時影像串流。

## 待宇樹回覆
1. 採購的 B2 是否附導航方案（建圖、定位、路徑規劃、自動回充）？有的話要它的介面文件。
2. 若沒有：平台需在選配 Jetson Orin NX 上自建 ROS 2 Nav2 + SLAM，估計再增加 20–30 人天。
3. 即時影像串流方式（機身攝影機 RTSP？）。
4. **（優先）B2 是否有自動充電座與對接介面？** 第一期 1F 有 10 台 B2，平台目前預設 B2 為人工充電模式（每次低電量都要派人充電或換電池）。
5. 若有充電座：上樁後 `rt/lowstate` 的 BMS 是否回報充電中（平台靠 `battery.charging` 判斷到樁）？

## 規劃
- 遙控（`Move`）與狀態可先接：用 `unitree_sdk2_python` 的 B2 介面，避免編譯 C++。
- 導航介面確定後再實作 `navigate` / `patrol` / `charge`。

## 充電：上樁後必須回報的欄位（所有轉接器）

平台判斷「到樁開始充電」與「仍在樁上」只看遙測（`backend/src/charging/charge-plan.ts` 的 `onCharger`）：

- `state = "charging"`，**或**
- `battery.charging = true`

任一成立即可。真機上樁後若 state 仍是 `idle`，**一定要把 `battery.charging` 設為 true**；兩者都沒有的話，平台會在 20 秒後判定「前往充電樁未完成」並釋放樁，
連續 3 次就停止自動回充並發「回充失敗」告警。離樁後兩者都要回到 false／非 charging。
