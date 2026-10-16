import { create } from 'zustand';
import { t } from '../i18n';

/** 與後端 ChargingFloorView 相同（GET /charging、WebSocket charger.updated） */
export interface ChargingFloor {
  floor: string;
  chargers: { id: string; code: string; x: number; y: number; occupiedBy: { robotId: string; code: string; status: 'heading' | 'charging' | 'leaving' } | null }[];
  queue: { robotId: string; code: string; battery: number; position: number }[];
  manual: { robotId: string; code: string; since: number; battery: number | null }[];
}

interface ChargingState {
  floors: Record<string, ChargingFloor>;
  load(list: ChargingFloor[]): void;
  update(v: ChargingFloor): void;
}

export const useCharging = create<ChargingState>((set) => ({
  floors: {},
  load: (list) => set((s) => ({ floors: { ...s.floors, ...Object.fromEntries(list.map((v) => [v.floor, v])) } })),
  update: (v) => set((s) => ({ floors: { ...s.floors, [v.floor]: v } })),
}));

export interface ChargeStatus {
  kind: 'queued' | 'heading' | 'charging' | 'leaving' | 'manual';
  text: string;
}

/** 這台機器人目前的充電狀態（沒有在充電流程中回 null） */
export function chargeStatusOf(floors: Record<string, ChargingFloor>, robotId: string): ChargeStatus | null {
  for (const f of Object.values(floors)) {
    if (f.manual.some((m) => m.robotId === robotId)) return { kind: 'manual', text: t('charge.status.manual') };
    const q = f.queue.find((x) => x.robotId === robotId);
    if (q) return { kind: 'queued', text: t('charge.status.queued', { n: q.position }) };
    const c = f.chargers.find((x) => x.occupiedBy?.robotId === robotId);
    if (c) return { kind: c.occupiedBy!.status, text: t(`charge.status.${c.occupiedBy!.status}`, { charger: c.code }) };
  }
  return null;
}
