import type { Logger } from '@nestjs/common';

/**
 * 同一個 key 只警告一次。記住的 key 有上限（PR #3 審查第 3 點：亂發的代碼不能讓記憶體無限增長）；
 * 超過上限就清空重來，最壞情況是同一則警告再出現一次。
 */
export class WarnOnce {
  private readonly seen = new Set<string>();

  constructor(
    private readonly log: Pick<Logger, 'warn'>,
    private readonly max = 1000,
  ) {}

  warn(key: string, msg: string): void {
    if (this.seen.has(key)) return;
    if (this.seen.size >= this.max) this.seen.clear();
    this.seen.add(key);
    this.log.warn(msg);
  }
}
