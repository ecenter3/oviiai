import { BlockList, isIP } from 'node:net';

/**
 * CIDR 白名單（例 "10.20.0.0/24,127.0.0.1/32,::1/128"）。
 * IPv4 對應的 IPv6 位址（::ffff:10.20.0.5，Node 在雙堆疊時常見）以 IPv4 比對。
 */
export class CidrList {
  private readonly list = new BlockList();
  readonly size: number;

  constructor(spec: string) {
    const items = spec
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const item of items) {
      const [addr, bits] = item.split('/');
      const type = isIP(addr);
      if (!type) throw new Error(`網段格式錯誤：${item}`);
      const prefix = bits === undefined ? (type === 4 ? 32 : 128) : Number(bits);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > (type === 4 ? 32 : 128)) throw new Error(`網段格式錯誤：${item}`);
      this.list.addSubnet(addr, prefix, type === 4 ? 'ipv4' : 'ipv6');
    }
    this.size = items.length;
  }

  has(ip: string | undefined): boolean {
    if (!ip) return false;
    const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
    const addr = v4 ?? ip;
    const type = isIP(addr);
    if (!type) return false;
    return this.list.check(addr, type === 4 ? 'ipv4' : 'ipv6');
  }
}
