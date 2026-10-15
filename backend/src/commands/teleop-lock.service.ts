import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { Subject } from 'rxjs';
import { REDIS } from '../redis/redis.module';

export const TELEOP_TTL_SEC = 30;

export interface TeleopHolder {
  lockId: string;
  userId: string;
  username: string;
}

const key = (code: string) => `teleop:${code}`;
const encode = (h: TeleopHolder) => `${h.lockId}|${h.userId}|${h.username}`;
function decode(v: string | null): TeleopHolder | undefined {
  if (!v) return undefined;
  const [lockId, userId, ...rest] = v.split('|');
  return { lockId, userId, username: rest.join('|') };
}

// 值相同才續期／刪除（避免續到別人剛搶到的鎖）
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * 遙控鎖（後端邏輯 §1）：`teleop:{code}` 存 {lockId, userId}，TTL 30 秒，每次收到 teleop 續期。
 * 同一台同時只有一人；系統管理員可強制接管。
 */
@Injectable()
export class TeleopLock {
  /** 被強制接管或因急停被釋放時通知原持有人 */
  readonly revoked$ = new Subject<{
    code: string;
    robotId: string;
    floor: string;
    previous: TeleopHolder;
    by: string;
    reason: 'takeover' | 'estop';
  }>();

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async holder(code: string): Promise<TeleopHolder | undefined> {
    return decode(await this.redis.get(key(code)));
  }

  async ttlSec(code: string): Promise<number> {
    return Math.max(0, await this.redis.ttl(key(code)));
  }

  /** 搶鎖。成功回傳新持有人；已被別人持有回傳 undefined */
  async tryAcquire(code: string, userId: string, username: string): Promise<TeleopHolder | undefined> {
    const h: TeleopHolder = { lockId: `l_${randomUUID()}`, userId, username };
    const ok = await this.redis.set(key(code), encode(h), 'EX', TELEOP_TTL_SEC, 'NX');
    return ok ? h : undefined;
  }

  /** 強制接管（呼叫端已確認是系統管理員） */
  async takeOver(code: string, userId: string, username: string): Promise<{ holder: TeleopHolder; previous?: TeleopHolder }> {
    const h: TeleopHolder = { lockId: `l_${randomUUID()}`, userId, username };
    const prev = decode(await this.redis.set(key(code), encode(h), 'EX', TELEOP_TTL_SEC, 'GET'));
    return { holder: h, previous: prev };
  }

  /** 持有人與 lockId 都相符才續期；回傳是否仍持有 */
  async renew(code: string, lockId: string, userId: string): Promise<boolean> {
    const cur = await this.holder(code);
    if (!cur || cur.lockId !== lockId || cur.userId !== userId) return false;
    return (await this.redis.eval(RENEW, 1, key(code), encode(cur), String(TELEOP_TTL_SEC * 1000))) === 1;
  }

  /** 不論持有人是誰都釋放（急停時用）；回傳被釋放的持有人 */
  async forceRelease(code: string): Promise<TeleopHolder | undefined> {
    return decode(await this.redis.getdel(key(code)));
  }

  async release(code: string, holder: TeleopHolder): Promise<boolean> {
    return (await this.redis.eval(RELEASE, 1, key(code), encode(holder))) === 1;
  }
}
