import { query } from '@anthropic-ai/claude-agent-sdk';
import crypto from 'crypto';

/**
 * Run a Claude Code turn via the agent SDK.
 * Emits the same WS-facing messages as the original runClaude:
 * session-created, assistant, result, complete, error (+ raw SDK msgs).
 */
export async function runClaude(command, options, send, { cliPath, activeSessions }) {
  const sessionKey = options.sessionId || crypto.randomUUID();
  const controller = new AbortController();
  activeSessions.set(sessionKey, {
    controller, kind: 'claude', startTime: Date.now(), busy: true, key: sessionKey, sessionId: options.sessionId || null,
  });

  const env = { ...process.env };
  if (options.configDir) env.CLAUDE_CONFIG_DIR = options.configDir;

  const sdkOptions = {
    env,
    pathToClaudeCodeExecutable: cliPath,
    tools: { type: 'preset', preset: 'claude_code' },
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['project', 'user', 'local'],
    model: options.model || 'claude-sonnet-4-5',
    abortSignal: controller.signal,
  };
  if (options.cwd)       sdkOptions.cwd    = options.cwd;
  if (options.sessionId) sdkOptions.resume = options.sessionId;
  if (options.effort)    sdkOptions.effort = options.effort;
  if (options.permissionMode && options.permissionMode !== 'default') {
    sdkOptions.permissionMode = options.permissionMode;
  }
  if (options.allowDangerouslySkipPermissions) {
    sdkOptions.allowDangerouslySkipPermissions = true;
  }
  if (options.allowedTools?.length) sdkOptions.allowedTools = options.allowedTools;

  let capturedSessionId = null;

  try {
    const stream = query({ prompt: command, options: sdkOptions });
    for await (const msg of stream) {
      if (msg.type === 'system' && msg.session_id && !capturedSessionId) {
        capturedSessionId = msg.session_id;
        const ent = activeSessions.get(sessionKey);
        if (ent) { ent.sessionId = capturedSessionId; activeSessions.set(capturedSessionId, ent); }
        send({ type: 'session-created', sessionId: capturedSessionId, agent: 'claude' });
      }
      send(msg);
    }
    send({ type: 'complete', exitCode: 0, sessionId: capturedSessionId || sessionKey, agent: 'claude' });
  } catch (err) {
    if (err.name === 'AbortError') {
      send({ type: 'complete', exitCode: 130, aborted: true, sessionId: capturedSessionId || sessionKey, agent: 'claude' });
    } else {
      send({ type: 'error', message: err.message, agent: 'claude' });
    }
  } finally {
    const ent = activeSessions.get(sessionKey);
    if (ent) ent.busy = false;
    activeSessions.delete(sessionKey);
    if (capturedSessionId) activeSessions.delete(capturedSessionId);
  }
}
