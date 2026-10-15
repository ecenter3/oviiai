import { Controller, Get } from '@nestjs/common';

export interface HealthReport {
  status: 'ok' | 'degraded';
  ts: number;
  checks: Record<string, 'ok' | 'down' | 'unknown'>;
}

@Controller('health')
export class HealthController {
  // 之後逐項接上：db、redis、mqtt、s3、mediamtx、各轉接器心跳
  @Get()
  check(): HealthReport {
    return {
      status: 'ok',
      ts: Date.now(),
      checks: { db: 'unknown', redis: 'unknown', mqtt: 'unknown', s3: 'unknown', mediamtx: 'unknown' },
    };
  }
}
