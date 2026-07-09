#!/usr/bin/env node
import { createApp, init, PORT } from './src/app.js';

await init();

const { server } = createApp();

server.listen(PORT, () => {
  console.log(`\n  Claude Simple UI running at http://localhost:${PORT}\n`);
  if (process.env.AUTH_USERNAME) console.log(`  Auth: env user "${process.env.AUTH_USERNAME}"`);
  console.log();
});
