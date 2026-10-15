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

## 規劃
- 遙控（`Move`）與狀態可先接：用 `unitree_sdk2_python` 的 B2 介面，避免編譯 C++。
- 導航介面確定後再實作 `navigate` / `patrol` / `charge`。
