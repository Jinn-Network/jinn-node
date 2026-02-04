/**
 * Preflight checks for setup CLI
 *
 * Run these BEFORE creating SimplifiedServiceBootstrap to fail fast
 * with clear instructions if prerequisites are missing.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface PreflightResult {
  success: boolean;
  errors: string[];
  warnings: string[];
  middlewarePath?: string;
}

export interface PreflightOptions {
  middlewarePath?: string;
  autoInstall?: boolean;
}

/**
 * Run all preflight checks before setup begins
 */
export async function runPreflight(options: PreflightOptions = {}): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Check Poetry is installed
  const poetryCheck = await checkPoetryInstalled();
  if (!poetryCheck.installed) {
    errors.push(
      'Poetry not found. Install it:\n' +
      '    curl -sSL https://install.python-poetry.org | python3 -'
    );
    return { success: false, errors, warnings };
  }

  // 2. Check middleware path exists
  const mwPath = options.middlewarePath || resolveMiddlewarePath();
  if (!mwPath || !existsSync(mwPath)) {
    errors.push(
      `Middleware not found at: ${mwPath || '(not resolved)'}\n` +
      '    Expected: ../olas-operate-middleware or set OLAS_MIDDLEWARE_PATH'
    );
    return { success: false, errors, warnings };
  }

  // 3. Check Poetry dependencies installed
  const depsCheck = await checkPoetryDependencies(mwPath);
  if (!depsCheck.installed) {
    if (options.autoInstall) {
      console.log('  Installing Python dependencies...\n');
      const installResult = await runPoetryInstall(mwPath);
      if (!installResult.success) {
        errors.push(`Failed to install dependencies: ${installResult.error}`);
        return { success: false, errors, warnings };
      }
      console.log('');
    } else {
      errors.push(
        'Python dependencies not installed.\n' +
        `    Run: cd ${mwPath} && poetry install\n` +
        '    Or use: yarn setup --auto-install'
      );
      return { success: false, errors, warnings };
    }
  }

  // 4. Verify operate module is importable
  const importCheck = await checkOperateImportable(mwPath);
  if (!importCheck.success) {
    errors.push(
      'Cannot import operate module.\n' +
      `    Error: ${importCheck.error}\n` +
      `    Try: cd ${mwPath} && poetry install`
    );
    return { success: false, errors, warnings };
  }

  return { success: true, errors, warnings, middlewarePath: mwPath };
}

/**
 * Check if Poetry CLI is available
 */
async function checkPoetryInstalled(): Promise<{ installed: boolean; version?: string }> {
  return new Promise((res) => {
    const proc = spawn('poetry', ['--version'], { shell: true });
    let output = '';

    proc.stdout.on('data', (d) => {
      output += d.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        const match = output.match(/Poetry.*?(\d+\.\d+\.\d+)/);
        res({ installed: true, version: match?.[1] });
      } else {
        res({ installed: false });
      }
    });

    proc.on('error', () => {
      res({ installed: false });
    });
  });
}

/**
 * Check if Poetry virtual environment exists for middleware
 */
async function checkPoetryDependencies(middlewarePath: string): Promise<{ installed: boolean }> {
  return new Promise((res) => {
    const proc = spawn('poetry', ['env', 'info', '-p'], {
      cwd: middlewarePath,
      shell: true,
    });

    let venvPath = '';

    proc.stdout.on('data', (d) => {
      venvPath += d.toString().trim();
    });

    proc.on('close', (code) => {
      if (code === 0 && venvPath && existsSync(venvPath)) {
        res({ installed: true });
      } else {
        res({ installed: false });
      }
    });

    proc.on('error', () => {
      res({ installed: false });
    });
  });
}

/**
 * Verify the operate module can be imported
 */
async function checkOperateImportable(middlewarePath: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((res) => {
    const proc = spawn('poetry', ['run', 'python', '-c', 'import operate'], {
      cwd: middlewarePath,
      shell: true,
    });

    let stderr = '';

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        res({ success: true });
      } else {
        res({ success: false, error: stderr.trim() || 'Unknown error' });
      }
    });

    proc.on('error', (err) => {
      res({ success: false, error: err.message });
    });
  });
}

/**
 * Run poetry install in middleware directory
 */
async function runPoetryInstall(middlewarePath: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((res) => {
    const proc = spawn('poetry', ['install'], {
      cwd: middlewarePath,
      shell: true,
      stdio: ['inherit', 'inherit', 'pipe'], // Show progress to user
    });

    let stderr = '';

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        res({ success: true });
      } else {
        res({ success: false, error: stderr || `Exit code ${code}` });
      }
    });

    proc.on('error', (err) => {
      res({ success: false, error: err.message });
    });
  });
}

/**
 * Resolve middleware path using multiple strategies
 */
function resolveMiddlewarePath(): string | null {
  // 1. Environment variable (explicit override)
  if (process.env.OLAS_MIDDLEWARE_PATH) {
    return process.env.OLAS_MIDDLEWARE_PATH;
  }

  // 2. Monorepo sibling (from cwd)
  const sibling = resolve(process.cwd(), '../olas-operate-middleware');
  if (existsSync(sibling)) {
    return sibling;
  }

  // 3. From jinn-node package location
  const fromPackage = resolve(__dirname, '../../../olas-operate-middleware');
  if (existsSync(fromPackage)) {
    return fromPackage;
  }

  // 4. Two levels up from jinn-node (common monorepo structure)
  const twoUp = resolve(__dirname, '../../../../olas-operate-middleware');
  if (existsSync(twoUp)) {
    return twoUp;
  }

  return null;
}
