/**
 * Multi-account authentication pool for Codeium/Windsurf.
 *
 * Features:
 *   - Multiple accounts with round-robin load balancing
 *   - Account health tracking (error count, auto-disable)
 *   - Dynamic add/remove via API
 *   - Token-based registration via api.codeium.com
 */

import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { config, log } from './config.js';

import { join } from 'path';
const ACCOUNTS_FILE = join(process.cwd(), 'accounts.json');

// ─── Account pool ──────────────────────────────────────────

const accounts = [];
let _roundRobinIndex = 0;

function saveAccounts() {
  try {
    const data = accounts.map(a => ({
      id: a.id, email: a.email, apiKey: a.apiKey,
      apiServerUrl: a.apiServerUrl, method: a.method,
      status: a.status, addedAt: a.addedAt,
    }));
    writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    log.error('Failed to save accounts:', e.message);
  }
}

function loadAccounts() {
  try {
    if (!existsSync(ACCOUNTS_FILE)) return;
    const data = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8'));
    for (const a of data) {
      if (accounts.find(x => x.apiKey === a.apiKey)) continue;
      accounts.push({
        id: a.id || randomUUID().slice(0, 8),
        email: a.email, apiKey: a.apiKey,
        apiServerUrl: a.apiServerUrl || '',
        method: a.method || 'api_key',
        status: a.status || 'active',
        lastUsed: 0, errorCount: 0,
        refreshToken: '', expiresAt: 0, refreshTimer: null,
        addedAt: a.addedAt || Date.now(),
      });
    }
    if (data.length > 0) log.info(`Loaded ${data.length} account(s) from disk`);
  } catch (e) {
    log.error('Failed to load accounts:', e.message);
  }
}

async function registerWithCodeium(idToken) {
  const { WindsurfClient } = await import('./client.js');
  const client = new WindsurfClient('', 0, '');
  const result = await client.registerUser(idToken);
  return result; // { apiKey, name, apiServerUrl }
}

// ─── Account management ───────────────────────────────────

/**
 * Add account via API key.
 */
export function addAccountByKey(apiKey, label = '') {
  const existing = accounts.find(a => a.apiKey === apiKey);
  if (existing) return existing;

  const account = {
    id: randomUUID().slice(0, 8),
    email: label || `key-${apiKey.slice(0, 8)}`,
    apiKey,
    apiServerUrl: '',
    method: 'api_key',
    status: 'active',
    lastUsed: 0,
    errorCount: 0,
    refreshToken: '',
    expiresAt: 0,
    refreshTimer: null,
    addedAt: Date.now(),
  };
  accounts.push(account);
  saveAccounts();
  log.info(`Account added: ${account.id} (${account.email}) [api_key]`);
  return account;
}

/**
 * Add account via auth token.
 */
export async function addAccountByToken(token, label = '') {
  const reg = await registerWithCodeium(token);
  const existing = accounts.find(a => a.apiKey === reg.apiKey);
  if (existing) return existing;

  const account = {
    id: randomUUID().slice(0, 8),
    email: label || reg.name || `token-${reg.apiKey.slice(0, 8)}`,
    apiKey: reg.apiKey,
    apiServerUrl: reg.apiServerUrl || '',
    method: 'token',
    status: 'active',
    lastUsed: 0,
    errorCount: 0,
    refreshToken: '',
    expiresAt: 0,
    refreshTimer: null,
    addedAt: Date.now(),
  };
  accounts.push(account);
  saveAccounts();
  log.info(`Account added: ${account.id} (${account.email}) [token] server=${account.apiServerUrl}`);
  return account;
}

/**
 * Add account via email/password is not supported for direct Firebase login.
 * Use token-based auth instead: get a token from windsurf.com/show-auth-token
 */
export async function addAccountByEmail(email, password) {
  throw new Error('Direct email/password login is not supported. Use token-based auth: get token from windsurf.com, then POST /auth/login {"token":"..."}');
}

/**
 * Remove an account by ID.
 */
export function removeAccount(id) {
  const idx = accounts.findIndex(a => a.id === id);
  if (idx === -1) return false;
  const account = accounts[idx];
  accounts.splice(idx, 1);
  saveAccounts();
  log.info(`Account removed: ${id} (${account.email})`);
  return true;
}

// ─── Account selection (round-robin) ───────────────────────

/**
 * Get next available API key via round-robin.
 * Skips accounts with status != 'active'.
 */
export function getApiKey() {
  const active = accounts.filter(a => a.status === 'active');
  if (active.length === 0) return null;

  _roundRobinIndex = _roundRobinIndex % active.length;
  const account = active[_roundRobinIndex];
  _roundRobinIndex = (_roundRobinIndex + 1) % active.length;

  account.lastUsed = Date.now();
  return { apiKey: account.apiKey, apiServerUrl: account.apiServerUrl || '' };
}

/**
 * Report an error for an API key (increment error count, auto-disable).
 */
export function reportError(apiKey) {
  const account = accounts.find(a => a.apiKey === apiKey);
  if (!account) return;
  account.errorCount++;
  if (account.errorCount >= 3) {
    account.status = 'error';
    log.warn(`Account ${account.id} (${account.email}) disabled after ${account.errorCount} errors`);
  }
}

/**
 * Reset error count for an API key (call on success).
 */
export function reportSuccess(apiKey) {
  const account = accounts.find(a => a.apiKey === apiKey);
  if (!account) return;
  if (account.errorCount > 0) {
    account.errorCount = 0;
    account.status = 'active';
  }
}

// ─── Status ────────────────────────────────────────────────

export function isAuthenticated() {
  return accounts.some(a => a.status === 'active');
}

export function getAccountList() {
  return accounts.map(a => ({
    id: a.id,
    email: a.email,
    method: a.method,
    status: a.status,
    errorCount: a.errorCount,
    lastUsed: a.lastUsed ? new Date(a.lastUsed).toISOString() : null,
    addedAt: new Date(a.addedAt).toISOString(),
    keyPrefix: a.apiKey.slice(0, 8) + '...',
  }));
}

export function getAccountCount() {
  return {
    total: accounts.length,
    active: accounts.filter(a => a.status === 'active').length,
    error: accounts.filter(a => a.status === 'error').length,
  };
}

// ─── Incoming request API key validation ───────────────────

export function validateApiKey(key) {
  if (!config.apiKey) return true;
  return key === config.apiKey;
}

// ─── Init from .env ────────────────────────────────────────

export async function initAuth() {
  // Load persisted accounts first
  loadAccounts();

  const promises = [];

  // Load API keys from env (comma-separated)
  if (config.codeiumApiKey) {
    for (const key of config.codeiumApiKey.split(',').map(k => k.trim()).filter(Boolean)) {
      addAccountByKey(key);
    }
  }

  // Load auth tokens from env (comma-separated)
  if (config.codeiumAuthToken) {
    for (const token of config.codeiumAuthToken.split(',').map(t => t.trim()).filter(Boolean)) {
      promises.push(
        addAccountByToken(token).catch(err => log.error(`Token auth failed: ${err.message}`))
      );
    }
  }

  // Note: email/password login removed (Firebase API key not valid for direct login)
  // Use token-based auth instead

  if (promises.length > 0) await Promise.allSettled(promises);

  const counts = getAccountCount();
  if (counts.total > 0) {
    log.info(`Auth pool: ${counts.active} active, ${counts.error} error, ${counts.total} total`);
  } else {
    log.warn('No accounts configured. Add via POST /auth/login');
  }
}
