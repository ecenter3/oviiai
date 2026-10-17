import { describe, expect, it, vi } from 'vitest';
import type { AlarmsService } from '../alarms/alarms.service';
import type { Database } from '../db/database.module';
import { mediaConfig } from './media-config';
import type { MediaMtxClient, MtxPathState } from './mediamtx.client';
import { issueShortToken, issueStreamToken } from './stream-token';
import { DOWN_AFTER_MS, StreamsService } from './streams.service';

function make(states: () => MtxPathState[]) {
  const raise = vi.fn(async () => null);
  const mtx = { paths: async () => states() } as unknown as MediaMtxClient;
  const svc = new StreamsService({} as Database, mtx, { raise } as unknown as AlarmsService);
  // 不連資料庫：直接放一筆目錄
  (svc as unknown as { catalog: Map<string, unknown> }).catalog = new Map([
    ['cam/CAM-1', { key: 'cam/CAM-1', kind: 'camera', id: 'c1', code: 'CAM-1', name: '1F 大門', floorId: '1f', source: 'rtsp' }],
  ]);
  return { svc, raise };
}

describe('MediaMTX 播放權限回呼', () => {
  const { svc } = make(() => []);
  it('瀏覽器：帶這一路的有效憑證才能讀；不能發布', () => {
    const { token } = issueStreamToken('cam/CAM-1', 'u1');
    expect(svc.authorize({ action: 'read', path: 'cam/CAM-1', protocol: 'webrtc', query: `token=${token}` })).toBe(true);
    expect(svc.authorize({ action: 'read', path: 'cam/CAM-1', token })).toBe(true);
    expect(svc.authorize({ action: 'read', path: 'cam/CAM-2', query: `token=${token}` })).toBe(false);
    expect(svc.authorize({ action: 'publish', path: 'cam/CAM-1', token })).toBe(false);
    expect(svc.authorize({ action: 'read', path: 'cam/CAM-1' })).toBe(false);
  });
  it('內部帳號（後端抓拍錄影、測試影像源）可讀寫；密碼錯不行', () => {
    const { internalUser, internalPassword } = mediaConfig();
    expect(svc.authorize({ action: 'publish', path: 'cam/CAM-1', user: internalUser, password: internalPassword })).toBe(true);
    expect(svc.authorize({ action: 'read', path: 'cam/CAM-1', user: internalUser, password: 'wrong' })).toBe(false);
    expect(svc.authorize({ action: 'publish', path: 'cam/CAM-1', user: '', password: '' })).toBe(false);
  });
});

describe('對講路徑 talk/{代碼} 的權限（T-31 方案 A）', () => {
  const { svc } = make(() => []);
  const pub = issueStreamToken('talk/B2-001', 'u1', Date.now(), { action: 'publish' }).token;
  const read = issueShortToken('talk/B2-001', 'read', 60);
  it('瀏覽器帶 publish 憑證才能推；播放憑證、別台的憑證都不行', () => {
    expect(svc.authorize({ action: 'publish', path: 'talk/B2-001', protocol: 'webrtc', query: `token=${pub}` })).toBe(true);
    expect(svc.authorize({ action: 'publish', path: 'talk/B2-001', query: `token=${read}` })).toBe(false);
    expect(svc.authorize({ action: 'publish', path: 'talk/B2-002', query: `token=${pub}` })).toBe(false);
  });
  it('轉接器的短憑證：約 33 字（ffmpeg 帳密上限 128 bytes）、過期或換路徑不行', () => {
    expect(read.length).toBeLessThan(40);
    expect(svc.authorize({ action: 'read', path: 'talk/B2-002', user: 'talk', password: read })).toBe(false);
    const old = issueShortToken('talk/B2-001', 'read', 60, Date.now() - 120_000);
    expect(svc.authorize({ action: 'read', path: 'talk/B2-001', user: 'talk', password: old })).toBe(false);
    const forged = read.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect(svc.authorize({ action: 'read', path: 'talk/B2-001', user: 'talk', password: forged })).toBe(false);
  });
  it('轉接器以帳號 talk＋read 憑證拉；拿 publish 憑證或其他帳號不行（不能旁聽）', () => {
    expect(svc.authorize({ action: 'read', path: 'talk/B2-001', protocol: 'rtsp', user: 'talk', password: read })).toBe(true);
    expect(svc.authorize({ action: 'read', path: 'talk/B2-001', user: 'talk', password: pub })).toBe(false);
    expect(svc.authorize({ action: 'read', path: 'talk/B2-001', query: `token=${read}` })).toBe(false);
  });
  it('publish 憑證不能用來播放影像', () => {
    const p = issueStreamToken('cam/CAM-1', 'u1', Date.now(), { action: 'publish' }).token;
    expect(svc.authorize({ action: 'read', path: 'cam/CAM-1', token: p })).toBe(false);
  });
});

describe('影像中斷告警（影像與整合 §1）', () => {
  it('有人要看卻沒有畫面超過 15 秒 → 一次 stream_down；恢復後可再告警', async () => {
    let ready = false;
    const { svc, raise } = make(() => [{ name: 'cam/CAM-1', ready, readers: [], source: null }]);
    const t0 = 1_000_000;
    svc.markWanted('cam/CAM-1', t0);
    await svc.watch(t0);
    await svc.watch(t0 + DOWN_AFTER_MS - 1000);
    expect(raise).not.toHaveBeenCalled();
    svc.markWanted('cam/CAM-1', t0 + DOWN_AFTER_MS); // 播放器每 3 秒重連時會再取憑證
    await svc.watch(t0 + DOWN_AFTER_MS + 100);
    await svc.watch(t0 + DOWN_AFTER_MS + 5000);
    expect(raise).toHaveBeenCalledTimes(1);
    expect(raise.mock.calls[0]).toEqual([expect.objectContaining({ type: 'stream_down', cameraId: 'c1', source: 'stream:cam/CAM-1', floorId: '1f' })]);
    ready = true;
    await svc.watch(t0 + 30_000);
    ready = false;
    svc.markWanted('cam/CAM-1', t0 + 31_000);
    await svc.watch(t0 + 31_000);
    svc.markWanted('cam/CAM-1', t0 + 45_000);
    await svc.watch(t0 + 47_000);
    expect(raise).toHaveBeenCalledTimes(2);
  });

  it('沒人看的路徑沒有畫面（有人看才拉流）不算中斷', async () => {
    const { svc, raise } = make(() => [{ name: 'cam/CAM-1', ready: false, readers: [], source: null }]);
    svc.markWanted('cam/CAM-1', 0);
    await svc.watch(30_000); // 20 秒以上沒人要看
    await svc.watch(60_000);
    expect(raise).not.toHaveBeenCalled();
  });
});
