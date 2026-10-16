import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '../api/client';
import { type ChargingFloor, useCharging } from '../stores/charging';

/** 載入充電狀態（GET /charging）；之後由 WebSocket charger.updated 即時更新 */
export function useChargingData() {
  const load = useCharging((s) => s.load);
  const q = useQuery({ queryKey: ['charging'], queryFn: () => api<ChargingFloor[]>('/charging'), retry: false });
  useEffect(() => {
    if (Array.isArray(q.data)) load(q.data);
  }, [q.data, load]);
  return useCharging((s) => s.floors);
}
