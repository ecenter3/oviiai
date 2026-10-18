# 雲深處 X30 對照表

平台訊息格式見 `packages/contracts`。X30 協定是 `protocol.py`：TCP 連 106 導航主機 `192.168.1.106:30000`，16 byte 標頭＋XML。
「待原廠」表示 SDK 目前沒有對應介面，轉接器回 `rejected`（`UNSUPPORTED`），後端依能力清單不會送。

## 遙測（1002 狀態，1 Hz 查詢）

| 平台欄位 | X30 | 說明 |
|---|---|---|
| `pose.x`、`pose.y` | `posX`、`posY` | 機器人地圖座標，經仿射轉換成平台座標 |
| `pose.yaw` | `angleYaw` | 同上，轉角度 |
| `battery.pct` | `electricity` | 限制在 0–100 |
| `battery.charging` | `chargeState != 0` | 待原廠確認上樁對接成功的欄位 |
| `battery.voltage`、`current` | — | 待原廠 |
| `speed` | `abs(speed)` | |
| `state` | 推算 | 有故障 → `fault`；充電中 → `charging`；導航中 → `navigating`；否則 `idle` |
| `faults` | `location != 0`、`motorState != 0` | `X30_LOCALIZATION_LOST`、`X30_MOTOR_{n}`，2 級 |
| `sensors.odom_total_m` | `sumOdom` | 累計里程，不是環境數值，後端不寫入 env_readings |
| `sensors.temp`、`humidity`、`co`… | — | 待原廠（有環境感測模組時，依下方「環境數值」回報） |

## 指令

| 平台指令 | X30 | 說明 |
|---|---|---|
| `navigate` | 1003 單點 | 平台座標轉機器人地圖座標 |
| `patrol` | 1003 多點 | `points[].task=false` 的點只經過不停留 |
| `stop`、`pause` | 1004 取消 | X30 沒有暫停，暫停也是取消；繼續由後端重新下導航 |
| `resume` | — | 後端重新下 `navigate`／`patrol` |
| `charge` | 1003 到 `dock_point` | 沒有對接指令，只開到充電樁前（待原廠） |
| `estop`、`estop_release` | — | 待原廠 |
| `ptz`、`light`、`snapshot`、`record_*` | — | 待原廠 |
| `speak`、`talk_start`、`talk_stop` | — | 待原廠 |
| `show_image` | — | 待原廠；X30 沒有螢幕，不會有 `screen` 能力 |
| `upload_logs` | — | 待原廠；要把日誌 HTTP PUT 到 `url`，不得超過 `maxBytes`（見 README「警示圖、日誌上傳」） |
| `set_params` | — | 只有共通層的遙控限速 `walk.speed` |
| `follow`、`lift` | — | 不支援 |

## 錯誤碼

| X30 | 平台 |
|---|---|
| 1003 `errorCode=2` | `failed`，`X30_CANCELLED` |
| 1003 `errorStatus` | `failed`，`X30_{errorStatus}`；屬於故障的另發 `fault` 事件 |
| 41802 上位機斷線 | 機器人自動停止任務，轉接器重連後回報 |
| 連線中斷 | `failed`，`X30_DISCONNECTED` |

## 環境數值（第二期 T-41，所有轉接器）

有環境感測器的機器人在遙測 `sensors` 帶數值，鍵名與單位用下表（後端只收這些；其他鍵如 `odom_total_m` 忽略）：

| 鍵 | 項目 | 單位 |
|---|---|---|
| `temp` | 溫度 | °C |
| `humidity` | 濕度 | % |
| `co` | 一氧化碳 | ppm |
| `co2` | 二氧化碳 | ppm |
| `ch4` | 可燃氣體 | %LEL |
| `h2s` | 硫化氫 | ppm |
| `o2` | 氧氣 | % |
| `pm25` | PM2.5 | µg/m³ |
| `smoke` | 煙霧濃度 | %obs/m |
| `noise` | 噪音 | dB |

能力清單請加上 `env`（機器人管理頁顯示「環境感測」）；後端以收到的 `sensors` 為準記錄。
