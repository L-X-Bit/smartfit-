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
    // host: '0.0.0.0' 的两个好处：
    //   ① 避免浏览器把 localhost 解析成 IPv6 ::1 却连不上（Windows 上常见坑）；
    //   ② 手机 / 同局域网设备可用 http://本机IP:5173 访问，方便现场演示。
    host: '0.0.0.0',
    port: 5173,
    strictPort: true, // 端口被占用时直接报错，而不是悄悄换端口导致地址对不上
    open: false,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/uploads': { target: 'http://127.0.0.1:3000', changeOrigin: true },
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
