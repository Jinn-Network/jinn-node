/**
 * Preflight checks for setup CLI
 *
 * Run these BEFORE creating SimplifiedServiceBootstrap to fail fast
 * with clear instructions if prerequisites are missing.
 *
 * The olas-operate-middleware is installed as a Poetry git dependency
 * in jinn-node's pyproject.toml - no separate path needed.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';

export interface PreflightResult {
  success: boolean;
  errors: string[];
  warnings: string[];
}

export interface PreflightOptions {
  autoInstall?: boolean;
  cwd?: string; // Working directory (defaults to process.cwd())
}

/**
 * Run all preflight checks before setup begins
 */
export async function runPreflight(options: PreflightOptions = {}): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cwd = options.cwd || process.cwd();

  // 1. Check Poetry is installed
  const poetryCheck = await checkPoetryInstalled();
  if (!poetryCheck.installed) {
    errors.push(
      'Poetry not found. Install it:\n' +
      '    curl -sSL https://install.python-poetry.org | python3 -'
    );
    return { success: false, errors, warnings };
  }

  // 2. Check pyproject.toml exists
  if (!existsSync(`${cwd}/pyproject.toml`)) {
    errors.push(
      'pyproject.toml not found in current directory.\n' +
      '    Make sure you are in the jinn-node directory.'
    );
    return { success: false, errors, warnings };
  }

  // 3. Check Poetry dependencies installed (venv exists)
  const depsCheck = await checkPoetryDependencies(cwd);
  if (!depsCheck.installed) {
    if (options.autoInstall) {
      console.log('  Installing Python dependencies...\n');
      const installResult = await runPoetryInstall(cwd);
      if (!installResult.success) {
        errors.push(`Failed to install dependencies: ${installResult.error}`);
        return { success: false, errors, warnings };
      }
      console.log('');
    } else {
      errors.push(
        'Python dependencies not installed.\n' +
        '    Run: poetry install\n' +
        '    Or use: yarn setup --auto-install'
      );
      return { success: false, errors, warnings };
    }
  }

  // 4. Verify operate module is importable
  const importCheck = await checkOperateImportable(cwd);
  if (!importCheck.success) {
    // Try auto-install if not already attempted
    if (!depsCheck.installed || options.autoInstall) {
      // Already tried install above, still failing
      errors.push(
        'Cannot import operate module after install.\n' +
        `    Error: ${importCheck.error}\n` +
        '    Try: poetry install --sync'
      );
    } else {
      errors.push(
        'Cannot import operate module.\n' +
        `    Error: ${importCheck.error}\n` +
        '    Try: poetry install'
      );
    }
    return { success: false, errors, warnings };
  }

  return { success: true, errors, warnings };
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
 * Check if Poetry virtual environment exists
 */
async function checkPoetryDependencies(cwd: string): Promise<{ installed: boolean }> {
  return new Promise((res) => {
    const proc = spawn('poetry', ['env', 'info', '-p'], {
      cwd,
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
async function checkOperateImportable(cwd: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((res) => {
    // Use shell command string (not array) to preserve quoting
    const proc = spawn('poetry run python -c "import operate"', [], {
      cwd,
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
 * Run poetry install in directory
 */
async function runPoetryInstall(cwd: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((res) => {
    const proc = spawn('poetry', ['install'], {
      cwd,
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
