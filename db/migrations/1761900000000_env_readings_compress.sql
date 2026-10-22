-- Up Migration
-- env_readings 壓縮（PR #19 審查第 1 點）：28 台 × 5 項約每天 40 萬筆、保存 1 年約 1.5 億筆。
-- 同 telemetry：7 天後壓縮；依機器人＋項目分段（查詢多半依樓層／機器人＋項目＋時間）。
-- 壓縮後的 chunk 不用 point_id 部分索引；定點檢測頁只看最近 7 天，不受影響。
ALTER TABLE env_readings SET (timescaledb.compress, timescaledb.compress_segmentby = 'robot_id, kind', timescaledb.compress_orderby = 'at DESC');
SELECT add_compression_policy('env_readings', interval '7 days');

-- Down Migration
SELECT remove_compression_policy('env_readings', if_exists => true);
SELECT decompress_chunk(c, true) FROM show_chunks('env_readings') c;
ALTER TABLE env_readings SET (timescaledb.compress = false);
