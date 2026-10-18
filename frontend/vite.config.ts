/// <reference types="vitest" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const contracts = fileURLToPath(new URL('../packages/contracts/src/index.ts', import.meta.url));

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [react()],
  // 版本管理頁（T-42）顯示前端版本與建置時間；部署時可用 VERSION 覆蓋
  define: {
    __APP_VERSION__: JSON.stringify(process.env.VERSION || pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  // 權限碼、訊息格式與後端共用：直接引用 contracts 原始碼（ESM），不經過給後端用的 CJS 編譯結果
  resolve: { alias: { '@oviiai/contracts': contracts } },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
});
