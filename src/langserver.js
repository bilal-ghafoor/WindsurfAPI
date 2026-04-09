/**
 * Language server binary manager.
 * Launches and monitors the Windsurf language_server_linux_x64 binary.
 */

import { spawn, execSync } from 'child_process';
import { randomUUID } from 'crypto';
import http2 from 'http2';
import net from 'net';
import { log } from './config.js';

const DEFAULT_BINARY = '/opt/windsurf/language_server_linux_x64';
const DEFAULT_PORT = 42100;

let _process = null;
let _port = DEFAULT_PORT;
let _csrfToken = '';

/** Check if something is already listening on a port. */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
  });
}

export function getCsrfToken() { return _csrfToken; }
export function getLsPort() { return _port; }

/**
 * Start the language server binary.
 *
 * @param {object} opts
 * @param {string} opts.binaryPath - Path to the binary
 * @param {number} opts.port - gRPC listen port
 * @param {string} opts.apiServerUrl - Remote Codeium API URL
 * @param {string} opts.csrfToken - CSRF token (auto-generated if not provided)
 */
export async function startLanguageServer(opts = {}) {
  if (_process) {
    log.warn('Language server already running');
    return { port: _port, csrfToken: _csrfToken };
  }

  const binary = opts.binaryPath || process.env.LS_BINARY_PATH || DEFAULT_BINARY;
  _port = opts.port || parseInt(process.env.LS_PORT || String(DEFAULT_PORT), 10);
  _csrfToken = opts.csrfToken || process.env.LS_CSRF_TOKEN || 'windsurf-api-csrf-fixed-token';
  const apiServerUrl = opts.apiServerUrl || process.env.CODEIUM_API_URL || 'https://server.self-serve.windsurf.com';

  // Check if language server is already running on this port (from a previous PM2 restart)
  if (await isPortInUse(_port)) {
    log.info(`Language server already running on port ${_port} (reusing existing instance)`);
    return { port: _port, csrfToken: _csrfToken };
  }

  const args = [
    `--api_server_url=${apiServerUrl}`,
    `--server_port=${_port}`,
    `--csrf_token=${_csrfToken}`,
    `--register_user_url=https://api.codeium.com/register_user/`,
    `--codeium_dir=/opt/windsurf/data`,
    `--database_dir=/opt/windsurf/data/db`,
    '--enable_local_search=false',
    '--enable_index_service=false',
    '--enable_lsp=false',
    '--detect_proxy=false',
  ];

  log.info(`Starting language server: ${binary}`);
  log.info(`  port=${_port} csrf=${_csrfToken.slice(0, 8)}...`);
  log.info(`  api_server_url=${apiServerUrl}`);

  _process = spawn(binary, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: '/root' },
  });

  _process.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line.includes('ERROR') || line.includes('error')) {
        log.error(`[LS] ${line}`);
      } else {
        log.debug(`[LS] ${line}`);
      }
    }
  });

  _process.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line) log.debug(`[LS:err] ${line}`);
  });

  _process.on('exit', (code, signal) => {
    log.warn(`Language server exited: code=${code} signal=${signal}`);
    _process = null;
  });

  _process.on('error', (err) => {
    log.error(`Language server spawn error: ${err.message}`);
    _process = null;
  });

  return { port: _port, csrfToken: _csrfToken };
}

/**
 * Stop the language server.
 */
export function stopLanguageServer() {
  if (_process) {
    _process.kill('SIGTERM');
    _process = null;
    log.info('Language server stopped');
  }
}

/**
 * Check if the language server is responsive.
 */
export function isLanguageServerRunning() {
  return _process !== null && !_process.killed;
}

/**
 * Wait for the language server to be ready (accepts gRPC connections).
 */
export async function waitForReady(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const client = http2.connect(`http://localhost:${_port}`);
        const timer = setTimeout(() => {
          client.close();
          reject(new Error('timeout'));
        }, 2000);

        client.on('connect', () => {
          clearTimeout(timer);
          client.close();
          resolve(true);
        });
        client.on('error', (err) => {
          clearTimeout(timer);
          client.close();
          reject(err);
        });
      });
      log.info(`Language server ready on port ${_port}`);
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error(`Language server not ready after ${timeoutMs}ms`);
}
