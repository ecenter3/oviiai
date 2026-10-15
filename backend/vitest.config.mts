import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// esbuild 不支援 emitDecoratorMetadata，Nest 依賴注入需要 swc 轉譯
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    // e2e 共用同一組 PostgreSQL／Redis／EMQX：各檔案都起一個完整後端，平行跑時會互相收到對方的 ack，
    // 由另一個後端推送結果而讓測試等不到。依序執行即可（單一後端實例是架構前提，見技術設計 D6）
    fileParallelism: false,
  },
});
