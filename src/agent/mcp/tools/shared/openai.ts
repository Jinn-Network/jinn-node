import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Ensure environment is loaded even if this module is imported before supabase.ts
function loadEnvOnce() {
  if (process.env.__ENV_LOADED_OPENAI === '1' || process.env.OPENAI_API_KEY) return;
  const candidates: string[] = [];
  // Candidate: current working directory
  candidates.push(path.resolve(process.cwd(), '.env'));
  // Candidates: ascend from this file
  try {
    const thisFile = fileURLToPath(import.meta.url);
    let dir = path.dirname(thisFile);
    for (let i = 0; i < 6; i++) {
      candidates.push(path.resolve(dir, '.env'));
      dir = path.resolve(dir, '..');
    }
  } catch {
    // ignore
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const res = dotenv.config({ path: p });
      if (!res.error) {
        process.env.__ENV_LOADED_OPENAI = '1';
        break;
      }
    }
  }
}

loadEnvOnce();

let sharedClient: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (sharedClient) return sharedClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY must be provided in .env');
  }
  sharedClient = new OpenAI({ apiKey });
  return sharedClient;
}
