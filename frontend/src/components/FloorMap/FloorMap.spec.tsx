import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FloorMap, type FloorMapHandle } from './FloorMap';

// jsdom 沒有版面：元件以預設 800×600 計算。40×20 公尺 → fit 比例 min(752/40, 552/20) = 18.8 px/m
const W = 40;
const H = 20;
const SCALE = 18.8;
const TX = (800 - W * SCALE) / 2;
const TY = (600 - H * SCALE) / 2;
const screenOf = (x: number, y: number) => ({ clientX: x * SCALE + TX, clientY: (H - y) * SCALE + TY });

const robots = [
  { id: 'r1', code: 'B2-001', x: 10, y: 5, yaw: Math.PI / 2, state: 'patrolling', online: true, battery: 82.4 },
  { id: 'r2', code: 'B2-002', x: 30, y: 15, yaw: 0, state: 'estop', online: true, battery: 40 },
  { id: 'r3', code: 'B2-003', x: 2, y: 2, yaw: 0, state: 'idle', online: false, battery: 10 },
];

afterEach(cleanup);

describe('FloorMap', () => {
  it('畫出機器人、攝影機、充電樁；機器人依狀態上色、顯示電量、朝向', () => {
    render(
      <FloorMap
        widthM={W}
        heightM={H}
        robots={robots}
        cameras={[{ id: 'c1', name: '大門', x: 1, y: 19 }]}
        chargers={[{ id: 'k1', code: 'CHG-1F-1', x: 1, y: 1, occupiedBy: 'B2-003' }]}
      />,
    );
    const r1 = screen.getByRole('button', { name: '機器人 B2-001' });
    expect(r1.getAttribute('class')).toContain('tone-working');
    expect(r1.textContent).toBe('82%');
    expect(r1.querySelector('.fm-heading')?.getAttribute('transform')).toBe('rotate(-90)');
    // 平台 (10,5) → 螢幕 (10×18.8+TX, (20−5)×18.8+TY)
    const s = screenOf(10, 5);
    expect((r1 as unknown as SVGGElement).style.transform).toBe(`translate(${s.clientX}px, ${s.clientY}px)`);

    expect(screen.getByRole('button', { name: '機器人 B2-002' }).getAttribute('class')).toContain('tone-estop');
    expect(screen.getByRole('button', { name: '機器人 B2-003' }).getAttribute('class')).toContain('tone-offline');
    expect(screen.getByRole('button', { name: '攝影機 大門' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '充電站 CHG-1F-1（B2-003 使用中）' })).toBeTruthy();
  });

  it('點機器人呼叫 onRobotClick；選取的機器人有 sel', () => {
    const onRobotClick = vi.fn();
    render(<FloorMap widthM={W} heightM={H} robots={robots} selectedRobotId="r2" onRobotClick={onRobotClick} />);
    fireEvent.click(screen.getByRole('button', { name: '機器人 B2-001' }));
    expect(onRobotClick).toHaveBeenCalledWith('r1');
    expect(screen.getByRole('button', { name: '機器人 B2-002' }).getAttribute('class')).toContain('sel');
  });

  it('取座標模式：點地圖回傳平台座標（公尺，y 向上）', () => {
    const onPick = vi.fn();
    const { container } = render(<FloorMap widthM={W} heightM={H} pickMode onPick={onPick} />);
    const map = container.querySelector('.floormap')!;
    const at = screenOf(12.5, 7.25);
    fireEvent.pointerDown(map, { button: 0, pointerId: 1, ...at });
    fireEvent.pointerUp(map, { button: 0, pointerId: 1, ...at });
    expect(onPick).toHaveBeenCalledWith({ x: 12.5, y: 7.25 });
  });

  it('拖曳是平移，不算取座標；點在機器人上也不算', () => {
    const onPick = vi.fn();
    const { container } = render(<FloorMap widthM={W} heightM={H} robots={robots} pickMode onPick={onPick} />);
    const map = container.querySelector('.floormap')!;
    fireEvent.pointerDown(map, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(map, { pointerId: 1, clientX: 160, clientY: 130 });
    fireEvent.pointerUp(map, { button: 0, pointerId: 1, clientX: 160, clientY: 130 });
    expect(onPick).not.toHaveBeenCalled();

    const robot = screen.getByRole('button', { name: '機器人 B2-001' });
    fireEvent.pointerDown(robot, { button: 0, pointerId: 2, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(robot, { button: 0, pointerId: 2, clientX: 300, clientY: 300 });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('放大後機器人位置跟著換算，標記大小不變（畫在螢幕座標）', () => {
    const ref = createRef<FloorMapHandle>();
    render(<FloorMap ref={ref} widthM={W} heightM={H} robots={robots} />);
    const r1 = screen.getByRole('button', { name: '機器人 B2-001' });
    const before = (r1 as unknown as SVGGElement).style.transform;
    act(() => ref.current!.zoomIn());
    const after = (r1 as unknown as SVGGElement).style.transform;
    expect(after).not.toBe(before);
    expect(r1.querySelector('.fm-body')?.getAttribute('width')).toBe('30');
    act(() => ref.current!.fit());
    expect((r1 as unknown as SVGGElement).style.transform).toBe(before);
  });

  it('沒有平面圖時畫公尺格線；有平面圖時用圖', () => {
    const { container, rerender } = render(<FloorMap widthM={W} heightM={H} />);
    expect(container.querySelectorAll('.fm-grid line').length).toBeGreaterThan(10);
    rerender(<FloorMap widthM={W} heightM={H} planUrl="/plan.png" />);
    expect(container.querySelector('image')?.getAttribute('href')).toBe('/plan.png');
    expect(container.querySelector('.fm-grid')).toBeNull();
  });

  it('路徑、區域畫在公尺座標（y 翻轉）', () => {
    const { container } = render(
      <FloorMap
        widthM={W}
        heightM={H}
        paths={[{ id: 'p1', points: [{ x: 0, y: 0 }, { x: 10, y: 5 }] }]}
        zones={[{ id: 'z1', kind: 'forbidden', polygon: [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }] }]}
      />,
    );
    expect(container.querySelector('.fm-path')?.getAttribute('points')).toBe('0,20 10,15');
    expect(container.querySelector('.fm-zone.forbidden')?.getAttribute('points')).toBe('1,19 3,19 3,17');
  });
});

describe('興趣點與編號標記（T-24）', () => {
  const pois = [
    { id: 'p1', name: '大門', x: 3, y: 4, kind: 'poi' as const },
    { id: 'p2', name: '待命區', x: 20, y: 10, kind: 'parking' as const, selected: true },
  ];

  it('畫出興趣點與待命點（P）；點選呼叫 onPoiClick', () => {
    const onPoiClick = vi.fn();
    const { container } = render(<FloorMap widthM={W} heightM={H} pois={pois} onPoiClick={onPoiClick} />);
    expect(container.querySelector('.fm-poi.parking.sel text')?.textContent).toBe('P');
    fireEvent.click(screen.getByRole('button', { name: '大門' }));
    expect(onPoiClick).toHaveBeenCalledWith('p1');
  });

  it('取座標模式點在興趣點上：吸附到興趣點的座標', () => {
    const onPick = vi.fn();
    render(<FloorMap widthM={W} heightM={H} pois={pois} pickMode onPick={onPick} />);
    const el = screen.getByRole('button', { name: '待命區' });
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(el, { button: 0, pointerId: 1, clientX: 5, clientY: 5 });
    expect(onPick).toHaveBeenCalledWith({ x: 20, y: 10 });
  });

  it('編號標記與草稿路徑、區域', () => {
    const { container } = render(
      <FloorMap
        widthM={W}
        heightM={H}
        marks={[{ id: 'm1', x: 1, y: 1, label: '1', tone: 'bad' }]}
        paths={[{ id: 'd', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], tone: 'draft' }]}
        zones={[{ id: 'z', kind: 'forbidden', polygon: [{ x: 0, y: 0 }, { x: 2, y: 0 }], draft: true }]}
      />,
    );
    expect(container.querySelector('.fm-mark.bad text')?.textContent).toBe('1');
    expect(container.querySelector('.fm-path.draft')).toBeTruthy();
    expect(container.querySelector('polyline.fm-zone.draft')).toBeTruthy();
  });
});
