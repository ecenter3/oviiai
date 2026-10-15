/// <reference types="vitest" />
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const contracts = fileURLToPath(new URL('../packages/contracts/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
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
  },
});
