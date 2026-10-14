import { fileURLToPath } from 'node:url'
import config from '../playwright.config.js'

export default {
  ...config,
  testDir: fileURLToPath(new URL('../tests/playwright', import.meta.url)),
  use: {
    ...config.use,
    launchOptions: {
      ...config.use.launchOptions,
      executablePath:
        '/Users/benjamin/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    }
  }
}
