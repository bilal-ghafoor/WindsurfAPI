/**
 * Unit tests for tool-executor.js
 */

import { describe, it, expect, beforeEach, afterEach } from 'node:test';
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { executeToolCall, executeToolCalls } from '../src/tool-executor.js';

describe('Tool Executor', () => {
  const testDir = join(process.cwd(), 'test-workspace');
  
  beforeEach(() => {
    // Set up test workspace
    process.env.WORKSPACE_ROOT = testDir;
    mkdirSync(testDir, { recursive: true });
  });
  
  afterEach(() => {
    // Clean up test workspace
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });
  
  describe('executeToolCall', () => {
    it('should execute read_file tool', async () => {
      const testFile = join(testDir, 'test.txt');
      writeFileSync(testFile, 'test content');
      
      const result = await executeToolCall('view_file', { file_path: 'test.txt' });
      
      expect(result.success).toBe(true);
      expect(result.content).toBe('test content');
    });
    
    it('should reject file access outside workspace', async () => {
      await expect(
        executeToolCall('view_file', { file_path: '/etc/passwd' })
      ).rejects.toThrow('outside workspace root');
    });
    
    it('should execute write_file tool', async () => {
      const result = await executeToolCall('write_to_file', {
        file_path: 'new-file.txt',
        content: 'new content'
      });
      
      expect(result.success).toBe(true);
    });
    
    it('should execute list_dir tool', async () => {
      mkdirSync(join(testDir, 'subdir'));
      writeFileSync(join(testDir, 'file.txt'), 'content');
      
      const result = await executeToolCall('list_dir', { path: '.' });
      
      expect(result.success).toBe(true);
      expect(result.entries).toBeInstanceOf(Array);
    });
    
    it('should reject dangerous commands', async () => {
      await expect(
        executeToolCall('run_command', { command: 'rm -rf /' })
      ).rejects.toThrow('Command denied');
    });
    
    it('should allow safe commands', async () => {
      const result = await executeToolCall('run_command', { command: 'ls' });
      
      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });
    
    it('should reject unknown tools', async () => {
      await expect(
        executeToolCall('unknown_tool', {})
      ).rejects.toThrow('Unknown tool');
    });
  });
  
  describe('executeToolCalls', () => {
    it('should execute multiple tool calls', async () => {
      const testFile = join(testDir, 'test.txt');
      writeFileSync(testFile, 'test content');
      
      const toolCalls = [
        { id: '1', name: 'view_file', arguments: { file_path: 'test.txt' } },
        { id: '2', name: 'list_dir', arguments: { path: '.' } }
      ];
      
      const results = await executeToolCalls(toolCalls);
      
      expect(results).toHaveLength(2);
      expect(results[0].tool_call_id).toBe('1');
      expect(results[1].tool_call_id).toBe('2');
    });
    
    it('should handle tool call failures gracefully', async () => {
      const toolCalls = [
        { id: '1', name: 'view_file', arguments: { file_path: '/etc/passwd' } }
      ];
      
      const results = await executeToolCalls(toolCalls);
      
      expect(results).toHaveLength(1);
      expect(results[0].error).toBeDefined();
    });
  });
});
