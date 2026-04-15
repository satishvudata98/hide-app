import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  base: './', // important for electron
  build: {
    outDir: 'dist-vue',
    emptyOutDir: true,
  }
})
