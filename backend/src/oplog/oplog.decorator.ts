import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

export const OPLOG = 'oplog:meta';

export interface OpLogMeta {
  action: string;
  /** 操作對象，例 ANBOT-003、user:<id>；result 為處理函式的回傳值（新增時才有 id） */
  target?: (req: Request, result?: unknown) => string | null | undefined;
}

/**
 * 自動寫操作日誌（後端邏輯 §7）：人、時間、IP、動作、對象、參數摘要、成功與否。
 * 例：@OpLog('robot.estop', (req) => req.params.id)
 */
export const OpLog = (action: string, target?: OpLogMeta['target']) =>
  SetMetadata(OPLOG, { action, target } satisfies OpLogMeta);
