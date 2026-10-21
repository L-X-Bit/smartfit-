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
import Components from 'unplugin-vue-components/vite';
import AutoImport from 'unplugin-auto-import/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import path from 'node:path';

export default defineConfig({
  plugins: [
    vue(),
    /**
     * Element Plus 按需引入（体积优化）
     * ---------------------------------------------------------------------
     * 原来 main.js 里 `app.use(ElementPlus)` 会把全部组件 + 全量 CSS 打进包里（约 1.15MB），
     * 对慢网络（免费内网穿透、手机弱网）非常致命。
     * 这两个插件会在编译期扫描模板中用到的 <el-xxx> 与 ElMessage 等 API，
     * 只引入实际用到的组件与对应样式，包体可降到约 1/3，且不会漏（无需手写导入清单）。
     */
    Components({
      resolvers: [ElementPlusResolver({ importStyle: 'css' })],
      dts: false,
    }),
    AutoImport({
      resolvers: [ElementPlusResolver()],
      dts: false,
    }),
  ],
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
     * 允许通过内网穿透域名访问（手机用 4G/任何网络打开演示用）
     * -----------------------------------------------------------------------
     * Vite 默认会校验请求的 Host 头，只接受 localhost / IP / 已配置的域名，
     * 否则返回 403「Blocked request. This host is not allowed.」——
     * 这是防止 DNS 重绑定攻击的安全机制，不是 bug。
     * 因此走隧道（localhost.run / Cloudflare / ngrok 等）时必须显式放行对应域名。
     * 也可用环境变量 VITE_ALLOWED_HOSTS 追加自定义域名（逗号分隔）。
     */
    allowedHosts: [
      '.lhr.life', // localhost.run 免费隧道
      '.trycloudflare.com', // Cloudflare 快速隧道
      '.ngrok-free.app', // ngrok
      '.ngrok.io',
      '.loca.lt', // localtunnel
      '.serveo.net',
      '.cpolar.cn', // cpolar（国内）
      '.natapp.cn',
      ...(process.env.VITE_ALLOWED_HOSTS
        ? process.env.VITE_ALLOWED_HOSTS.split(',').map((s) => s.trim()).filter(Boolean)
        : []),
    ],
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
        /**
         * 手动分包
         * 注意：这里**不要**把 'element-plus' 写进 manualChunks。
         * 对象形式的 manualChunks 会把列出的包当成 chunk 根，
         * 一旦写了 'element-plus' 就会把整个库（含所有组件）强制打进一个 1.15MB 的 chunk，
         * 直接抵消上面的按需引入。只保留图表库与图标库即可。
         */
        manualChunks: {
          echarts: ['echarts/core'],
          icons: ['@element-plus/icons-vue'],
        },
      },
    },
  },
});
