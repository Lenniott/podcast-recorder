import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const p = Number.parseInt(String(env.DEV_WS_PORT || ''), 10)
  const wsPort = Number.isFinite(p) && p > 0 ? p : 3001

  return {
    plugins: [sveltekit()],
    server: {
      // Proxy WebSocket to dev WS server in dev mode (same port as server-ws-dev.js)
      proxy: {
        '/ws': {
          target: `ws://localhost:${wsPort}`,
          ws: true
        }
      }
    }
  }
})
