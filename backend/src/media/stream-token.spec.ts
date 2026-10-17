import { describe, expect, it } from 'vitest';
import { issueStreamToken, verifyStreamToken } from './stream-token';

describe('播放憑證', () => {
  it('同一路、未過期才有效', () => {
    const now = Date.now();
    const { token } = issueStreamToken('cam/CAM-1F-01', 'u1', now);
    expect(verifyStreamToken(token, 'cam/CAM-1F-01', now + 30_000)).toMatchObject({ u: 'u1' });
    expect(verifyStreamToken(token, 'cam/CAM-1F-02', now)).toBeNull();
    expect(verifyStreamToken(token, 'cam/CAM-1F-01', now + 61_000)).toBeNull();
  });
  it('竄改或格式錯誤無效', () => {
    const { token } = issueStreamToken('cam/A', 'u1');
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ p: 'cam/B', u: 'u1', e: 9e9 })).toString('base64url');
    expect(verifyStreamToken(`${forged}.${sig}`, 'cam/B')).toBeNull();
    expect(verifyStreamToken(`${body}.x${sig.slice(1)}`, 'cam/A')).toBeNull();
    expect(verifyStreamToken('garbage', 'cam/A')).toBeNull();
    expect(verifyStreamToken(undefined, 'cam/A')).toBeNull();
  });
});
