import { initAuth, isAuthenticated } from './auth.js';
import { startLanguageServer, waitForReady, isLanguageServerRunning, stopLanguageServer } from './langserver.js';
import { startServer } from './server.js';
import { config, log } from './config.js';
import { existsSync } from 'fs';
import { execSync } from 'child_process';

async function main() {
  console.log('\n  Windsurf API - OpenAI-compatible proxy\n');

  // Start language server binary
  const binaryPath = config.lsBinaryPath;
  if (existsSync(binaryPath)) {
    try {
      execSync('mkdir -p /opt/windsurf/data/db', { stdio: 'ignore' });
    } catch {}

    await startLanguageServer({
      binaryPath,
      port: config.lsPort,
      apiServerUrl: config.codeiumApiUrl,
    });

    try {
      await waitForReady(15000);
    } catch (err) {
      log.error(`Language server failed to start: ${err.message}`);
      log.error('Chat completions will not work without the language server.');
    }
  } else {
    log.warn(`Language server binary not found at ${binaryPath}`);
    log.warn('Install it with: download Windsurf Linux tarball and extract language_server_linux_x64');
  }

  // Init auth pool
  await initAuth();

  if (!isAuthenticated()) {
    log.warn('No accounts configured. Add via:');
    log.warn('  POST /auth/login {"token":"..."}');
    log.warn('  POST /auth/login {"api_key":"..."}');
  }

  const server = startServer();

  const shutdown = () => {
    log.info('Shutting down...');
    stopLanguageServer();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
