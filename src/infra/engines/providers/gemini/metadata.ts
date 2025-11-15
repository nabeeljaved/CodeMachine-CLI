import type { EngineMetadata } from '../../core/base.js';

export const metadata: EngineMetadata = {
  id: 'gemini',
  name: 'Google Gemini',
  description: 'Authenticate with Google Gemini AI',
  cliCommand: 'gemini',
  cliBinary: 'gemini',
  installCommand: 'npm install -g @google/gemini-cli',
  defaultModel: 'gemini-2.0-flash',
  order: 3, // After Codex (1) and Claude (2)
  experimental: false, // Stable, GA product
};
