import { describe, expect, it } from 'vitest';
import { assertJwtSecret, jwtSecretProblems, parseDurationSec } from './config';

describe('parseDurationSec', () => {
  it('解析 .env 的 TTL 格式', () => {
    expect(parseDurationSec('15m')).toBe(900);
    expect(parseDurationSec('7d')).toBe(604800);
    expect(parseDurationSec('30s')).toBe(30);
    expect(parseDurationSec('2h')).toBe(7200);
  });
  it('格式錯誤直接報錯，不默默用預設值', () => {
    expect(() => parseDurationSec('15 minutes')).toThrow();
  });
});

describe('assertJwtSecret', () => {
  const strong = 'k3J9xQ2mV8pL5rT1wZ7nB4cF6hD0sG2aY9eU';

  it('正式環境：預設值拒絕啟動（即使長度夠）', () => {
    expect(jwtSecretProblems('please-generate-a-long-random-string')).toEqual(['仍是預設值']);
    expect(() => assertJwtSecret('please-generate-a-long-random-string', 'production')).toThrow(/預設值/);
  });

  it('正式環境：少於 32 字元拒絕啟動', () => {
    expect(() => assertJwtSecret('short-but-random-9f8e7d', 'production')).toThrow(/至少需 32 字元/);
  });

  it('正式環境：夠長的隨機值可啟動', () => {
    expect(() => assertJwtSecret(strong, 'production')).not.toThrow();
  });

  it('非正式環境：只警告不中止', () => {
    expect(() => assertJwtSecret('change-me', 'development')).not.toThrow();
    expect(() => assertJwtSecret('change-me', undefined)).not.toThrow();
  });
});
