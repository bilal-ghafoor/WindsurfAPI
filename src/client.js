/**
 * WindsurfClient — talks to the local language server binary via gRPC (HTTP/2).
 *
 * Two flows:
 *   Legacy  → RawGetChatMessage (streaming, for enum-only models)
 *   Cascade → StartCascade → SendUserCascadeMessage → poll (for modelUid models)
 */

import https from 'https';
import { log } from './config.js';
import { grpcFrame, grpcUnary, grpcStream } from './grpc.js';
import {
  buildRawGetChatMessageRequest, parseRawResponse,
  buildInitializePanelStateRequest,
  buildAddTrackedWorkspaceRequest,
  buildUpdateWorkspaceTrustRequest,
  buildStartCascadeRequest, parseStartCascadeResponse,
  buildSendCascadeMessageRequest,
  buildGetTrajectoryRequest, parseTrajectoryStatus,
  buildGetTrajectoryStepsRequest, parseTrajectorySteps,
} from './windsurf.js';

const LS_SERVICE = '/exa.language_server_pb.LanguageServerService';

// ─── WindsurfClient ────────────────────────────────────────

export class WindsurfClient {
  /**
   * @param {string} apiKey - Codeium API key
   * @param {number} port - Language server gRPC port
   * @param {string} csrfToken - CSRF token for auth
   */
  constructor(apiKey, port, csrfToken) {
    this.apiKey = apiKey;
    this.port = port;
    this.csrfToken = csrfToken;
  }

  // ─── Legacy: RawGetChatMessage (streaming) ───────────────

  /**
   * Stream chat via RawGetChatMessage.
   * Used for models without a string UID (enum < 280 generally).
   *
   * @param {Array} messages - OpenAI-format messages
   * @param {number} modelEnum - Model enum value
   * @param {string} [modelName] - Optional model name
   * @param {object} opts - { onChunk, onEnd, onError }
   */
  rawGetChatMessage(messages, modelEnum, modelName, opts = {}) {
    const { onChunk, onEnd, onError } = opts;
    const proto = buildRawGetChatMessageRequest(this.apiKey, messages, modelEnum, modelName);
    const body = grpcFrame(proto);

    log.debug(`RawGetChatMessage: enum=${modelEnum} msgs=${messages.length}`);

    return new Promise((resolve, reject) => {
      const chunks = [];

      grpcStream(this.port, this.csrfToken, `${LS_SERVICE}/RawGetChatMessage`, body, {
        onData: (payload) => {
          try {
            const parsed = parseRawResponse(payload);
            if (parsed.text) {
              // Detect server-side errors returned as text
              const errMatch = /^(permission_denied|failed_precondition|not_found|unauthenticated):/.test(parsed.text.trim());
              if (parsed.isError || errMatch) {
                const err = new Error(parsed.text.trim());
                // Mark model-level errors so they don't count against the account
                err.isModelError = /permission_denied|failed_precondition/.test(parsed.text);
                reject(err);
                return;
              }
              chunks.push(parsed);
              onChunk?.(parsed);
            }
          } catch (e) {
            log.error('RawGetChatMessage parse error:', e.message);
          }
        },
        onEnd: () => {
          onEnd?.(chunks);
          resolve(chunks);
        },
        onError: (err) => {
          onError?.(err);
          reject(err);
        },
      });
    });
  }

  // ─── Cascade flow ────────────────────────────────────────

  /**
   * Chat via Cascade flow (for premium models with string UIDs).
   *
   * 1. StartCascade → cascade_id
   * 2. SendUserCascadeMessage (with model config)
   * 3. Poll GetCascadeTrajectorySteps until IDLE
   *
   * @param {Array} messages
   * @param {number} modelEnum
   * @param {string} modelUid
   * @param {object} opts - { onChunk, onEnd, onError }
   */
  async cascadeChat(messages, modelEnum, modelUid, opts = {}) {
    const { onChunk, onEnd, onError } = opts;

    log.debug(`CascadeChat: uid=${modelUid} enum=${modelEnum} msgs=${messages.length}`);

    try {
      // Step 0: Initialize panel state (workspace tracking skipped — causes LS instability)
      try {
        const initProto = buildInitializePanelStateRequest(this.apiKey);
        await grpcUnary(
          this.port, this.csrfToken, `${LS_SERVICE}/InitializeCascadePanelState`, grpcFrame(initProto), 5000
        );
        log.debug('Panel state initialized');
      } catch (e) {
        log.debug(`InitializeCascadePanelState: ${e.message} (may already be initialized)`);
      }

      // Step 1: Start cascade
      const startProto = buildStartCascadeRequest(this.apiKey);
      const startResp = await grpcUnary(
        this.port, this.csrfToken, `${LS_SERVICE}/StartCascade`, grpcFrame(startProto)
      );
      const cascadeId = parseStartCascadeResponse(startResp);
      if (!cascadeId) throw new Error('StartCascade returned empty cascade_id');
      log.debug(`Cascade started: ${cascadeId}`);

      // Build user text (combine system + user messages for Cascade)
      const systemMsgs = messages.filter(m => m.role === 'system');
      const userMsgs = messages.filter(m => m.role !== 'system' && m.role !== 'assistant');
      const lastUser = userMsgs[userMsgs.length - 1];

      let text = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)) : '';
      if (systemMsgs.length) {
        const sysText = systemMsgs.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
        text = sysText + '\n\n' + text;
      }

      // Step 2: Send message
      const sendProto = buildSendCascadeMessageRequest(this.apiKey, cascadeId, text, modelEnum, modelUid);
      await grpcUnary(
        this.port, this.csrfToken, `${LS_SERVICE}/SendUserCascadeMessage`, grpcFrame(sendProto)
      );

      // Step 3: Poll for response
      const chunks = [];
      let lastYielded = '';
      let idleCount = 0;
      const maxWait = 120_000;
      const pollInterval = 300;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWait) {
        await new Promise(r => setTimeout(r, pollInterval));

        // Get steps
        const stepsProto = buildGetTrajectoryStepsRequest(cascadeId, 0);
        const stepsResp = await grpcUnary(
          this.port, this.csrfToken, `${LS_SERVICE}/GetCascadeTrajectorySteps`, grpcFrame(stepsProto)
        );
        const steps = parseTrajectorySteps(stepsResp);

        // Find planner response steps (type=15)
        for (const step of steps) {
          if (step.type === 15 && step.text && step.text.length > lastYielded.length) {
            const delta = step.text.slice(lastYielded.length);
            lastYielded = step.text;
            const chunk = { text: delta, thinking: '', isError: false };
            // Check for thinking delta too
            if (step.thinking) chunk.thinking = step.thinking;
            chunks.push(chunk);
            onChunk?.(chunk);
          }
        }

        // Check status
        const statusProto = buildGetTrajectoryRequest(cascadeId);
        const statusResp = await grpcUnary(
          this.port, this.csrfToken, `${LS_SERVICE}/GetCascadeTrajectory`, grpcFrame(statusProto)
        );
        const status = parseTrajectoryStatus(statusResp);

        if (status === 1) { // IDLE
          idleCount++;
          if (idleCount >= 2) {
            // Final sweep
            const finalResp = await grpcUnary(
              this.port, this.csrfToken, `${LS_SERVICE}/GetCascadeTrajectorySteps`, grpcFrame(stepsProto)
            );
            const finalSteps = parseTrajectorySteps(finalResp);
            for (const step of finalSteps) {
              if (step.type === 15 && step.text && step.text.length > lastYielded.length) {
                const delta = step.text.slice(lastYielded.length);
                lastYielded = step.text;
                chunks.push({ text: delta, thinking: '', isError: false });
                onChunk?.({ text: delta, thinking: '', isError: false });
              }
            }
            break;
          }
        } else {
          idleCount = 0;
        }
      }

      onEnd?.(chunks);
      return chunks;

    } catch (err) {
      onError?.(err);
      throw err;
    }
  }

  // ─── Register user (JSON REST, unchanged) ────────────────

  async registerUser(firebaseToken) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ firebase_id_token: firebaseToken });
      const req = https.request({
        hostname: 'api.codeium.com',
        port: 443,
        path: '/register_user/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      }, (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try {
            const json = JSON.parse(raw);
            if (res.statusCode >= 400) {
              reject(new Error(`RegisterUser failed (${res.statusCode}): ${raw}`));
              return;
            }
            if (!json.api_key) {
              reject(new Error(`RegisterUser response missing api_key: ${raw}`));
              return;
            }
            resolve({ apiKey: json.api_key, name: json.name, apiServerUrl: json.api_server_url });
          } catch {
            reject(new Error(`RegisterUser parse error: ${raw}`));
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
}
