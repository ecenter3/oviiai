-- Up Migration
-- 工程開發手冊「資料庫」§6 設定。auth.* 為登入鎖定門檻（系統規格書 §3「建議值」，故放設定）
CREATE TABLE settings (                       -- 單一 key-value，前端「派工與充電規則」頁
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
 ('charge.returnAt',      '25'),
 ('charge.minAccept',     '40'),
 ('charge.resumeAt',      '90'),
 ('dispatch.p1Preempt',   'true'),
 ('dispatch.approval',    'true'),
 ('dispatch.approvalUntil', '"2027-01-31"'),
 ('alarm.aiConfidence',   '70'),
 ('robot.offlineSec',     '10'),
 ('cmd.timeoutSec',       '15'),
 ('auth.maxFailedLogins', '5'),
 ('auth.lockMinutes',     '15');

-- Down Migration
DROP TABLE settings;
