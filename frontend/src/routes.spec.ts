import { describe, expect, it } from 'vitest';
import { t } from './i18n';
import { buildMenu, homePath, PAGES } from './routes';

// 與 db/migrations/1760600000600_seed_roles_floors.sql 的預設角色相同（系統規格書 §3）
const ROLES = {
  警衛: ['monitor', 'robots', 'remote', 'history', 'captures', 'records', 'face', 'sysalarm', 'bizalarm', 'help', 'op.remote', 'op.estop', 'op.alarm'],
  維修人員: ['monitor', 'robots', 'energy', 'runlog', 'params', 'logs', 'versions', 'help', 'op.estop', 'op.config'],
  主管: ['monitor', 'robots', 'reports', 'stats', 'sysalarm', 'bizalarm', 'dispatch', 'help', 'op.dispatch', 'op.approve'],
};

const titles = (perms: string[]) => buildMenu(perms).flatMap((g) => g.items.map((p) => t(p.title)));

describe('選單依權限', () => {
  it('警衛：監控、遙控、人臉、告警、抓拍錄像；沒有管理功能', () => {
    const m = titles(ROLES.警衛);
    expect(m).toEqual(expect.arrayContaining(['實時監控', '機器人狀態', '實時遙控', '人臉檢測', '系統告警', '業務告警', '抓拍圖片', '錄像回放']));
    expect(m).not.toContain('派工管理');
    expect(m).not.toContain('使用者管理');
    expect(m).not.toContain('告警設置');
  });

  it('維修人員：沒有遙控（缺 remote）、有機器人參數', () => {
    const m = titles(ROLES.維修人員);
    expect(m).not.toContain('實時遙控');
    expect(m).toContain('機器人參數');
    expect(m).not.toContain('系統告警');
  });

  it('主管：派工管理、告警，沒有遙控', () => {
    const m = titles(ROLES.主管);
    expect(m).toEqual(expect.arrayContaining(['派工管理', '系統告警', '任務報告', '數據統計']));
    expect(m).not.toContain('實時遙控');
  });

  it('遙控頁需同時有 remote 與 op.remote', () => {
    expect(titles(['remote'])).not.toContain('實時遙控');
    expect(titles(['remote', 'op.remote'])).toContain('實時遙控');
  });

  it('沒有任何頁面權限：首頁導向 403；整組沒權限就不顯示該組', () => {
    expect(homePath([])).toBe('/forbidden');
    expect(buildMenu(['monitor']).map((g) => t(g.group))).toEqual(['監控']);
  });

  it('每個頁面權限碼都存在、路由不重複', async () => {
    const { ALL_PERMS } = await import('@oviiai/contracts');
    for (const p of PAGES) for (const c of p.perms) expect(ALL_PERMS).toContain(c);
    expect(new Set(PAGES.map((p) => p.path)).size).toBe(PAGES.length);
  });
});
