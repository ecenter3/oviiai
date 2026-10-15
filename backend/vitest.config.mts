import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// esbuild 不支援 emitDecoratorMetadata，Nest 依賴注入需要 swc 轉譯
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: { include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'] },
});
