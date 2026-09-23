import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { sites } from '@openai/sites-vite-plugin';
import hosting from './.openai/hosting.json' with { type: 'json' };

export default defineConfig({
  plugins: [
    sites(),
    cloudflare({
      viteEnvironment: { name: 'server' },
      config: {
        name: 'rijian-shouji-cloud',
        main: './worker/index.js',
        compatibility_date: '2026-05-22',
        r2_buckets: hosting.r2 ? [{ binding: hosting.r2, bucket_name: 'rijian-shouji-archive' }] : [],
        assets: { binding: 'ASSETS' },
      },
    }),
  ],
});
