import { type ChildProcess, spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ffmpegPath, mediaConfig } from './media-config';

/**
 * 從 MediaMTX 讀這一路的 RTSP 位址（內部帳號；只在後端與 MediaMTX 之間）。
 * 主機名稱先在 Node 解析成 IP：靜態編譯的 ffmpeg（ffmpeg-static）自己解析名稱會當掉。
 */
export async function rtspUrl(streamKey: string): Promise<string> {
  const { rtsp, internalUser, internalPassword } = mediaConfig();
  const u = new URL(rtsp);
  if (!isIP(u.hostname.replace(/^\[|\]$/g, ''))) {
    const { address, family } = await lookup(u.hostname, { family: 4 }).catch(() => lookup(u.hostname));
    u.hostname = family === 6 ? `[${address}]` : address;
  }
  u.username = internalUser;
  u.password = internalPassword;
  return `${u.toString().replace(/\/$/, '')}/${streamKey.split('/').map(encodeURIComponent).join('/')}`;
}

/** ffmpeg 錯誤訊息只留最後幾行，並把網址帳密遮掉 */
function tail(stderr: string): string {
  return stderr
    .trim()
    .split('\n')
    .slice(-3)
    .join(' ')
    .replace(/:\/\/[^\s/]*@/g, '://***@')
    .slice(0, 300);
}

/**
 * 抓一張 JPEG（影像與整合 §1：抓拍由後端從 MediaMTX 取畫面）。
 * 有人看才拉流的路徑會先啟動來源，最多等 timeoutMs。
 */
export async function grabFrame(streamKey: string, timeoutMs = 12_000): Promise<Buffer> {
  const url = await rtspUrl(streamKey);
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', url, '-frames:v', '1', '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'];
    const p = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => ((timedOut = true), p.kill('SIGKILL')), timeoutMs);
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`無法執行 ffmpeg：${e.message}`));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (code === 0 && buf.length > 0) resolve(buf);
      else if (timedOut) reject(new Error('影像來源逾時，沒有畫面'));
      else reject(new Error(`抓拍失敗：${tail(err) || (code === null ? 'ffmpeg 異常結束' : `ffmpeg 結束碼 ${code}`)}`));
    });
  });
}

/**
 * 錄影：從 MediaMTX 讀 RTSP，不轉碼直接寫 MP4（影像與整合 §1：手動錄影與告警片段，不做全天候錄影）。
 * stop() 送 q 讓 ffmpeg 正常收尾（寫入索引）；到 maxSec 自己結束。
 */
export class Recorder {
  private readonly proc: ChildProcess;
  private stderr = '';
  readonly done: Promise<{ ok: boolean; error?: string }>;
  readonly startedAt = Date.now();
  endedAt: number | null = null;

  /** url 用 rtspUrl() 取得 */
  constructor(
    url: string,
    readonly file: string,
    maxSec: number,
  ) {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-rtsp_transport',
      'tcp',
      '-i',
      url,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c',
      'copy',
      '-t',
      String(maxSec),
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      '-y',
      file,
    ];
    this.proc = spawn(ffmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc.stderr!.on('data', (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-2000)));
    this.done = new Promise((resolve) => {
      this.proc.on('error', (e) => {
        this.endedAt = Date.now();
        resolve({ ok: false, error: `無法執行 ffmpeg：${e.message}` });
      });
      this.proc.on('close', (code) => {
        this.endedAt = Date.now();
        resolve(code === 0 ? { ok: true } : { ok: false, error: tail(this.stderr) || `ffmpeg 結束碼 ${code}` });
      });
    });
  }

  get running() {
    return this.endedAt === null;
  }

  /** 正常停止；5 秒內沒結束就強制 */
  async stop(): Promise<{ ok: boolean; error?: string }> {
    if (this.running) {
      this.proc.stdin?.write('q');
      this.proc.stdin?.end();
      const t = setTimeout(() => this.proc.kill('SIGKILL'), 5_000);
      const r = await this.done;
      clearTimeout(t);
      return r;
    }
    return this.done;
  }
}
