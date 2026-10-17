import { create } from 'zustand';

/** 與後端 MediaView 相同 */
export interface MediaItem {
  id: string;
  kind: 'snapshot' | 'clip';
  source: 'manual' | 'patrol' | 'alarm';
  streamKey: string | null;
  robotId: string | null;
  robotCode: string | null;
  cameraId: string | null;
  cameraCode: string | null;
  cameraName: string | null;
  floorId: string | null;
  alarmId: string | null;
  createdAt: string;
  endedAt: string | null;
  durationS: number | null;
  sizeBytes: number | null;
  contentType: string | null;
  createdByName: string | null;
  url: string;
}

export interface ActiveRecording {
  id: string;
  streamKey: string;
  name: string;
  startedAt: string;
  maxSec: number;
  userId: string;
}

interface MediaState {
  /** 錄影中（WebSocket media.recording） */
  recordings: ActiveRecording[];
  /** 新抓拍或錄影時遞增：頁面據此重新查詢（WebSocket media.new） */
  version: number;
  setRecordings(r: ActiveRecording[]): void;
  bump(): void;
}

export const useMedia = create<MediaState>((set) => ({
  recordings: [],
  version: 0,
  setRecordings: (recordings) => set({ recordings }),
  bump: () => set((s) => ({ version: s.version + 1 })),
}));
