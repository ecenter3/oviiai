-- 開發用：登記 adapters/mock/robots.yaml 的 6 台模擬機器人（adapter = 'mock'）。
-- 後端只接受資料庫裡登記的機器人；正式機器人由「機器人管理」（T-25）新增。可重複執行。
-- 用法：make seed-mock
INSERT INTO robots (code, brand, model, floor_id, adapter, caps) VALUES
 ('B2-001',    'unitree', 'B2',      '1f', 'mock', '{ptz,light}'),
 ('B2-002',    'unitree', 'B2',      '1f', 'mock', '{ptz,light}'),
 ('X30-001',   'deep',    'X30',     '2f', 'mock', '{}'),
 ('X30-002',   'deep',    'X30',     '2f', 'mock', '{}'),
 ('ANBOT-001', 'anbot',   'ANBOT-Y', 'b1', 'mock', '{ptz,light,talk}'),
 ('ANBOT-002', 'anbot',   'ANBOT-Y', 'b1', 'mock', '{ptz,light,talk}')
ON CONFLICT (code) DO NOTHING;
