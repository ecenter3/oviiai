# 正式環境部署注意事項

工程開發手冊「測試與部署」§3～§5 是部署流程；這份補充安全與資料保存的設定，部署前逐項確認。
（T-4x 部署工作時併入完整部署文件。）

## 1. 秘密與加密金鑰

| 環境變數 | 規則 | 不符合時 |
|---|---|---|
| `JWT_SECRET` | ≥ 32 字元，不可是範例值（`openssl rand -base64 48`） | 正式環境拒絕啟動 |
| `DATA_ENC_KEY` | ≥ 32 字元（`openssl rand -base64 48`） | 正式環境拒絕啟動 |
| `ADAPTER_KEY_<名稱>` | ≥ 16 字元（`openssl rand -hex 24`），每個轉接器一把 | 該轉接器取不到設定 |

### `DATA_ENC_KEY` 的保管（PR #10 審查第 4 點）
- 攝影機 RTSP 帳密、機器人連線密碼以這把金鑰（pgcrypto `pgp_sym_encrypt`）加密存放。**金鑰遺失 = 所有密碼無法解密**，只能逐台重新輸入。
- 金鑰要**和資料庫備份分開保存**：存在密碼管理器，或印出紙本放保險箱。不要跟 `pg_dump` 檔放在同一台機器或同一個備份媒體。
- 開發環境沒設時用固定的開發用金鑰，和正式金鑰不同：**不能把開發環境的資料庫搬到正式環境用**（加密欄位解不開），也不要反過來把正式資料搬到開發機。
- 更換金鑰需要把所有加密欄位以舊金鑰解密、新金鑰重新加密（目前沒有工具，需要時另做）。

## 2. PostgreSQL：查詢參數不寫進日誌（PR #10 審查第 2 點）
加密時明文與金鑰是以查詢參數送進資料庫。開了慢查詢日誌（`log_min_duration_statement`）或發生錯誤時，PostgreSQL 預設會把參數寫進日誌。正式環境必須設定：

```
log_parameter_max_length = 0
log_parameter_max_length_on_error = 0
```

開發環境已設在 `infra/docker-compose.dev.yml` 的 `command`。正式環境寫在 `postgresql.conf`，或 compose 的 `command: ["postgres", "-c", "log_parameter_max_length=0", "-c", "log_parameter_max_length_on_error=0", ...]`。
部署後確認：`SHOW log_parameter_max_length;` 兩個都是 `0`。另外 `log_statement` 不要設成 `all` 或 `mod`（會記下整句 SQL）。

## 3. Nginx：`/api/v1/adapter-config` 只開放轉接器網段（PR #10 審查第 3 點）
這個端點雖然要轉接器金鑰，但回傳**解密後的機器人連線密碼**，多一層網路限制：只允許轉接器主機所在網段，其他一律 403。範例設定見 `infra/nginx/oviiai.conf.example`（`geo $adapter_net` 與 `location ^~ /api/v1/adapter-config/`）。
- 轉接器用 `network_mode: host`，來源是主機 IP；若轉接器跑在另一台機器，填那台的網段。
- 部署後從控制室電腦測：`curl -k https://<主機>/api/v1/adapter-config/anbot` 應回 403。
- 整個平台建議只對控制室與管理網段開放，不對外網。

## 4. 操作日誌不含秘密（PR #10 審查第 1 點）
- 操作日誌記錄請求參數摘要：欄位名稱含 password、token、secret、key、credential、rtsp、url 的整個遮成 `***`；任何字串裡的 `協定://帳號:密碼@` 遮成 `協定://***:***@`。
- 寫入日誌前一律套用（`OpLogService.write`），不論從哪個功能寫入。
- 舊版（PR #10 以前）建立或修改攝影機的日誌可能含 RTSP 明文帳密：正式環境若曾用過舊版，部署後執行
  `DELETE FROM op_logs WHERE action IN ('camera.create','camera.update') AND detail::text ~ '://[^"/@[:space:]]+@';`

## 5. 資料保存期限
- 每日 03:30（台北）清除超過 1 年的已結束任務（含歷程）、已結束告警（含處理歷程）、操作日誌；刪除前先匯出 CSV 到物件儲存 `retention/` 備查。
- **備查檔本身的保存期限待業主確認**（PR #10 審查第 5 點）：目前 `retention/*.csv` 會一直留著。確定年限後在 SeaweedFS 設 TTL（例：`weed shell` → `fs.configure -locationPrefix=/buckets/rms/retention/ -ttl=3y -apply`），並寫回這裡。
- 媒體（抓拍、錄影）30 天、告警關聯檔案 1 年：媒體模組（T-28）上線時設定。
