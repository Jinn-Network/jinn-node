import { execa } from 'execa';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mcpProcess: any = null;

export async function loadMcpServer(): Promise<void> {
  if (mcpProcess) {
    try {
      if (!mcpProcess.killed) return;
    } catch {}
  }

  const env = { ...process.env };
  // Use path relative to this module for standalone compatibility
  const serverPath = join(__dirname, '../../server.ts');
  mcpProcess = execa('yarn', ['tsx', serverPath], {
    cwd: process.cwd(),
    stdio: 'pipe',
    env,
  });

  if (mcpProcess.stdout) {
    mcpProcess.stdout.on('data', (chunk: any) => {
      try { process.stderr.write(`[mcp] ${chunk}`); } catch {}
    });
  }
  if (mcpProcess.stderr) {
    mcpProcess.stderr.on('data', (chunk: any) => {
      try { process.stderr.write(`[mcp] ${chunk}`); } catch {}
    });
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));
}

export async function stopMcpServer(): Promise<void> {
  if (mcpProcess) {
    try { mcpProcess.kill('SIGTERM', { forceKillAfterTimeout: 5000 }); } catch {}
    mcpProcess = null;
  }
}

