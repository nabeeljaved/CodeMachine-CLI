import * as path from 'node:path';
import { homedir } from 'node:os';

import { spawnProcess } from '../../../../process/spawn.js';
import { buildGeminiExecCommand } from './commands.js';
import { metadata } from '../metadata.js';
import { expandHomeDir } from '../../../../../shared/utils/index.js';
import { createTelemetryCapture } from '../../../../../shared/telemetry/index.js';
import type { ParsedTelemetry } from '../../../core/types.js';
import {
  formatCommand,
  formatResult,
  formatMessage,
  formatStatus,
} from '../../../../../shared/formatters/outputMarkers.js';

export interface RunGeminiOptions {
  prompt: string;
  workingDir: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  onData?: (chunk: string) => void;
  onErrorData?: (chunk: string) => void;
  onTelemetry?: (telemetry: ParsedTelemetry) => void;
  abortSignal?: AbortSignal;
  timeout?: number; // Timeout in milliseconds (default: 1800000ms = 30 minutes)
}

export interface RunGeminiResult {
  stdout: string;
  stderr: string;
}

const ANSI_ESCAPE_SEQUENCE = new RegExp(String.raw`\u001B\[[0-9;?]*[ -/]*[@-~]`, 'g');

/**
 * Formats a Gemini stream-json line for display
 * NOTE: Event structure based on research - needs verification in Phase 3
 */
function formatGeminiStreamJsonLine(line: string): string | null {
  try {
    const json = JSON.parse(line);

    // 1. Session initialization
    if (json.type === 'init') {
      return formatStatus(`Gemini ${json.model || 'model'} initialized`);
    }

    // 2. User/Assistant messages
    if (json.type === 'message') {
      if (json.role === 'assistant' && json.content) {
        return formatMessage(json.content);
      }
      // Skip user echo
      return null;
    }

    // 3. Tool execution started
    if (json.type === 'tool_use') {
      return formatCommand(json.tool_name || 'tool', 'started');
    }

    // 4. Tool execution result
    if (json.type === 'tool_result') {
      const isError = json.status !== 'success';
      const output = json.output?.slice(0, 200) || '(no output)';
      const cmd = formatCommand(json.tool_id || 'tool', isError ? 'error' : 'success');
      return cmd + '\n' + formatResult(output, isError);
    }

    // 5. Streaming content chunks
    if (json.type === 'content') {
      return json.value;
    }

    // 6. Final result with telemetry
    if (json.type === 'result' && json.stats) {
      const { duration_ms, total_tokens, input_tokens, output_tokens, cached_tokens } = json.stats;
      let summary = '⏱️  ';
      if (duration_ms) summary += `Duration: ${duration_ms}ms | `;
      if (total_tokens) {
        summary += `Tokens: ${input_tokens || 0}in/${output_tokens || 0}out`;
        if (cached_tokens) summary += ` (${cached_tokens} cached)`;
      }
      return summary;
    }

    return null;
  } catch {
    // Not JSON or unparseable - return as-is
    return line;
  }
}

export async function runGemini(options: RunGeminiOptions): Promise<RunGeminiResult> {
  const { prompt, workingDir, model, env, onData, onErrorData, onTelemetry, abortSignal, timeout = 1800000 } = options;

  if (!prompt) {
    throw new Error('runGemini requires a prompt.');
  }

  if (!workingDir) {
    throw new Error('runGemini requires a working directory.');
  }

  // Expand platform-specific home directory variables in GEMINI_HOME
  const geminiHome = process.env.GEMINI_HOME
    ? expandHomeDir(process.env.GEMINI_HOME)
    : path.join(homedir(), '.codemachine', 'gemini');

  const mergedEnv = {
    ...process.env,
    ...(env ?? {}),
    GEMINI_HOME: geminiHome,
  };

  const plainLogs = (process.env.CODEMACHINE_PLAIN_LOGS || '').toString() === '1';
  const inheritTTY = false; // Force pipe mode for text normalization

  const normalize = (text: string): string => {
    let result = text;

    // Handle carriage returns that cause line overwrites
    result = result.replace(/^.*\r([^\r\n]*)/gm, '$1');

    if (plainLogs) {
      // Plain mode: strip all ANSI sequences
      result = result.replace(ANSI_ESCAPE_SEQUENCE, '');
    }

    // Clean up line endings
    result = result
      .replace(/\r\n/g, '\n') // Convert CRLF to LF
      .replace(/\r/g, '\n') // Convert remaining CR to LF
      .replace(/\n{3,}/g, '\n\n'); // Collapse excessive newlines

    return result;
  };

  const { command, args, cwd } = buildGeminiExecCommand({ workingDir, prompt, model });

  // Debug logging only when LOG_LEVEL=debug
  if (process.env.LOG_LEVEL === 'debug') {
    console.error(`[DEBUG] Gemini runner - prompt length: ${prompt.length}, lines: ${prompt.split('\n').length}`);
    console.error(`[DEBUG] Gemini runner - args count: ${args.length}`);
    console.error(
      `[DEBUG] Gemini runner - CLI: ${command} ${args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ')} | stdin preview: ${prompt.slice(0, 120)}`,
    );
  }

  // Create telemetry capture instance
  const telemetryCapture = createTelemetryCapture('gemini', model || 'gemini-2.0-flash', prompt, workingDir);

  let result;
  try {
    result = await spawnProcess({
      command,
      args,
      cwd,
      env: mergedEnv,
      stdinInput: prompt, // Pass prompt via stdin
      onStdout: inheritTTY
        ? undefined
        : (chunk) => {
            const out = normalize(chunk);

            // Format and display each JSON line
            const lines = out.trim().split('\n');
            for (const line of lines) {
              if (!line.trim()) continue;

              // Capture telemetry data
              telemetryCapture.captureFromStreamJson(line);

              // Emit telemetry event if captured and callback provided
              if (onTelemetry) {
                const captured = telemetryCapture.getCaptured();
                if (captured && captured.tokens) {
                  const totalIn = (captured.tokens.input ?? 0) + (captured.tokens.cached ?? 0);
                  onTelemetry({
                    tokensIn: totalIn,
                    tokensOut: captured.tokens.output ?? 0,
                    cached: captured.tokens.cached,
                    cost: captured.cost,
                    duration: captured.duration,
                  });
                }
              }

              const formatted = formatGeminiStreamJsonLine(line);
              if (formatted) {
                onData?.(formatted + '\n');
              }
            }
          },
      onStderr: inheritTTY
        ? undefined
        : (chunk) => {
            const out = normalize(chunk);
            onErrorData?.(out);
          },
      signal: abortSignal,
      stdioMode: inheritTTY ? 'inherit' : 'pipe',
      timeout,
    });
  } catch (error) {
    const err = error as unknown as { code?: string; message?: string };
    const message = err?.message ?? '';
    const notFound =
      err?.code === 'ENOENT' ||
      /not recognized as an internal or external command/i.test(message) ||
      /command not found/i.test(message);
    if (notFound) {
      const full = `${command} ${args.join(' ')}`.trim();
      const install = metadata.installCommand;
      const name = metadata.name;
      console.error(`[ERROR] ${name} CLI not found when executing: ${full}`);
      throw new Error(`'${command}' is not available on this system. Please install ${name} first:\n  ${install}`);
    }
    throw error;
  }

  if (result.exitCode !== 0) {
    const errorOutput = result.stderr.trim() || result.stdout.trim() || 'no error output';
    const lines = errorOutput.split('\n').slice(0, 10);

    console.error('[ERROR] Gemini CLI execution failed', {
      exitCode: result.exitCode,
      error: lines.join('\n'),
      command: `${command} ${args.join(' ')}`,
    });

    throw new Error(`Gemini CLI exited with code ${result.exitCode}`);
  }

  // Log captured telemetry
  telemetryCapture.logCapturedTelemetry(result.exitCode);

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
