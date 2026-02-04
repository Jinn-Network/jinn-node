import { execa } from 'execa';

let mcpProcess: any = null;

export async function loadMcpServer(): Promise<void> {
  if (mcpProcess) {
    try {
      if (!mcpProcess.killed) return;
    } catch {}
  }

  const env = { ...process.env };
  mcpProcess = execa('yarn', ['tsx', 'jinn-node/src/agent/mcp/server.ts'], {
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

