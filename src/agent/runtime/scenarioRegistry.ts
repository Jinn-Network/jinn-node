export type EmulatedScenarioContext = {
  prompt: string;
  env: NodeJS.ProcessEnv;
  jobName?: string;
};

export type EmulatedScenarioStep = {
  tool: string;
  args: Record<string, unknown> | ((ctx: EmulatedScenarioContext) => Record<string, unknown>);
  requiresSigningProxy?: boolean;
  requiredEnv?: string[];
};

export type EmulatedScenario = {
  id: string;
  matches: (ctx: EmulatedScenarioContext) => boolean;
  buildSteps: (ctx: EmulatedScenarioContext) => EmulatedScenarioStep[];
};

function normalizeJobName(name: string | undefined): string {
  return (name || '').trim().toLowerCase();
}

const scenarios: EmulatedScenario[] = [
  {
    id: 'e2e-test-job',
    matches: (ctx) => {
      const jobName = normalizeJobName(ctx.jobName);
      const workstreamId = (ctx.env.JINN_CTX_WORKSTREAM_ID || '').toLowerCase();
      // Tenderly gate dispatches currently surface as `job` in runtime context.
      return jobName === 'e2e-test-job' || jobName === 'job' || workstreamId === '0xe2e_test_workstream';
    },
    buildSteps: (ctx) => [
      {
        tool: 'create_artifact',
        requiresSigningProxy: true,
        args: {
          name: 'E2E Emulated Runtime Artifact',
          topic: 'E2E_RUNTIME',
          content: [
            'Transport backend: emulated',
            `requestId=${ctx.env.JINN_CTX_REQUEST_ID || 'unknown'}`,
            `workstreamId=${ctx.env.JINN_CTX_WORKSTREAM_ID || 'unknown'}`,
            'This artifact confirms MCP execution through emulated backend.',
          ].join('\n'),
          mimeType: 'text/plain',
          type: 'E2E_RUNTIME_EMULATION',
          tags: ['e2e', 'emulated-runtime', 'mcp'],
          idempotencyKey: `e2e-emulated-${ctx.env.JINN_CTX_REQUEST_ID || 'unknown'}`,
        },
      },
    ],
  },
];

export function resolveScenario(ctx: EmulatedScenarioContext): EmulatedScenario | null {
  return scenarios.find((scenario) => scenario.matches(ctx)) || null;
}
