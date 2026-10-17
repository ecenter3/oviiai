import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';

/** 搖桿半徑（px）：原型 .joy 196px、旋鈕 56px，可移動 68px */
const R = 68;

const KEYS: Record<string, [number, number]> = {
  w: [0, -1],
  arrowup: [0, -1],
  s: [0, 1],
  arrowdown: [0, 1],
  a: [-1, 0],
  arrowleft: [-1, 0],
  d: [1, 0],
  arrowright: [1, 0],
};

/**
 * 虛擬搖桿＋鍵盤 WASD／方向鍵（前端頁面 §2 Joystick）。向量 x 向右、y 向下，長度 ≤ 1。
 * 放開（pointerup、pointercancel、失去捕捉、按鍵全放開、視窗失焦、停用）一律回報 (0, 0)。
 */
export function Joystick({ enabled, onChange }: { enabled: boolean; onChange(x: number, y: number): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState<[number, number]>([0, 0]);
  const drag = useRef(false);
  const keys = useRef(new Set<string>());
  const cb = useRef(onChange);
  cb.current = onChange;

  const emit = (x: number, y: number) => {
    setKnob([x, y]);
    cb.current(x, y);
  };
  const stop = () => {
    drag.current = false;
    keys.current.clear();
    emit(0, 0);
  };

  const fromPointer = (e: React.PointerEvent) => {
    const b = ref.current!.getBoundingClientRect();
    let x = (e.clientX - b.left - b.width / 2) / R;
    let y = (e.clientY - b.top - b.height / 2) / R;
    const m = Math.hypot(x, y);
    if (m > 1) [x, y] = [x / m, y / m];
    emit(x, y);
  };

  // 鍵盤：輸入框裡打字不算
  useEffect(() => {
    if (!enabled) return;
    const fromKeys = () => {
      let x = 0;
      let y = 0;
      for (const k of keys.current) [x, y] = [x + KEYS[k][0], y + KEYS[k][1]];
      const m = Math.hypot(x, y);
      emit(m ? x / m : 0, m ? y / m : 0);
    };
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (!(k in KEYS) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test((e.target as HTMLElement | null)?.tagName ?? '')) return;
      e.preventDefault();
      if (keys.current.has(k)) return;
      keys.current.add(k);
      fromKeys();
    };
    const up = (e: KeyboardEvent) => {
      if (keys.current.delete(e.key.toLowerCase())) fromKeys();
    };
    // 切換視窗、分頁：一定停
    const blur = () => stop();
    const vis = () => document.visibilityState === 'hidden' && stop();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', vis);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [enabled]);

  // 停用（鎖失效、急停、斷線）或卸載：歸零
  useEffect(() => {
    if (!enabled) stop();
    return () => {
      if (drag.current || keys.current.size) cb.current(0, 0);
    };
  }, [enabled]);

  return (
    <div
      ref={ref}
      className={`joy${enabled ? '' : ' off'}`}
      role="application"
      aria-label={t('remote.joy')}
      aria-disabled={!enabled}
      tabIndex={enabled ? 0 : -1}
      onPointerDown={(e) => {
        if (!enabled) return;
        drag.current = true;
        ref.current?.setPointerCapture?.(e.pointerId);
        fromPointer(e);
      }}
      onPointerMove={(e) => drag.current && fromPointer(e)}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={() => drag.current && stop()}
    >
      <span className="ar u">▲</span>
      <span className="ar d">▼</span>
      <span className="ar l">◀</span>
      <span className="ar r">▶</span>
      <div className="knob" data-testid="knob" style={{ transform: `translate(${knob[0] * R}px, ${knob[1] * R}px)` }} />
    </div>
  );
}
