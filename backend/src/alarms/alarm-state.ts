/**
 * 告警狀態（工程開發手冊 後端邏輯 §5），純函式方便測試。
 *
 * review（待人工複判）→ open（確認屬實）／false_alarm
 * open（未處理）→ handling／false_alarm
 * handling（處理中）→ closed／reported／false_alarm
 * reported（已回報上位）→ closed
 * 其他一律 409。closed、false_alarm、info（無需處理）為終態。
 */
export const ALARM_STATUSES = ['review', 'open', 'handling', 'reported', 'closed', 'false_alarm', 'info'] as const;
export type AlarmStatus = (typeof ALARM_STATUSES)[number];

/** 還要有人處理（統計卡「未處理告警」、監控頁快訊） */
export const ACTIVE: readonly AlarmStatus[] = ['review', 'open', 'handling'];

const NEXT: Record<AlarmStatus, readonly AlarmStatus[]> = {
  review: ['open', 'false_alarm'],
  open: ['handling', 'false_alarm'],
  handling: ['closed', 'reported', 'false_alarm'],
  reported: ['closed'],
  closed: [],
  false_alarm: [],
  info: [],
};

export function canTransition(from: AlarmStatus, to: AlarmStatus): boolean {
  return NEXT[from].includes(to);
}

export function nextStatuses(from: AlarmStatus): readonly AlarmStatus[] {
  return NEXT[from];
}

/** 結束狀態：寫 closed_at */
export const isFinal = (s: AlarmStatus) => s === 'closed' || s === 'false_alarm' || s === 'info';

/** 初始狀態：AI 信心度低於門檻 → 待人工複判；需處理 → 未處理；否則只記錄（無需處理） */
export function initialStatus(rule: { need_handle: boolean }, confidence: number | null | undefined, aiConfidence: number): AlarmStatus {
  if (confidence !== null && confidence !== undefined && confidence < aiConfidence) return 'review';
  return rule.need_handle ? 'open' : 'info';
}

/**
 * 去重的來源鍵：呼叫端明確給的 key（例：robot:{id}:fault:{code}、task:{id}、adapter:{name}）＞機器人＞攝影機＞樓層。
 * 明確的 key 優先，同一台的不同故障碼才不會被合併成一筆（PR #9 審查第 1 點）。
 */
export function sourceKey(a: { robotId?: string | null; cameraId?: string | null; source?: string | null; floorId?: string | null }): string {
  if (a.source) return a.source;
  if (a.robotId) return `robot:${a.robotId}`;
  if (a.cameraId) return `camera:${a.cameraId}`;
  return `floor:${a.floorId ?? '-'}`;
}
