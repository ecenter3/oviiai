import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanTmp } from './media.service';

describe('cleanTmp（PR #12 審查第 3 點：啟動時清錄影暫存檔）', () => {
  let dir: string;
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('只刪超過時限的檔案；正在寫的新檔與子目錄保留；目錄不存在回 0', async () => {
    dir = await mkdtemp(join(tmpdir(), 'clean-tmp-'));
    const now = Date.now();
    await writeFile(join(dir, 'old.mp4'), 'x');
    await utimes(join(dir, 'old.mp4'), new Date(now - 2 * 3600_000), new Date(now - 2 * 3600_000));
    await writeFile(join(dir, 'new.mp4'), 'x');
    await mkdir(join(dir, 'sub'));
    await utimes(join(dir, 'sub'), new Date(now - 2 * 3600_000), new Date(now - 2 * 3600_000));
    expect(await cleanTmp(dir, 3600_000, now)).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(['new.mp4', 'sub']);
    expect(await cleanTmp(join(dir, 'nope'), 3600_000)).toBe(0);
  });
});
