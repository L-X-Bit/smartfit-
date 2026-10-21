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
    /**
     * 文件监视忽略规则（重要，避免 dev server 无故崩溃）：
     * 某些编辑器/工具写文件时会在同目录生成「.文件名.PID.xxxx.tmpdir/文件名.tmp」这样的原子写临时目录。
     * Vite 的 chokidar 监视器一旦去 watch 这个临时文件，Windows 会返回 EBUSY（文件被占用），
     * 而 chokidar 会把它当成致命错误抛出，导致整个 dev server 直接退出。
     * 实测本机多次因此崩溃（错误形如 `EBUSY: resource busy or locked, watch '...tmpdir\X.vue.tmp'`），
     * 所以这里显式忽略临时目录与构建产物。
     */
    watch: {
      ignored: [
        '**/.*.tmpdir/**',
        '**/*.tmpdir/**',
        '**/*.tmp',
        '**/dist/**',
        '**/.git/**',
      ],
    },
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
