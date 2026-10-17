-- Up Migration
-- PR #13 審查第 1 點：遙控鎖閒置多久（只收到零速度）自動回收，秒。「派工與充電規則」頁可調（60–1800）。
INSERT INTO settings (key, value) VALUES ('teleop.idleSec', '300') ON CONFLICT (key) DO NOTHING;

-- Down Migration
DELETE FROM settings WHERE key = 'teleop.idleSec';
