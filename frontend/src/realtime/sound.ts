/**
 * 告警提示音（Web Audio，原型 playSound）：一級三聲高音、二級兩聲。
 * 瀏覽器規定要使用者互動後才能出聲：第一次點擊頁面時建立 AudioContext。
 */
let ctx: AudioContext | null = null;

export function unlockAudio(): void {
  const create = () => {
    if (ctx) return;
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      ctx = AC ? new AC() : null;
    } catch {
      ctx = null;
    }
  };
  document.addEventListener('pointerdown', create, { once: true });
  document.addEventListener('keydown', create, { once: true });
}

/** 是否已能出聲（還沒互動過就提示使用者點一下畫面） */
export const audioReady = () => !!ctx && ctx.state !== 'closed';

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
