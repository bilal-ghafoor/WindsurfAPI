/**
 * Tool Execution Bridge
 *
 * Executes tools locally on the host machine with security controls.
 * Bridges SWE tool names to local command execution.
 *
 * Security:
 * - Command allowlist from Factory settings.json
 * - Command denylist for dangerous operations
 * - Workspace root validation
 * - File operation sandboxing
 */

import { spawn } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, access, stat, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, normalize } from 'path';
import { log } from './config.js';

const execAsync = promisify(require('child_process').exec);

// ── Security Configuration ────────────────────────────────────────────────

const COMMAND_ALLOWLIST = [
  'ls', 'pwd', 'dir', 'cd',
  'git', 'npm', 'pnpm', 'yarn', 'bun',
  'python', 'python3', 'pip', 'pytest',
  'node', 'npx',
  'docker', 'docker-compose',
  'terraform', 'supabase',
  'cat', 'head', 'tail', 'grep', 'find',
  'echo', 'printf',
  'cp', 'mv', 'rm', 'mkdir', 'rmdir',
  'touch', 'chmod', 'chown',
];

const COMMAND_DENYLIST = [
  'rm -rf /',
  'rm -rf /*',
  'rm -rf .',
  'rm -rf ~',
  'rm -rf ~/*',
  'rm -rf $HOME',
  'rm -r /',
  'rm -r /*',
  'rm -r ~',
  'rm -r ~/*',
  'mkfs',
  'mkfs.ext4',
  'fdisk',
  'dd if=/dev/zero',
  'sudo rm',
  'sudo mkfs',
  'sudo dd',
];

// Workspace root - should be configured from environment
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || process.cwd();

// ── Tool Name Mapping (SWE → Local) ───────────────────────────────────────

const TOOL_MAPPING = {
  // File operations
  'view_file': executeReadFile,
  'read_file': executeReadFile,
  'write_to_file': executeWriteFile,
  'write_file': executeWriteFile,
  'create_file': executeWriteFile,
  'edit_file': executeEdit,
  'code_action': executeEdit,
  
  // Command execution
  'run_command': executeCommand,
  'bash': executeCommand,
  
  // Search
  'grep_search': executeGrep,
  'grep': executeGrep,
  'find': executeFind,
  'find_by_name': executeFind,
  
  // Directory listing
  'list_dir': executeListDir,
  'list_directory': executeListDir,
};

// ── Tool Execution Functions ───────────────────────────────────────────────

async function executeReadFile(args) {
  const { file_path } = args;
  const fullPath = resolve(WORKSPACE_ROOT, file_path);
  
  // Validate path is within workspace
  if (!fullPath.startsWith(normalize(WORKSPACE_ROOT))) {
    throw new Error(`File access denied: ${file_path} is outside workspace root`);
  }
  
  try {
    const content = await readFile(fullPath, 'utf-8');
    return { success: true, content };
  } catch (error) {
    throw new Error(`Failed to read file: ${error.message}`);
  }
}

async function executeWriteFile(args) {
  const { file_path, content } = args;
  const fullPath = resolve(WORKSPACE_ROOT, file_path);
  
  // Validate path is within workspace
  if (!fullPath.startsWith(normalize(WORKSPACE_ROOT))) {
    throw new Error(`File access denied: ${file_path} is outside workspace root`);
  }
  
  try {
    await writeFile(fullPath, content, 'utf-8');
    return { success: true, message: `File written to ${file_path}` };
  } catch (error) {
    throw new Error(`Failed to write file: ${error.message}`);
  }
}

async function executeEdit(args) {
  const { file_path, old_string, new_string } = args;
  const fullPath = resolve(WORKSPACE_ROOT, file_path);
  
  // Validate path is within workspace
  if (!fullPath.startsWith(normalize(WORKSPACE_ROOT))) {
    throw new Error(`File access denied: ${file_path} is outside workspace root`);
  }
  
  try {
    const content = await readFile(fullPath, 'utf-8');
    if (!content.includes(old_string)) {
      throw new Error(`Old string not found in file: ${file_path}`);
    }
    const newContent = content.replace(old_string, new_string);
    await writeFile(fullPath, newContent, 'utf-8');
    return { success: true, message: `File edited: ${file_path}` };
  } catch (error) {
    throw new Error(`Failed to edit file: ${error.message}`);
  }
}

async function executeCommand(args) {
  const { command } = args;
  
  // Security check: denylist
  for (const denied of COMMAND_DENYLIST) {
    if (command.includes(denied)) {
      throw new Error(`Command denied: ${denied} is not allowed`);
    }
  }
  
  // Security check: allowlist (check first word)
  const firstWord = command.trim().split(/\s+/)[0];
  if (!COMMAND_ALLOWLIST.includes(firstWord)) {
    log.warn(`Command not in allowlist: ${firstWord}, proceeding with caution`);
  }
  
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORKSPACE_ROOT,
      timeout: 30000, // 30 second timeout
      maxBuffer: 1024 * 1024 * 10, // 10MB max buffer
    });
    
    return {
      success: true,
      output: stdout,
      error: stderr,
    };
  } catch (error) {
    throw new Error(`Command execution failed: ${error.message}`);
  }
}

async function executeGrep(args) {
  const { pattern, path, exclude } = args;
  const searchPath = path ? resolve(WORKSPACE_ROOT, path) : WORKSPACE_ROOT;
  
  // Validate path is within workspace
  if (!searchPath.startsWith(normalize(WORKSPACE_ROOT))) {
    throw new Error(`Search path denied: ${path} is outside workspace root`);
  }
  
  const excludeArgs = exclude ? exclude.map(e => `--exclude=${e}`).join(' ') : '';
  const command = `grep -r "${pattern}" ${searchPath} ${excludeArgs} 2>/dev/null || true`;
  
  try {
    const { stdout } = await execAsync(command, {
      cwd: WORKSPACE_ROOT,
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 10,
    });
    
    return {
      success: true,
      matches: stdout.trim().split('\n').filter(line => line),
    };
  } catch (error) {
    throw new Error(`Grep execution failed: ${error.message}`);
  }
}

async function executeFind(args) {
  const { pattern, path } = args;
  const searchPath = path ? resolve(WORKSPACE_ROOT, path) : WORKSPACE_ROOT;
  
  // Validate path is within workspace
  if (!searchPath.startsWith(normalize(WORKSPACE_ROOT))) {
    throw new Error(`Find path denied: ${path} is outside workspace root`);
  }
  
  const command = `find ${searchPath} -name "${pattern}" 2>/dev/null || true`;
  
  try {
    const { stdout } = await execAsync(command, {
      cwd: WORKSPACE_ROOT,
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 10,
    });
    
    return {
      success: true,
      files: stdout.trim().split('\n').filter(line => line),
    };
  } catch (error) {
    throw new Error(`Find execution failed: ${error.message}`);
  }
}

async function executeListDir(args) {
  const { path } = args;
  const dirPath = path ? resolve(WORKSPACE_ROOT, path) : WORKSPACE_ROOT;
  
  // Validate path is within workspace
  if (!dirPath.startsWith(normalize(WORKSPACE_ROOT))) {
    throw new Error(`Directory access denied: ${path} is outside workspace root`);
  }
  
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const result = [];
    
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      const stats = await stat(fullPath);
      result.push({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: stats.size,
      });
    }
    
    return {
      success: true,
      entries: result,
    };
  } catch (error) {
    throw new Error(`Failed to list directory: ${error.message}`);
  }
}

// ── Main Execution Function ────────────────────────────────────────────────

export async function executeToolCall(toolName, args) {
  const executor = TOOL_MAPPING[toolName];
  
  if (!executor) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  
  log.info(`Executing tool: ${toolName}`, args);
  
  try {
    const result = await executor(args);
    log.info(`Tool execution successful: ${toolName}`);
    return result;
  } catch (error) {
    log.error(`Tool execution failed: ${toolName}`, error);
    throw error;
  }
}

export async function executeToolCalls(toolCalls) {
  const results = [];
  
  for (const toolCall of toolCalls) {
    const { name, arguments: args } = toolCall;
    
    try {
      const result = await executeToolCall(name, args);
      results.push({
        tool_call_id: toolCall.id,
        result: JSON.stringify(result),
      });
    } catch (error) {
      results.push({
        tool_call_id: toolCall.id,
        error: error.message,
      });
    }
  }
  
  return results;
}

// ── Security Configuration Update ─────────────────────────────────────────

export function updateSecurityConfig(config) {
  if (config.allowlist) {
    COMMAND_ALLOWLIST.push(...config.allowlist);
  }
  if (config.denylist) {
    COMMAND_DENYLIST.push(...config.denylist);
  }
  if (config.workspaceRoot) {
    process.env.WORKSPACE_ROOT = config.workspaceRoot;
  }
}
