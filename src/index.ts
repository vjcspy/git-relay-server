import { loadConfig, validateConfig } from './lib/config';
import { createApp } from './server';

function main() {
  // Validate env before anything else
  validateConfig();

  const config = loadConfig();
  const { app } = createApp(config);

  app.listen(config.port, () => {
    console.log(`git-relay-server listening on port ${config.port}`);
    console.log(`Repos directory: ${config.reposDir}`);
  });
}

main();
