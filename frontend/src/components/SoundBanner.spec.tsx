import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAudio, useAudioReady } from '../realtime/sound';

function Probe() {
  return <div data-testid="ready">{String(useAudioReady())}</div>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('提示音啟用狀態（PR #9 審查第 2 點）', () => {
  it('還沒互動前為未啟用；enableAudio 後變成已啟用並通知畫面', () => {
    class FakeCtx {
      state = 'running';
      addEventListener() {}
      resume() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal('AudioContext', FakeCtx);
    render(<Probe />);
    expect(screen.getByTestId('ready').textContent).toBe('false');
    act(() => enableAudio());
    expect(screen.getByTestId('ready').textContent).toBe('true');
  });
});

describe('頁首橫幅', () => {
  it('Layout 在提示音未啟用時顯示「提示音尚未啟用，點此啟用」', async () => {
    vi.resetModules();
    const ready = { v: false };
    vi.doMock('../realtime/sound', () => ({
      useAudioReady: () => ready.v,
      enableAudio: vi.fn(() => (ready.v = true)),
      playAlarm: vi.fn(),
      unlockAudio: vi.fn(),
      audioReady: () => ready.v,
    }));
    vi.doMock('../realtime/socket', () => ({ connectRealtime: vi.fn(), disconnectRealtime: vi.fn() }));
    const { Layout } = await import('./Layout');
    const { useAuth } = await import('../stores/auth');
    const { MemoryRouter } = await import('react-router-dom');
    useAuth.setState({ status: 'authed', perms: ['sysalarm'], user: { displayName: '警衛', role: { name: '警衛' } } as never });
    render(
      <MemoryRouter>
        <Layout />
      </MemoryRouter>,
    );
    const b = screen.getByRole('button', { name: /提示音尚未啟用，點此啟用/ });
    fireEvent.click(b);
    const sound = await import('../realtime/sound');
    expect(sound.enableAudio).toHaveBeenCalled();
    vi.doUnmock('../realtime/sound');
    vi.doUnmock('../realtime/socket');
  });
});
