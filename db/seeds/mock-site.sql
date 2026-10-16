-- 開發用：make mock 的模擬場域。可重複執行。用法：make seed-mock
-- 後端只接受資料庫裡登記的機器人；正式資料由「機器人管理」「地圖管理」（T-25）建立。

-- 6 台模擬機器人（adapters/mock/robots.yaml），adapter = 'mock'
INSERT INTO robots (code, brand, model, floor_id, adapter, caps) VALUES
 ('B2-001',    'unitree', 'B2',      '1f', 'mock', '{ptz,light}'),
 ('B2-002',    'unitree', 'B2',      '1f', 'mock', '{ptz,light}'),
 ('X30-001',   'deep',    'X30',     '2f', 'mock', '{}'),
 ('X30-002',   'deep',    'X30',     '2f', 'mock', '{}'),
 ('ANBOT-001', 'anbot',   'ANBOT-Y', 'b1', 'mock', '{ptz,light,talk}'),
 ('ANBOT-002', 'anbot',   'ANBOT-Y', 'b1', 'mock', '{ptz,light,talk}')
ON CONFLICT (code) DO NOTHING;

-- 樓層尺寸（公尺）：只在尚未設定時填入，比例參考原型平面圖
UPDATE floors SET width_m = 40, height_m = 36 WHERE id = '1f' AND width_m IS NULL;
UPDATE floors SET width_m = 50, height_m = 29 WHERE id = '2f' AND width_m IS NULL;
UPDATE floors SET width_m = 42, height_m = 28 WHERE id = 'b1' AND width_m IS NULL;

-- 每層 2 座充電樁，位置與 robots.yaml 的 dock 相同
INSERT INTO chargers (code, floor_id, x, y, brand) VALUES
 ('CHG-1F-1', '1f', 1, 1, 'unitree'), ('CHG-1F-2', '1f', 1, 3, 'unitree'),
 ('CHG-2F-1', '2f', 1, 1, 'deep'),    ('CHG-2F-2', '2f', 1, 3, 'deep'),
 ('CHG-B1-1', 'b1', 2, 2, 'anbot'),   ('CHG-B1-2', 'b1', 2, 6, 'anbot')
ON CONFLICT (code) DO NOTHING;

-- 攝影機點位（沒有影像來源：rtsp_url 空白，影像串接是 T-29）
INSERT INTO cameras (code, name, floor_id, x, y, rtsp_url, stream_key) VALUES
 ('CAM-1F-01', '1F 大門',     '1f',  4, 32, ''::bytea, 'mock-cam-1f-01'),
 ('CAM-1F-02', '1F 走廊東',   '1f', 30, 18, ''::bytea, 'mock-cam-1f-02'),
 ('CAM-1F-03', '1F 會議室',   '1f', 18,  6, ''::bytea, 'mock-cam-1f-03'),
 ('CAM-2F-01', '2F 產線 A',   '2f', 12, 20, ''::bytea, 'mock-cam-2f-01'),
 ('CAM-2F-02', '2F 倉儲',     '2f', 40, 10, ''::bytea, 'mock-cam-2f-02'),
 ('CAM-B1-01', 'B1 車道入口', 'b1', 38, 24, ''::bytea, 'mock-cam-b1-01'),
 ('CAM-B1-02', 'B1 電梯廳',   'b1', 20,  4, ''::bytea, 'mock-cam-b1-02')
ON CONFLICT (code) DO NOTHING;

-- 興趣點（派工目的地；新增修改是導航管理 T-23）。以樓層＋名稱判斷是否已存在
INSERT INTO pois (floor_id, name, x, y)
SELECT v.floor_id, v.name, v.x, v.y FROM (VALUES
 ('1f', '大廳',     20.0, 32.0), ('1f', '會議室',   18.0,  8.0), ('1f', '機房',     35.0, 20.0), ('1f', '出口',      4.0, 34.0),
 ('2f', '產線 A',   12.0, 18.0), ('2f', '倉儲區',   40.0, 12.0), ('2f', '配電室',   45.0, 25.0),
 ('b1', '車道入口', 38.0, 24.0), ('b1', '電梯廳',   20.0,  4.0), ('b1', '水塔',      6.0, 20.0)
) AS v(floor_id, name, x, y)
WHERE NOT EXISTS (SELECT 1 FROM pois p WHERE p.floor_id = v.floor_id AND p.name = v.name);

-- 任務範本（系統規格書 §5：日常巡檢、環境監測、安全巡查、設備檢查、氣體檢測）
INSERT INTO task_templates (name, kind, priority, floor_id, target)
SELECT v.name, v.kind, v.priority, v.floor_id, jsonb_build_object('poiId', p.id)
FROM (VALUES
 ('日常巡檢', 'inspect',   'P3', '1f', '大廳'),
 ('環境監測', 'env',       'P3', '2f', '配電室'),
 ('安全巡查', 'security',  'P2', 'b1', '車道入口'),
 ('設備檢查', 'equipment', 'P3', '1f', '機房'),
 ('氣體檢測', 'gas',       'P2', '2f', '倉儲區')
) AS v(name, kind, priority, floor_id, poi)
JOIN pois p ON p.floor_id = v.floor_id AND p.name = v.poi
WHERE NOT EXISTS (SELECT 1 FROM task_templates t WHERE t.name = v.name);
