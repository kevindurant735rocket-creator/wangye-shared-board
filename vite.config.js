const { defineConfig } = require("vite");
const path = require("path");

// Vite 现代工程化配置：
// - root 为项目根，index.html 为入口
// - publicDir 保持 public 静态资源透传
// - 代理 /api 到本地 server.js (默认 3000) 便于 dev 时前后端同域
// - 构建输出到 dist，由 server.js 优先托管
module.exports = defineConfig({
  root: __dirname,
  publicDir: path.resolve(__dirname, "public"),
  server: {
    port: 5173,
    strictPort: false,
    host: true,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true
      }
    }
  },
  preview: {
    port: 4173,
    host: true
  },
  build: {
    outDir: "dist",
    assetsDir: "assets",
    emptyOutDir: true,
    cssCodeSplit: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: undefined
      }
    }
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  }
});
