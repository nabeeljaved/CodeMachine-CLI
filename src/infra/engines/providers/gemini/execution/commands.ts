export interface GeminiCommandOptions {
  workingDir: string;
  prompt: string;
  model?: string;
  timeout?: number;
}

export interface GeminiCommand {
  command: string;
  args: string[];
  cwd: string;
}

export function buildGeminiExecCommand(options: GeminiCommandOptions): GeminiCommand {
  const { workingDir, model } = options;

  const args: string[] = [];

  // Add non-interactive mode flag
  // Prompt will be passed via stdin instead of the -p flag to support multi-line prompts
  args.push('-p', '');

  // Add model selection if specified
  if (model) {
    args.push('-m', model);
  }

  // CRITICAL: Always use stream-json output for telemetry capture
  args.push('--output-format', 'stream-json');

  return {
    command: 'gemini',
    args,
    cwd: workingDir,
  };
}
