import { useSyncExternalStore } from 'react';

/**
 * 告警提示音（Web Audio，原型 playSound）：一級三聲高音、二級兩聲。
 * 瀏覽器規定要使用者互動後才能出聲：第一次點擊或按鍵時建立 AudioContext。
 * 還不能出聲時頁首常駐提示（PR #9 審查第 2 點），點一下就啟用。
 */
let ctx: AudioContext | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** 建立（或恢復）AudioContext；要在使用者互動的事件裡呼叫 */
export function enableAudio(): void {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      ctx = AC ? new AC() : null;
      ctx?.addEventListener('statechange', notify);
    }
    if (ctx?.state === 'suspended') void ctx.resume().then(notify, notify);
  } catch {
    ctx = null;
  }
  notify();
}

export function unlockAudio(): void {
  document.addEventListener('pointerdown', enableAudio, { once: true });
  document.addEventListener('keydown', enableAudio, { once: true });
}

/** 是否已能出聲 */
export const audioReady = () => !!ctx && ctx.state === 'running';

/** React：提示音是否已啟用（狀態改變時重繪） */
export function useAudioReady(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    audioReady,
    () => false,
  );
}

export function playAlarm(level: 1 | 2 | 3): void {
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();
  const hi = level === 1;
  const t0 = ctx.currentTime;
  for (const d of hi ? [0, 0.22, 0.44] : [0, 0.22]) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = hi ? 1180 : 880;
    g.gain.setValueAtTime(0.0001, t0 + d);
    g.gain.exponentialRampToValueAtTime(0.12, t0 + d + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.16);
    o.connect(g).connect(ctx.destination);
    o.start(t0 + d);
    o.stop(t0 + d + 0.18);
  }
}
