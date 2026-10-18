import { Controller, Get, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequirePerm } from '../auth/perm.decorator';
import { KYSELY, type Database } from '../db/database.module';
import { FleetService } from '../fleet/fleet.service';
import { REDIS } from '../redis/redis.module';

const startedAt = new Date();

/** 後端版本：環境變數 VERSION（部署時設，手冊 07 §3）＞ package.json */
function backendVersion(): string {
  if (process.env.VERSION) return process.env.VERSION;
  try {
    return (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version?: string }).version ?? '—';
  } catch {
    return '—';
  }
}

/**
 * 版本管理（T-42，權限 versions）：後端、各轉接器（心跳回報的版本與狀態）、機器人清單。前端版本由前端自己帶（建置時寫入）。
 * 機器人韌體版本要等各家 SDK 提供；韌體上傳、推送（原型的「上傳版本」）目前沒有 SDK 介面，不做。
 */
@Controller('versions')
export class VersionsController {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly fleet: FleetService,
  ) {}

  @Get()
  @RequirePerm('versions')
  async get() {
    const robots = await this.db.selectFrom('robots').select(['id', 'code', 'brand', 'model', 'serial_no', 'adapter', 'enabled']).orderBy('code').execute();
    const names = [...new Set(robots.map((r) => r.adapter))];
    // 也列出有心跳但沒有登記機器人的轉接器
    for await (const keys of this.redis.scanStream({ match: 'adapter:*', count: 200 })) {
      for (const k of keys as string[]) {
        const n = k.slice('adapter:'.length);
        if (!names.includes(n)) names.push(n);
      }
    }
    const adapters = await Promise.all(
      names.sort().map(async (name) => {
        const h = await this.redis.hgetall(`adapter:${name}`);
        let alive: boolean | null = null;
        try {
          alive = h.status ? !!(JSON.parse(h.status) as { alive?: boolean }).alive : null;
        } catch {
          alive = null;
        }
        const mine = robots.filter((r) => r.adapter === name && r.enabled);
        return { name, version: h.version ?? null, alive, lastSeen: h.at ? new Date(Number(h.at)).toISOString() : null, robots: mine.map((r) => r.code) };
      }),
    );
    return {
      backend: { version: backendVersion(), commit: process.env.GIT_SHA ?? null, node: process.version, startedAt: startedAt.toISOString() },
      adapters: adapters.filter((a) => a.robots.length || a.lastSeen),
      robots: robots.map((r) => ({
        id: r.id,
        code: r.code,
        brand: r.brand,
        model: r.model,
        serialNo: r.serial_no,
        adapter: r.adapter,
        enabled: r.enabled,
        online: !!this.fleet.get(r.code)?.online,
      })),
    };
  }
}
