/** 以檔案開頭位元組判斷格式（不信任副檔名與瀏覽器送來的 Content-Type） */
export interface Sniffed {
  ext: string;
  mime: string;
}

const ascii = (b: Buffer, from: number, to: number) => b.subarray(from, to).toString('latin1');

const IMAGES: (Sniffed & { magic: (b: Buffer) => boolean })[] = [
  { ext: 'png', mime: 'image/png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', mime: 'image/gif', magic: (b) => ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a' },
  { ext: 'webp', mime: 'image/webp', magic: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
];

/** MP3 frame sync：11 個 1、MPEG 版本不是保留值、layer 不是 00（00 是 AAC ADTS） */
const mpegFrame = (b: Buffer) => b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && ((b[1] >> 3) & 3) !== 1 && ((b[1] >> 1) & 3) !== 0;
/** AAC ADTS：12 個 1、layer 00 */
const adts = (b: Buffer) => b[0] === 0xff && (b[1] & 0xf6) === 0xf0;

const AUDIOS: (Sniffed & { magic: (b: Buffer) => boolean })[] = [
  { ext: 'mp3', mime: 'audio/mpeg', magic: (b) => ascii(b, 0, 3) === 'ID3' || mpegFrame(b) },
  { ext: 'wav', mime: 'audio/wav', magic: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE' },
  { ext: 'ogg', mime: 'audio/ogg', magic: (b) => ascii(b, 0, 4) === 'OggS' },
  { ext: 'webm', mime: 'audio/webm', magic: (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
  { ext: 'm4a', mime: 'audio/mp4', magic: (b) => ascii(b, 4, 8) === 'ftyp' },
  { ext: 'aac', mime: 'audio/aac', magic: adts },
];

export function sniffImage(b: Buffer): Sniffed | null {
  const t = IMAGES.find((x) => x.magic(b));
  return t ? { ext: t.ext, mime: t.mime } : null;
}

export function sniffAudio(b: Buffer): Sniffed | null {
  const t = AUDIOS.find((x) => x.magic(b));
  return t ? { ext: t.ext, mime: t.mime } : null;
}
