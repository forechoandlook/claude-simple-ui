#!/usr/bin/env node
import { createApp, init, PORT, hasBusyAgent } from './src/app.js';
import { startAutoUpdate } from './src/auto-update.js';

await init();

const { server } = createApp();

server.listen(PORT, () => {
  console.log(`\n  Claude Simple UI running at http://localhost:${PORT}\n`);
  if (process.env.AUTH_USERNAME) console.log(`  Auth: env user "${process.env.AUTH_USERNAME}"`);
  console.log();
});

// Optional self-update (same as edge). AUTO_UPDATE=0 to disable.
startAutoUpdate({ role: 'standalone', isBusy: hasBusyAgent });
