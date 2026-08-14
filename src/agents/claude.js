import { query } from '@anthropic-ai/claude-agent-sdk';
import crypto from 'crypto';
import { mapAgentEmit, compactToolInput } from '../runtime/protocol.js';
import { waitForApproval, cancelApprovalsForSession } from '../runtime/approvals.js';

/**
 * Run a Claude Code turn via the agent SDK.
 * Emits filtered UI events only (no raw SDK dump) to cut wire traffic.
 * Supports canUseTool → permission_request / approval.respond round-trip.
 */
export async function runClaude(command, options, send, { cliPath, activeSessions }) {
  const sessionKey = options.sessionId || crypto.randomUUID();
  const controller = new AbortController();
  activeSessions.set(sessionKey, {
    controller,
    kind: 'claude',
    startTime: Date.now(),
    busy: true,
    key: sessionKey,
    sessionId: options.sessionId || null,
  });

  const env = { ...process.env };
  if (options.configDir) env.CLAUDE_CONFIG_DIR = options.configDir;

  const permissionMode = options.permissionMode || 'default';
  const autoApprove = permissionMode === 'bypassPermissions'
    || permissionMode === 'acceptEdits'
    || permissionMode === 'auto'
    || options.allowDangerouslySkipPermissions;

  const emit = (raw) => {
    const mapped = mapAgentEmit(raw, { agent: 'claude', compactTools: true });
    if (mapped) send(mapped);
  };

  const sdkOptions = {
    env,
    pathToClaudeCodeExecutable: cliPath,
    tools: { type: 'preset', preset: 'claude_code' },
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['project', 'user', 'local'],
    model: options.model || 'claude-sonnet-4-5',
    abortSignal: controller.signal,
  };
  if (options.cwd) sdkOptions.cwd = options.cwd;
  if (options.sessionId) sdkOptions.resume = options.sessionId;
  if (options.effort) sdkOptions.effort = options.effort;
  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }
  if (options.allowDangerouslySkipPermissions) {
    sdkOptions.allowDangerouslySkipPermissions = true;
  }
  if (options.allowedTools?.length) sdkOptions.allowedTools = options.allowedTools;

  // Interactive permission bridge when not in auto modes
  if (!autoApprove && permissionMode !== 'bypassPermissions') {
    sdkOptions.canUseTool = async (toolName, input, toolOpts) => {
      if (controller.signal.aborted || toolOpts?.signal?.aborted) {
        return { behavior: 'deny', message: 'aborted', interrupt: true };
      }
      const requestId = toolOpts?.toolUseID || crypto.randomUUID();
      const sid = activeSessions.get(sessionKey)?.sessionId || options.sessionId || sessionKey;
      send({
        type: 'permission_request',
        request_id: requestId,
        requestId,
        tool_name: toolName,
        tool_input: compactToolInput(input, 400),
        title: toolOpts?.title || null,
        displayName: toolOpts?.displayName || null,
        description: toolOpts?.description || null,
        sessionId: sid,
        agent: 'claude',
      });
      const decision = await waitForApproval(requestId, sid);
      if (decision.cancelled || decision.timeout || controller.signal.aborted) {
        return { behavior: 'deny', message: decision.timeout ? 'permission timeout' : 'denied', interrupt: !!decision.cancelled };
      }
      if (decision.allow) {
        const result = { behavior: 'allow', updatedInput: input };
        if (decision.always && toolOpts?.suggestions?.length) {
          result.updatedPermissions = toolOpts.suggestions;
        }
        send({ type: 'permission_resolved', requestId, allow: true, agent: 'claude' });
        return result;
      }
      send({ type: 'permission_resolved', requestId, allow: false, agent: 'claude' });
      return { behavior: 'deny', message: 'User denied permission' };
    };
  }

  let capturedSessionId = null;

  try {
    const stream = query({ prompt: command, options: sdkOptions });
    for await (const msg of stream) {
      if (msg.type === 'system' && msg.session_id && !capturedSessionId) {
        capturedSessionId = msg.session_id;
        const ent = activeSessions.get(sessionKey);
        if (ent) {
          ent.sessionId = capturedSessionId;
          activeSessions.set(capturedSessionId, ent);
        }
        send({ type: 'session-created', sessionId: capturedSessionId, agent: 'claude' });
        continue;
      }

      // Map SDK assistant content (text + tool_use)
      if (msg.type === 'assistant' && msg.message?.content) {
        emit({ type: 'assistant', message: msg.message, ts: Date.now() });
        continue;
      }

      if (msg.type === 'result') {
        emit({
          type: 'result',
          is_error: !!msg.is_error,
          usage: msg.usage,
          session_id: msg.session_id || capturedSessionId,
          result: msg.result,
          agent: 'claude',
        });
        continue;
      }

      // Drop stream_event / user / other noise via mapAgentEmit
      emit(msg);
    }
    send({
      type: 'complete',
      exitCode: 0,
      sessionId: capturedSessionId || sessionKey,
      agent: 'claude',
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      cancelApprovalsForSession(capturedSessionId || sessionKey);
      send({
        type: 'complete',
        exitCode: 130,
        aborted: true,
        sessionId: capturedSessionId || sessionKey,
        agent: 'claude',
      });
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
