import { create } from 'zustand';

/** WebSocket talk.ended：對講被結束（機器人端斷線、系統管理員結束、本人在別的視窗結束）；PR #15 審查第 2、3 點 */
export interface TalkEnded {
  robotId: string;
  code: string;
  reason: 'robot_failed' | 'stopped';
  by?: string;
  /** 與自己相同：本人在別的視窗或裝置結束 */
  byUserId?: string;
  detail?: string;
  at: number;
}

export const useTalkEvents = create<{ ended: TalkEnded | null; setEnded(e: Omit<TalkEnded, 'at'>): void }>((set) => ({
  ended: null,
  setEnded: (e) => set({ ended: { ...e, at: Date.now() } }),
}));
