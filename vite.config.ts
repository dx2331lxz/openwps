import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:5174',
        changeOrigin: true,
      },
    },
  },
  build: {
    // 主包含 Mermaid 等重型库，其内部已通过动态 import() 做懒加载；
    // 这里只对稳定的顶层大依赖做拆分，阈值设高以避免 Mermaid 核心 chunk 的误报。
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // 不强行合并 Mermaid（它内部有大量 diagram 子模块，会自动懒加载）
            if (id.includes('prosemirror')) return 'prosemirror'
            if (id.includes('docx') || id.includes('mammoth') || id.includes('jszip')) return 'docx'
            if (id.includes('react') || id.includes('scheduler')) return 'react'
          }
        },
      },
    },
  },
})
