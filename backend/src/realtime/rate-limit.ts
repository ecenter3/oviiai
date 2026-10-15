/**
 * 權杖桶限流：平均每秒 rate 次，最多連續 burst 次（容許網路抖動造成的短暫擠在一起）。
 * teleop.cmd 正常是 10 Hz；每個連線限制 20 Hz（PR #4 審查第 4 點），超過的直接丟棄，不碰 Redis。
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    now = Date.now(),
  ) {
    this.tokens = burst;
    this.last = now;
  }

  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
