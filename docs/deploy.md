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

## 3. `/api/v1/adapter-config` 只開放轉接器網段（PR #10 第 3 點、PR #11 第 1 點）
這個端點雖然要轉接器金鑰，但回傳**解密後的機器人連線密碼**，所以有兩層網路限制，任一層都擋得住：
1. **後端**：`ADAPTER_ALLOWED_CIDRS`（逗號分隔，例：`192.168.10.0/24,127.0.0.1/32`）。來源 IP 不在清單內一律 403。**正式環境（`NODE_ENV=production`）沒設就全部拒絕**；開發環境沒設則允許並在啟動時警告。
   - 後端在 Nginx 後面時，`TRUST_PROXY` 是信任的代理位址（預設 `loopback`，Nginx 在同一台時不用改；在別台時設成那台的 IP），後端才會用 `X-Forwarded-For` 的真實來源，否則看到的都是 Nginx 的 IP。
   - 轉接器用 `network_mode: host` 直連後端時，來源是主機 IP（`127.0.0.1`）。
2. **Nginx**：`infra/nginx/oviiai.conf.example` 的 `geo $adapter_net` 與 `location ~* ^/api/v1/adapter-config(/|$)`。**用不分大小寫的正規式**：Express 的路由不分大小寫，`/API/V1/Adapter-Config/...` 也會進到後端，用前綴比對的 `location ^~` 擋不住。
   - 安全標頭（`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、HSTS）放在 `infra/nginx/security-headers.conf`，複製到 `/etc/nginx/snippets/`。注意 Nginx 的 `add_header` 只要 location 裡有自己的 `add_header`，就不會繼承 server 層的，所以每個有 `add_header` 的 location 都要再 `include` 一次（範例已處理）。
   - `/internal/` 一律回 404（MediaMTX 驗證回呼只給 MediaMTX 用，見第 6 節）。
- 部署後從控制室電腦測，下面都應回 403：
  `curl -k https://<主機>/api/v1/adapter-config/anbot`、`curl -k https://<主機>/API/V1/ADAPTER-CONFIG/anbot`
- 整個平台建議只對控制室與管理網段開放，不對外網。

## 4. 操作日誌不含秘密（PR #10 審查第 1 點）
- 操作日誌記錄請求參數摘要：欄位名稱含 password、token、secret、key、credential、rtsp、url 的整個遮成 `***`；任何字串裡的 `協定://帳號:密碼@` 遮成 `協定://***:***@`。
- 寫入日誌前一律套用（`OpLogService.write`），不論從哪個功能寫入。
- 舊版（PR #10 以前）建立或修改攝影機的日誌可能含 RTSP 明文帳密：正式環境若曾用過舊版，部署後執行
  `DELETE FROM op_logs WHERE action IN ('camera.create','camera.update') AND detail::text ~ '://[^"/@[:space:]]+@';`

## 4-1. 刪除抓拍與錄影的權限（PR #12 審查第 1 點）
- 刪除改為操作權限 `op.media`（「刪除抓拍與錄影」），migration 只預設給**系統管理員**；其他角色要刪，由系統管理員在「角色管理」勾選。
- 與告警關聯的抓拍、錄影是證據，任何人都不能手動刪（回 409），只能由保存期限排程（1 年）清除。

## 5. 資料保存期限
- 每日 03:30（台北）清除超過 1 年的已結束任務（含歷程）、已結束告警（含處理歷程）、操作日誌；刪除前先匯出 CSV 到物件儲存 `retention/` 備查。
- **備查檔本身的保存期限待業主確認**（PR #10 審查第 5 點）：目前 `retention/*.csv` 會一直留著。確定年限後在 SeaweedFS 設 TTL（例：`weed shell` → `fs.configure -locationPrefix=/buckets/rms/retention/ -ttl=3y -apply`），並寫回這裡。
- 媒體（抓拍、錄影）30 天，與告警關聯的 1 年：同一個排程清除，資料列與物件儲存的檔案（`media/snapshots/`、`media/clips/`）一起刪。

## 6. 影像串流（MediaMTX，T-29）與抓拍錄影（T-28）
- MediaMTX 設定在 `infra/mediamtx.yml`，攝影機路徑由後端用 Control API（`:9997`）同步，**不要手動在 yml 加 paths**。路徑名稱：攝影機 `cam/<代碼>`，機器人 `robot/<代碼>/front`。
- 讀取權限一律由後端決定：MediaMTX 每次有人讀就呼叫 `http://<後端>:3000/internal/media/auth`。
  - 這個回呼**只給 MediaMTX 用**：Nginx 不轉送 `/internal/`，後端的 3000 埠只開放給本機與 MediaMTX 容器（防火牆）。
  - 瀏覽器帶後端發的播放憑證（60 秒有效，綁定路徑與使用者）。
  - 後端抓拍、錄影用內部帳號 `MEDIA_INTERNAL_USER` / `MEDIA_INTERNAL_PASSWORD`，**正式環境必須設**（`openssl rand -hex 24`），沒設後端不會啟動。
- **播放權杖不進日誌**（PR #12 審查第 4 點）：WHEP 網址帶 `?token=`（60 秒有效、綁路徑與使用者）。Nginx 的 `location /media/` 改用不含查詢字串的 `log_format noquery`（記 `$uri` 不記 `$request`），範例設定已處理；`Referer` 也不記（2026-10-17 以 nginx 1.27 實測：access log 只有 `GET /media/cam/X/whep`）。**注意**：Nginx 的 error log 在連不上 MediaMTX 等錯誤時仍會記完整請求列（含權杖），這無法用 log_format 關掉；權杖 60 秒即失效，error log 權限設為僅 root 與維運人員可讀即可。MediaMTX 在 `logLevel: info` 不記查詢字串（2026-10-17 以開發環境日誌確認），不要調成 `debug`。若之後讓瀏覽器經 Nginx 連 S3 預先簽名網址，該 location 也要用 `noquery`（簽名在查詢字串）。
- `MEDIA_PUBLIC_URL`：瀏覽器連 WHEP 的位址，正式環境經 Nginx 為 `https://<主機>/media`（範例設定的 `location /media/`）。
- WebRTC 媒體走 TCP 8189（`webrtcLocalTCPAddress`），`webrtcAdditionalHosts` 要改成**瀏覽器連得到的主機 IP**（開發是 127.0.0.1）。防火牆對控制室網段開 8189/TCP。
- `MEDIA_TEST_SOURCE` 正式環境預設關閉，**不要設成 true**（會讓攝影機改播測試影像）。
- 後端用 ffmpeg 抓拍與錄影：預設用 npm 套件 `ffmpeg-static`，也可用 `FFMPEG_PATH` 指定系統的 ffmpeg。靜態編譯的 ffmpeg 不能自己解析主機名稱（會當掉），後端已先把 `MEDIAMTX_RTSP` 的主機名解析成 IP 再交給它。
- 抓拍、錄影檔放物件儲存，瀏覽器用預先簽名網址直接下載：`S3_PUBLIC_ENDPOINT` 設成**瀏覽器連得到**的 SeaweedFS S3 位址（簽名含主機名，不能事後改寫）。
- 錄影單段上限 `media.maxRecordSec`（預設 600 秒）；同時播放上限 `media.maxStreams`（預設 16 路）。
- 錄影先寫到後端主機暫存目錄（`$TMPDIR/oviiai-rec/`），結束後以串流分段上傳到物件儲存（每段 8 MB，不整檔讀進記憶體），上傳完刪除。後端異常結束留下的暫存檔，下次啟動時清掉超過 1 小時的（沒正常收尾的 MP4 缺索引，無法播放，不上傳）。暫存目錄所在磁碟至少留「同時錄影路數 × 300 MB」。

## 7. 遙控與機器人參數（T-30、T-27）
- 遙控速度經 WebSocket 每 100 ms 一筆；轉接器 500 ms 沒收到就停車。Nginx 的 `/ws` 要開 WebSocket（範例已設），不要加會緩衝的代理。
- 遙控鎖 30 秒 TTL；遙控頁沒在動時每 10 秒送一筆零速度續期，關閉分頁時以 keepalive 請求釋鎖。
- 遙控閒置（PR #13 審查第 1 點）：遙控頁 3 分鐘沒操作先提示、30 秒後自動歸還；後端在持有人連續 `teleop.idleSec`（預設 300 秒，「派工與充電規則」頁可調 1–30 分鐘）只送零速度時回收鎖，任務照常繼續。
- 機器人參數存在資料庫，儲存後與機器人上線時都會送 `set_params`；轉接器重啟後會在上線時拿到最新參數，不需要手動重送。

## 8. 換場域：設定包、批次匯入、設定精靈（T-44、T-45、T-46）
- **設定包**（「管理設置 → 場域匯出／匯入」）：zip 內有 `site.json`、`plans/` 平面圖、`說明.txt`。**不含**使用者帳號、攝影機 RTSP 帳密（只留不含帳密的位址）、機器人連線密碼、轉接器金鑰、登入鎖定政策（`auth.*`）、座標校正與歷史資料。設定包本身沒有秘密，但含場域配置（攝影機位置、IP），仍請當內部文件保管。
- **匯入**一律先預覽差異再套用，在單一交易中完成（失敗全部還原；已上傳的平面圖會刪掉）。
  - **預設「合併」**：只新增、修改，不刪任何東西（PR #14 審查第 2 點）。用在只匯出某層樓、手動刪過內容或舊的設定包時都安全。
  - **勾選「同步刪除」**：設定包裡沒有、系統裡有的項目——興趣點、區域、路徑、巡邏排程、任務範本、充電樁、攝影機**刪除**；**機器人改停用**（歷史紀錄參照）；有告警紀錄的攝影機、使用中的充電樁改停用；樓層與角色不刪。預覽以紅字標出刪除數，套用前要輸入確認字「刪除」（後端也檢查）。用在整個場域搬遷。
  - **角色權限**：設定包裡新增或權限有增加的角色，增加的權限不能超出匯入者自己的權限（與角色管理相同的檢查；PR #14 審查第 1 點）。超出時預覽列出角色與權限，整包拒絕（403）；請由有這些權限的人（通常是系統管理員）匯入。系統管理員角色的權限不會被設定包改掉。
- 匯入後要做：「地圖管理」重新輸入攝影機帳密、「機器人管理」輸入連線密碼、現場重做座標校正。新場域設定精靈（`/setup`）會列出還缺什麼；系統空白（沒有機器人也沒有攝影機）時，有 settings 權限的人登入後自動開啟。
- **批次匯入**（地圖管理、機器人管理頁的「批次匯入」）：Excel（.xlsx）或 CSV（UTF-8，Excel 選「CSV UTF-8」另存），一次最多 1000 列、5 MB；Excel 解壓縮後總大小上限 50 MB（先檢查 zip 目錄，PR #14 審查第 3 點）。代碼已存在的會更新那一筆；RTSP、密碼欄留空表示不變。
- 相依套件：讀寫 Excel 用 `exceljs`，它帶的 `uuid` 以 npm `overrides` 升到 11.1.1 以上（GHSA-w5hq-g745-h8pq；exceljs 只用 v4，不受影響，升級是為了讓 `npm audit` 乾淨）。

## 9. 雙向對講（T-31）
- 依機器人「能力」決定方式（機器人管理勾選）：**即時對講**（`talk_live`，方案 A）或 **語音播放**（`talk`，方案 B 按鍵說話）；都沒勾就不顯示對講。
- **方案 A**：瀏覽器麥克風以 WHIP 推到 MediaMTX 的 `talk/<代碼>`（經 Nginx 的 `/media/`，同播放），轉接器以 RTSP 拉這一路送到機器人喇叭；現場聲音從影像串流聽（對講時取消靜音）。
  - 一台同時只有一人對講（MediaMTX 路徑 `overridePublisher: false`）。
  - 權限：瀏覽器拿後端核發的 **publish 憑證**（60 秒、只能推這一路）；轉接器拿 **短憑證**放在 RTSP 帳密（`rtsp://talk:<憑證>@…`）。短憑證約 33 字，因為 ffmpeg 的 RTSP 用 128 bytes 存網址帳密，一般憑證會被截斷（實測）。播放憑證不能用來推流或旁聽對講。
  - `MEDIA_ADAPTER_RTSP`：轉接器連 MediaMTX 的 RTSP 位址；轉接器在別台主機時要設，並開放轉接器網段到 MediaMTX 8554/TCP。
  - 瀏覽器只有在 **HTTPS**（或 localhost）下才給麥克風；正式環境一定要走 Nginx 的 HTTPS。第一次使用時瀏覽器會詢問麥克風權限。
- **方案 B**：按住錄音、放開送出（最長 30 秒、5 MB）。音檔暫存物件儲存 `speak/`，`speak` 指令只帶 **5 分鐘預簽名網址**，轉接器下載後播放；指令結束（完成、失敗、逾時）就刪檔，殘留的由每日保存期限排程清（1 天）。不把音檔塞進 MQTT：EMQX 預設封包上限 1 MB，超過會把後端斷線（PR #15 審查第 1 點）。
  - `S3_ADAPTER_ENDPOINT`：轉接器連得到的 SeaweedFS S3 位址（預簽名網址簽在這個位址）；轉接器與後端同一台時不用設（用 `S3_ENDPOINT`）。轉接器在別台主機時開放轉接器網段到 S3 8333/TCP。
- 只有對講者本人或系統管理員能結束對講（管理員結束時會踢掉對方的推流並通知對方）；轉接器拉流失敗或中斷時回報 `talk_failed` 事件，控制室畫面顯示「機器人端已斷線」並結束對講（PR #15 審查第 2、3 點）。
- 對講的開始、結束與每次按鍵說話都記在操作日誌（`robot.talk_start`、`robot.talk_stop`、`robot.speak`），不記內容。

