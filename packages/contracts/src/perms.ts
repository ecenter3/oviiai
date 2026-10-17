/**
 * 權限碼（後端邏輯 §6）。頁面權限與操作權限兩層，GET /permissions 以此回傳樹狀清單。
 * 後端、前端都從這裡引用。
 */
export const PERM_TREE = [
  {
    name: '監控',
    children: [
      { code: 'monitor', name: '實時監控' },
      { code: 'robots', name: '機器人狀態' },
      { code: 'remote', name: '實時遙控' },
      { code: 'face', name: '人臉檢測' },
    ],
  },
  {
    name: '導航與派工',
    children: [
      { code: 'nav', name: '導航管理' },
      { code: 'dispatch', name: '派工管理' },
    ],
  },
  {
    name: '告警',
    children: [
      { code: 'sysalarm', name: '系統告警' },
      { code: 'bizalarm', name: '業務告警' },
      { code: 'alarmset', name: '告警設置' },
    ],
  },
  {
    name: '影像',
    children: [
      { code: 'captures', name: '抓拍圖片' },
      { code: 'records', name: '錄像回放' },
      { code: 'history', name: '歷史視頻' },
      { code: 'media', name: '音視頻管理' },
    ],
  },
  {
    name: '報表與監測',
    children: [
      { code: 'energy', name: '能耗管理' },
      { code: 'reports', name: '任務報告' },
      { code: 'stats', name: '數據統計' },
      { code: 'runlog', name: '運行日誌' },
      { code: 'env', name: '環境監測' },
      { code: 'points', name: '定點檢測' },
    ],
  },
  {
    name: '管理設置',
    children: [
      { code: 'settings', name: '派工與充電規則' },
      { code: 'params', name: '機器人參數' },
      { code: 'robotmgr', name: '機器人管理' },
      { code: 'maps', name: '地圖管理' },
      { code: 'users', name: '使用者管理' },
      { code: 'roles', name: '角色管理' },
      { code: 'oplog', name: '操作日誌' },
      { code: 'logs', name: '日誌管理' },
      { code: 'versions', name: '版本管理' },
      { code: 'help', name: '幫助中心' },
    ],
  },
  {
    name: '操作',
    children: [
      { code: 'op.remote', name: '遙控與雲台' },
      { code: 'op.estop', name: '急停' },
      { code: 'op.dispatch', name: '派工' },
      { code: 'op.approve', name: '審核派工' },
      { code: 'op.alarm', name: '處理告警' },
      { code: 'op.config', name: '修改設定' },
      { code: 'op.media', name: '刪除抓拍與錄影' },
    ],
  },
] as const;

export type PermCode = (typeof PERM_TREE)[number]['children'][number]['code'];

export const ALL_PERMS: readonly PermCode[] = PERM_TREE.flatMap((g) => g.children.map((c) => c.code));

export function isPermCode(s: string): s is PermCode {
  return (ALL_PERMS as readonly string[]).includes(s);
}
