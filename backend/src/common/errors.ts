import { HttpException } from '@nestjs/common';

/** 介面規格 §1 的錯誤碼 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'TOKEN_EXPIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'ROBOT_BUSY'
  | 'ROBOT_OFFLINE'
  | 'ROBOT_ESTOP'
  | 'TELEOP_LOCKED'
  | 'INVALID_STATE'
  | 'ACCOUNT_LOCKED'
  | 'ROBOT_TIMEOUT'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ROBOT_BUSY: 409,
  ROBOT_OFFLINE: 409,
  ROBOT_ESTOP: 409,
  TELEOP_LOCKED: 409,
  INVALID_STATE: 409,
  ACCOUNT_LOCKED: 423,
  ROBOT_TIMEOUT: 504,
  INTERNAL: 500,
};

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details: Record<string, unknown> };
}

export class AppError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super({ error: { code, message, details } } satisfies ErrorBody, STATUS[code]);
  }
}
