import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

/** 影像相關設定（.env）。開發預設值對應 infra/docker-compose.dev.yml 的 media profile */
export const mediaConfig = () => ({
  /** MediaMTX Control API */
  api: (process.env.MEDIAMTX_API || 'http://localhost:9997').replace(/\/$/, ''),
  /** 後端抓拍、錄影從這裡讀 RTSP */
  rtsp: (process.env.MEDIAMTX_RTSP || 'rtsp://localhost:8554').replace(/\/$/, ''),
  /** 瀏覽器播放（WHEP）的位址：開發直連 8889，正式環境由 Nginx 轉 /media */
  publicUrl: (process.env.MEDIA_PUBLIC_URL || 'http://localhost:8889').replace(/\/$/, ''),
  /** 後端與測試影像源讀寫 MediaMTX 用的內部帳號（MediaMTX 回呼 /internal/media/auth 驗證） */
  internalUser: process.env.MEDIA_INTERNAL_USER || 'rms-internal',
  internalPassword: process.env.MEDIA_INTERNAL_PASSWORD || devInternalPassword(),
  /**
   * 沒有實際影像來源（攝影機沒填 RTSP、機器人還沒有串流位址）時，用 MediaMTX 內建 ffmpeg 產生測試畫面。
   * 開發預設開、正式環境預設關。
   */
  testSource: process.env.MEDIA_TEST_SOURCE ? process.env.MEDIA_TEST_SOURCE === 'true' : process.env.NODE_ENV !== 'production',
});

/** 開發沒設內部密碼時，由 JWT_SECRET 推導一個（不寫死在程式碼裡） */
function devInternalPassword(): string {
  if (process.env.NODE_ENV === 'production') throw new Error('MEDIA_INTERNAL_PASSWORD 未設定');
  return createHash('sha256').update(`media-internal:${process.env.JWT_SECRET ?? ''}`).digest('hex').slice(0, 24);
}

/** ffmpeg 路徑：FFMPEG_PATH ＞ ffmpeg-static 套件 ＞ PATH 上的 ffmpeg（正式映像檔用 apt 裝） */
export function ffmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require('ffmpeg-static') as string | null;
    if (p && existsSync(p)) return p;
  } catch {
    /* 沒裝 ffmpeg-static */
  }
  return 'ffmpeg';
}
