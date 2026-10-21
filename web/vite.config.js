/**
 * Vite 配置
 * ---------------------------------------------------------------------------
 * 关键点：
 *  1. 开发时通过 proxy 把 /api 与 /uploads 转发到后端 3000 端口，避免跨域；
 *  2. 生产构建（npm run build）产物在 web/dist，由后端服务直接托管，实现「同源部署」；
 *  3. manualChunks 把 echarts/element-plus 单独拆包，首屏加载更快（优化点）。
 */
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': path.resolve(process.cwd(), 'src') },
  },
  server: {
    port: 5173,
    open: false,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/uploads': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          echarts: ['echarts'],
          element: ['element-plus', '@element-plus/icons-vue'],
        },
      },
    },
  },
});
