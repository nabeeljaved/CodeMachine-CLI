import { stat, rm, writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { execa } from 'execa';

import { expandHomeDir } from '../../../../shared/utils/index.js';
import { metadata } from './metadata.js';

/**
 * Resolves the Gemini home directory
 */
async function resolveGeminiHome(geminiHome?: string): Promise<string> {
  const rawPath = geminiHome ?? process.env.GEMINI_HOME ?? path.join(homedir(), '.codemachine', 'gemini');
  const targetHome = expandHomeDir(rawPath);
  await mkdir(targetHome, { recursive: true });
  return targetHome;
}

/**
 * Check if CLI is installed
 */
async function isCliInstalled(command: string): Promise<boolean> {
  try {
    const result = await execa(command, ['--version'], { timeout: 3000, reject: false });
    if (typeof result.exitCode === 'number' && result.exitCode === 0) return true;
    const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (/not recognized as an internal or external command/i.test(out)) return false;
    if (/command not found/i.test(out)) return false;
    if (/No such file or directory/i.test(out)) return false;
    return false;
  } catch {
    return false;
  }
}

/**
 * Gets the path to the OAuth credentials file
 */
export function getAuthFilePath(geminiHome: string): string {
  return path.join(geminiHome, 'oauth_creds.json');
}

export async function isAuthenticated(): Promise<boolean> {
  const geminiHome = await resolveGeminiHome();
  const authPath = getAuthFilePath(geminiHome);

  try {
    await stat(authPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureAuth(): Promise<boolean> {
  const geminiHome = await resolveGeminiHome();
  const authPath = getAuthFilePath(geminiHome);

  // If already authenticated, nothing to do
  try {
    await stat(authPath);
    return true;
  } catch {
    // Auth file doesn't exist
  }

  if (process.env.CODEMACHINE_SKIP_AUTH === '1') {
    await writeFile(authPath, '{}', { encoding: 'utf8' });
    return true;
  }

  // Check if CLI is installed
  const cliInstalled = await isCliInstalled(metadata.cliBinary);
  if (!cliInstalled) {
    console.error(`\n────────────────────────────────────────────────────────────`);
    console.error(`  ⚠️  ${metadata.name} CLI Not Installed`);
    console.error(`────────────────────────────────────────────────────────────`);
    console.error(`\nThe '${metadata.cliBinary}' command is not available.`);
    console.error(`Please install ${metadata.name} CLI first:\n`);
    console.error(`  ${metadata.installCommand}\n`);
    console.error(`────────────────────────────────────────────────────────────\n`);
    throw new Error(`${metadata.name} CLI is not installed.`);
  }

  // Run interactive authentication (gemini with no args presents menu)
  console.log(`\nRunning Gemini authentication...\n`);
  console.log(`Config directory: ${geminiHome}\n`);

  try {
    await execa('gemini', [], {
      // No args - presents interactive menu
      env: { ...process.env, GEMINI_HOME: geminiHome },
      stdio: 'inherit',
    });
  } catch (error) {
    const err = error as unknown as { code?: string; stderr?: string; message?: string };
    const stderr = err?.stderr ?? '';
    const message = err?.message ?? '';
    const notFound =
      err?.code === 'ENOENT' ||
      /not recognized as an internal or external command/i.test(stderr || message) ||
      /command not found/i.test(stderr || message) ||
      /No such file or directory/i.test(stderr || message);

    if (notFound) {
      console.error(`\n────────────────────────────────────────────────────────────`);
      console.error(`  ⚠️  ${metadata.name} CLI Not Found`);
      console.error(`────────────────────────────────────────────────────────────`);
      console.error(`\n'${metadata.cliBinary}' failed because the CLI is missing.`);
      console.error(`Please install ${metadata.name} CLI before trying again:\n`);
      console.error(`  ${metadata.installCommand}\n`);
      console.error(`────────────────────────────────────────────────────────────\n`);
      throw new Error(`${metadata.name} CLI is not installed.`);
    }

    throw error;
  }

  // Verify credentials were created
  try {
    await stat(authPath);
    return true;
  } catch {
    // OAuth file not created - authentication may have failed
    console.error(`\n────────────────────────────────────────────────────────────`);
    console.error(`  ⚠️  Gemini CLI Authentication Failed`);
    console.error(`────────────────────────────────────────────────────────────`);
    console.error(`\nAuthentication did not complete successfully.`);
    console.error(`Please run 'gemini' again and complete the authentication flow.\n`);
    console.error(`If you prefer API key authentication, you can set:`);
    console.error(`  export GEMINI_API_KEY=<your-api-key>\n`);
    console.error(`Get an API key from: https://aistudio.google.com/apikey\n`);
    console.error(`────────────────────────────────────────────────────────────\n`);

    throw new Error('Authentication incomplete. Please complete the Gemini authentication flow.');
  }
}

export async function clearAuth(): Promise<void> {
  const geminiHome = await resolveGeminiHome();
  const authPath = getAuthFilePath(geminiHome);

  try {
    await rm(authPath, { force: true });
  } catch {
    // Ignore removal errors; treat as cleared
  }
}

export async function nextAuthMenuAction(): Promise<'login' | 'logout'> {
  return (await isAuthenticated()) ? 'logout' : 'login';
}
