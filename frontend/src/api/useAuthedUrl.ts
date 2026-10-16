import { useEffect, useState } from 'react';
import { authedObjectUrl } from './client';

/** 後端 /api/v1 的圖片要帶 token：轉成 blob: 網址；其他網址原樣回傳 */
export function useAuthedUrl(url: string | null | undefined): string | null {
  const [out, setOut] = useState<string | null>(() => (url && !url.startsWith('/api/') ? url : null));
  useEffect(() => {
    if (!url) return setOut(null);
    if (!url.startsWith('/api/')) return setOut(url);
    let alive = true;
    setOut(null);
    authedObjectUrl(url).then(
      (u) => alive && setOut(u),
      () => alive && setOut(null),
    );
    return () => {
      alive = false;
    };
  }, [url]);
  return out;
}
