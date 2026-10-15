import type { PermCode } from '@oviiai/contracts';
import type { MessageKey } from './i18n';

export interface PageDef {
  path: string;
  title: MessageKey;
  /** 需全部具備（例：遙控頁需 remote＋op.remote） */
  perms: PermCode[];
  group: MessageKey;
  /** 工作清單編號，佔位頁顯示 */
  task: string;
  phase: 1 | 2;
  /** 不出現在選單（例：/remote/:id 從機器人頁進入） */
  hidden?: boolean;
}

/** 前端頁面 §3 逐頁規格（路由、權限碼）；原型不在 repo，選單分組依權限樹 */
export const PAGES: PageDef[] = [
  { path: '/', title: 'page.monitor', perms: ['monitor'], group: 'menu.group.monitor', task: 'T-14', phase: 1 },
  { path: '/robots', title: 'page.robots', perms: ['robots'], group: 'menu.group.monitor', task: 'T-15', phase: 1 },
  { path: '/remote', title: 'page.remote', perms: ['remote', 'op.remote'], group: 'menu.group.monitor', task: 'T-30', phase: 1 },
  { path: '/remote/:id', title: 'page.remote', perms: ['remote', 'op.remote'], group: 'menu.group.monitor', task: 'T-30', phase: 1, hidden: true },
  { path: '/face', title: 'page.face', perms: ['face'], group: 'menu.group.monitor', task: 'T-34', phase: 1 },

  { path: '/nav', title: 'page.nav', perms: ['nav'], group: 'menu.group.dispatch', task: 'T-24', phase: 1 },
  { path: '/dispatch', title: 'page.dispatch', perms: ['dispatch'], group: 'menu.group.dispatch', task: 'T-20', phase: 1 },

  { path: '/alarms/system', title: 'page.sysalarm', perms: ['sysalarm'], group: 'menu.group.alarms', task: 'T-22', phase: 1 },
  { path: '/alarms/business', title: 'page.bizalarm', perms: ['bizalarm'], group: 'menu.group.alarms', task: 'T-22', phase: 1 },
  { path: '/alarms/settings', title: 'page.alarmset', perms: ['alarmset'], group: 'menu.group.alarms', task: 'T-22', phase: 1 },

  { path: '/captures', title: 'page.captures', perms: ['captures'], group: 'menu.group.media', task: 'T-28', phase: 1 },
  { path: '/records', title: 'page.records', perms: ['records'], group: 'menu.group.media', task: 'T-28', phase: 1 },
  { path: '/history', title: 'page.history', perms: ['history'], group: 'menu.group.media', task: 'T-40', phase: 2 },
  { path: '/media', title: 'page.media', perms: ['media'], group: 'menu.group.media', task: 'T-42', phase: 2 },

  { path: '/energy', title: 'page.energy', perms: ['energy'], group: 'menu.group.reports', task: 'T-39', phase: 2 },
  { path: '/reports', title: 'page.reports', perms: ['reports'], group: 'menu.group.reports', task: 'T-39', phase: 2 },
  { path: '/stats', title: 'page.stats', perms: ['stats'], group: 'menu.group.reports', task: 'T-40', phase: 2 },
  { path: '/runlog', title: 'page.runlog', perms: ['runlog'], group: 'menu.group.reports', task: 'T-39', phase: 2 },
  { path: '/env', title: 'page.env', perms: ['env'], group: 'menu.group.reports', task: 'T-41', phase: 2 },
  { path: '/points', title: 'page.points', perms: ['points'], group: 'menu.group.reports', task: 'T-41', phase: 2 },

  { path: '/settings', title: 'page.settings', perms: ['settings'], group: 'menu.group.admin', task: 'T-20', phase: 1 },
  { path: '/site', title: 'page.site', perms: ['settings'], group: 'menu.group.admin', task: 'T-44', phase: 1 },
  { path: '/params', title: 'page.params', perms: ['params'], group: 'menu.group.admin', task: 'T-27', phase: 1 },
  { path: '/robot-admin', title: 'page.robotmgr', perms: ['robotmgr'], group: 'menu.group.admin', task: 'T-25', phase: 1 },
  { path: '/maps', title: 'page.maps', perms: ['maps'], group: 'menu.group.admin', task: 'T-25', phase: 1 },
  { path: '/users', title: 'page.users', perms: ['users'], group: 'menu.group.admin', task: 'T-05', phase: 1 },
  { path: '/roles', title: 'page.roles', perms: ['roles'], group: 'menu.group.admin', task: 'T-05', phase: 1 },
  { path: '/oplogs', title: 'page.oplog', perms: ['oplog'], group: 'menu.group.admin', task: 'T-06', phase: 1 },
  { path: '/logs', title: 'page.logs', perms: ['logs'], group: 'menu.group.admin', task: 'T-42', phase: 2 },
  { path: '/versions', title: 'page.versions', perms: ['versions'], group: 'menu.group.admin', task: 'T-42', phase: 2 },
  { path: '/help', title: 'page.help', perms: ['help'], group: 'menu.group.admin', task: 'T-42', phase: 2 },
];

export const allowed = (page: PageDef, perms: readonly string[]) => page.perms.every((p) => perms.includes(p));

/** 依權限產生選單：沒有權限的頁面不出現；整組都沒有就不顯示該組 */
export function buildMenu(perms: readonly string[]): { group: MessageKey; items: PageDef[] }[] {
  const groups = new Map<MessageKey, PageDef[]>();
  for (const p of PAGES) {
    if (p.hidden || !allowed(p, perms)) continue;
    groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
}

/** 登入後的預設頁：第一個有權限的頁面 */
export function homePath(perms: readonly string[]): string {
  return PAGES.find((p) => !p.hidden && allowed(p, perms))?.path ?? '/forbidden';
}
