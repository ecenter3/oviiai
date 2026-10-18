-- Up Migration
-- T-39 能耗管理：遙測加電壓、電流（轉接器有回報才有值；壓縮的 hypertable 可直接加可為 NULL 的欄位）
ALTER TABLE telemetry ADD COLUMN voltage real;
ALTER TABLE telemetry ADD COLUMN current real;

-- Down Migration
ALTER TABLE telemetry DROP COLUMN current;
ALTER TABLE telemetry DROP COLUMN voltage;
