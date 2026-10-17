import { describe, expect, it } from 'vitest';
import { CidrList } from './cidr';

describe('CIDR 白名單', () => {
  const l = new CidrList('10.20.0.0/24, 127.0.0.1/32,::1/128, 192.168.5.7');
  it('網段內才通過；IPv4 對應的 IPv6 以 IPv4 比對', () => {
    expect(l.has('10.20.0.5')).toBe(true);
    expect(l.has('::ffff:10.20.0.200')).toBe(true);
    expect(l.has('10.20.1.5')).toBe(false);
    expect(l.has('127.0.0.1')).toBe(true);
    expect(l.has('::1')).toBe(true);
    expect(l.has('192.168.5.7')).toBe(true);
    expect(l.has('192.168.5.8')).toBe(false);
    expect(l.has(undefined)).toBe(false);
    expect(l.has('not-an-ip')).toBe(false);
  });
  it('格式錯誤丟例外；空字串是空清單', () => {
    expect(() => new CidrList('10.0.0.0/33')).toThrow();
    expect(() => new CidrList('abc')).toThrow();
    expect(new CidrList('').size).toBe(0);
  });
});
