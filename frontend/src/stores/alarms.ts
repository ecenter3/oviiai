import { create } from 'zustand';

export type AlarmStatus = 'review' | 'open' | 'handling' | 'reported' | 'closed' | 'false_alarm' | 'info';
export type AlarmCategory = 'system' | 'business';

/** 與後端 AlarmView 相同 */
export interface Alarm {
  id: string;
  code: string;
  type: string;
  name: string;
  category: AlarmCategory;
  level: 1 | 2 | 3;
  floorId: string | null;
  robotId: string | null;
  robotCode: string | null;
  cameraId: string | null;
  x: number | null;
  y: number | null;
  message: string;
  confidence: number | null;
  status: AlarmStatus;
  handlerId: string | null;
  handlerName: string | null;
  repeatCount: number;
  occurredAt: string;
  handledAt: string | null;
  closedAt: string | null;
  snapshotUrl: string | null;
  clipUrl: string | null;
}

/** WebSocket alarm.new */
export interface AlarmNew {
  alarm: Alarm;
  notify: { popup: boolean; sound: boolean };
}

/** WebSocket alarm.updated */
export interface AlarmUpdated {
  id: string;
  code: string;
  category: AlarmCategory;
  status: AlarmStatus;
  handler: string | null;
  repeatCount: number;
  handledAt: string | null;
}

/** 還要有人處理 */
export const ACTIVE: AlarmStatus[] = ['review', 'open', 'handling'];
export const STATUSES: AlarmStatus[] = ['open', 'review', 'handling', 'reported', 'closed', 'false_alarm', 'info'];

/** 合法轉換（後端邏輯 §5）。回報上位走 /report：未處理的會先轉處理中 */
export type AlarmAction = 'confirm' | 'false_alarm' | 'handle' | 'report' | 'close';
export const ACTIONS: Record<AlarmStatus, AlarmAction[]> = {
  review: ['confirm', 'false_alarm'],
  open: ['handle', 'report', 'false_alarm'],
  handling: ['close', 'report', 'false_alarm'],
  reported: ['close'],
  closed: [],
  false_alarm: [],
  info: [],
};
export const ACTION_TO: Record<Exclude<AlarmAction, 'report'>, AlarmStatus> = {
  confirm: 'open',
  false_alarm: 'false_alarm',
  handle: 'handling',
  close: 'closed',
};

const KEEP = 20;

interface AlarmsState {
  /** 實時監控「告警日誌（最後 20 條）」 */
  recent: Alarm[];
  /** 等待彈窗的告警（依到達順序，一次顯示一則） */
  popups: Alarm[];
  /** 每次收到告警事件遞增：頁面據此重新查詢 */
  version: number;
  setRecent(list: Alarm[]): void;
  add(m: AlarmNew): void;
  update(u: AlarmUpdated): void;
  dismissPopup(id: string): void;
  clear(): void;
}

export const useAlarms = create<AlarmsState>((set) => ({
  recent: [],
  popups: [],
  version: 0,
  setRecent: (list) => set({ recent: list.slice(0, KEEP) }),
  add: ({ alarm, notify }) =>
    set((s) => ({
      recent: [alarm, ...s.recent.filter((a) => a.id !== alarm.id)].slice(0, KEEP),
      popups: notify.popup && !s.popups.some((a) => a.id === alarm.id) ? [...s.popups, alarm] : s.popups,
      version: s.version + 1,
    })),
  update: (u) =>
    set((s) => {
      const patch = (a: Alarm): Alarm =>
        a.id === u.id ? { ...a, status: u.status, handlerName: u.handler, repeatCount: u.repeatCount, handledAt: u.handledAt } : a;
      return {
        recent: s.recent.map(patch),
        // 有人開始處理（或判定誤報、結案）：彈窗收起；仍是未處理、待複判才留著
        popups: s.popups.filter((a) => a.id !== u.id || u.status === 'open' || u.status === 'review').map(patch),
        version: s.version + 1,
      };
    }),
  dismissPopup: (id) => set((s) => ({ popups: s.popups.filter((a) => a.id !== id) })),
  clear: () => set({ recent: [], popups: [], version: 0 }),
}));
