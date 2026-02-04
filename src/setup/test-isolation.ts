import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { scriptLogger } from '../logging/index.js';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Isolated environment for middleware testing
 */
export interface IsolatedEnvironment {
  tempDir: string;
  middlewareDir: string;
  cleanup(): Promise<void>;
}

/**
 * Resolve the middleware path - checks env var, Poetry, then fallback
 */
async function resolveMiddlewarePath(): Promise<string> {
  // 1. Explicit env override
  if (process.env.OLAS_MIDDLEWARE_PATH) {
    return process.env.OLAS_MIDDLEWARE_PATH;
  }

  // 2. Find Poetry-installed package location
  try {
    const jinnNodeRoot = path.resolve(__dirname, '..', '..');
    const poetryShow = execSync('poetry show olas-operate-middleware --path', {
      cwd: jinnNodeRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    if (poetryShow) {
      scriptLogger.info({ poetryPath: poetryShow }, 'Found middleware via Poetry');
      return poetryShow;
    }
  } catch {
    // Poetry not available or package not installed
  }

  // 3. Fallback to sibling directory (monorepo compatibility)
  const fallbackPath = path.resolve(__dirname, '..', '..', '..', 'olas-operate-middleware');
  scriptLogger.info({ fallbackPath }, 'Using fallback middleware path');
  return fallbackPath;
}

/**
 * Create an isolated middleware environment for testing
 *
 * STRATEGY:
 * - Create a complete copy of the middleware in /tmp (including Poetry .venv symlink)
 * - Python runs from the copy directory (has imports and venv)
 * - .operate is created in the copy directory (Python's Path.cwd())
 * - After test, delete entire copy
 *
 * This achieves TRUE isolation:
 * 1. Production middleware: NEVER touched
 * 2. Production .operate: NEVER touched
 * 3. Tests can run in parallel: Each gets own copy
 * 4. Safe for CI/CD: No production state pollution
 */
export async function createIsolatedMiddlewareEnvironment(): Promise<IsolatedEnvironment> {
  const sourceMiddleware = await resolveMiddlewarePath();
  const tempMiddleware = path.join('/tmp', `jinn-e2e-middleware-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);

  scriptLogger.info({ sourceMiddleware, tempMiddleware }, 'Creating isolated middleware copy for E2E test');

  // Copy entire middleware (source files + Poetry .venv symlink)
  await copyDirectory(sourceMiddleware, tempMiddleware);

  scriptLogger.info('Middleware copied (including Poetry venv)');
  scriptLogger.info('Tests will create .operate in isolated copy');

  return {
    tempDir: tempMiddleware,
    middlewareDir: tempMiddleware, // Use the copy for everything
    async cleanup() {
      scriptLogger.info('Cleaning up isolated middleware copy');
      try {
        await fs.rm(tempMiddleware, { recursive: true, force: true });
        scriptLogger.info('Cleaned up isolated copy');
      } catch (error) {
        scriptLogger.warn({ error }, 'Failed to cleanup isolated middleware');
      }
    }
  };
}

/**
 * Copy a directory recursively
 *
 * For E2E tests, we need to copy the entire middleware including Poetry venv.
 * The venv is typically a symlink to the actual environment in Poetry's cache.
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  const SKIP_DIRS = new Set([
    '.git',
    '.operate',  // Don't copy production .operate
    '__pycache__',
    '.pytest_cache',
    'node_modules',
    // NOTE: We DON'T skip .venv or venv - we need the Poetry environment
  ]);

  await fs.mkdir(dest, { recursive: true });

  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isSymbolicLink()) {
      // Copy symlinks as-is (important for Poetry .venv)
      const linkTarget = await fs.readlink(srcPath);
      await fs.symlink(linkTarget, destPath);
    } else if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}
