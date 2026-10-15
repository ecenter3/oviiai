/**
 * 任務狀態機（工程開發手冊 後端邏輯 §2「任務狀態轉換」）。
 * 只有表上的轉換是合法的；其他一律拒絕（API 回 409 INVALID_STATE）。
 */
export const TASK_STATUSES = [
  'pending_approval',
  'queued',
  'assigned',
  'running',
  'paused',
  'done',
  'cancelled',
  'failed',
  'rejected',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ACTIVE: readonly TaskStatus[] = ['pending_approval', 'queued', 'assigned', 'running', 'paused'];
export const ENDED: readonly TaskStatus[] = ['done', 'cancelled', 'failed', 'rejected'];
/** 佔用機器人的狀態：同一台同時只能有一筆 */
export const OCCUPYING: readonly TaskStatus[] = ['assigned', 'running'];

const T: Record<TaskStatus, readonly TaskStatus[]> = {
  pending_approval: ['queued', 'rejected', 'cancelled'],
  queued: ['assigned', 'cancelled'],
  // assigned → queued：指令送不出去時退回佇列；assigned → failed：機器人拒絕或逾時
  assigned: ['running', 'paused', 'failed', 'queued', 'cancelled'],
  running: ['done', 'failed', 'paused', 'cancelled'],
  paused: ['queued', 'cancelled'],
  done: [],
  cancelled: [],
  failed: [],
  rejected: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return T[from].includes(to);
}

/** 可以從哪些狀態轉到 to（UPDATE … WHERE status IN (…) 用） */
export function sourcesOf(to: TaskStatus): TaskStatus[] {
  return TASK_STATUSES.filter((s) => T[s].includes(to));
}

export interface ApprovalSettings {
  approval: boolean;
  /** YYYY-MM-DD（台北日期）；超過這天審批自動關閉 */
  approvalUntil: string | null;
}

/** 台北日期 YYYY-MM-DD */
export function taipeiDate(now = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(now);
}

/**
 * 新建任務的初始狀態：非 P1，且審批開啟（dispatch.approval 為 true 且今天 ≤ approvalUntil），
 * 且來源不是已核准的排程 → pending_approval；其他 → queued。
 */
export function initialStatus(
  t: { priority: Priority; source: 'manual' | 'schedule' | 'alarm' | 'api' },
  s: ApprovalSettings,
  now = new Date(),
): 'pending_approval' | 'queued' {
  const approvalOn = s.approval && (!s.approvalUntil || taipeiDate(now) <= s.approvalUntil);
  return t.priority !== 'P1' && approvalOn && t.source !== 'schedule' ? 'pending_approval' : 'queued';
}
