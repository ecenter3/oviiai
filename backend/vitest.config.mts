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
    // e2e 每個檔案起一個完整後端（DB、Redis、MQTT、BullMQ），啟動與關閉偶爾超過預設 10 秒
    hookTimeout: 30_000,
    // BullMQ 佇列用測試專用前綴：開著的開發後端不會搶走測試排的工作，測試也不會動到開發用的排程
    // 充電樁佔用的啟動對齊由測試直接呼叫，背景那次會跟測試搶
    env: { BULL_PREFIX: 'rms-test', CHARGE_RECONCILE_ON_START: 'false' },
  },
});
