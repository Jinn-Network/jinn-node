import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveScenario, type EmulatedScenarioContext, type EmulatedScenarioStep } from './scenarioRegistry.js';
import type { AgentRuntimeBackend, AgentRuntimeExecutionResult } from './types.js';

type McpServerSettings = {
  command: string;
  args?: string[];
  includeTools?: string[];
};

type RuntimeSettings = {
  mcpServers?: Record<string, McpServerSettings>;
  tools?: {
    core?: string[];
  };
};

type McpClient = {
  callTool: (name: string, args: Record<string, unknown>) => Promise<any>;
  close: () => Promise<void>;
};

type EmulatedBackendContext = {
  model: string;
  settingsPath: string;
  agentRoot: string;
  env: NodeJS.ProcessEnv;
  jobName?: string;
  onTelemetryFileCreated?: (path: string) => void;
};

type EmulatedBackendDeps = {
  createMcpClient?: (params: {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  }) => Promise<McpClient>;
};

const SIGNING_PROXY_REQUIRED_TOOLS = new Set([
  'create_artifact',
  'dispatch_new_job',
  'dispatch_existing_job',
  'blog_get_stats',
  'blog_get_top_pages',
  'blog_get_referrers',
  'blog_get_metrics',
  'blog_get_pageviews',
  'blog_get_performance_summary',
]);

const TOOL_REQUIRED_ENV: Record<string, string[]> = {
  get_file_contents: ['GITHUB_TOKEN'],
  blog_get_stats: ['X402_GATEWAY_URL'],
  blog_get_top_pages: ['X402_GATEWAY_URL'],
  blog_get_referrers: ['X402_GATEWAY_URL'],
  blog_get_metrics: ['X402_GATEWAY_URL'],
  blog_get_pageviews: ['X402_GATEWAY_URL'],
  blog_get_performance_summary: ['X402_GATEWAY_URL'],
};

function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function appendTelemetryEvent(filePath: string, attributes: Record<string, unknown>): void {
  appendFileSync(filePath, `${JSON.stringify({ attributes })}\n`, 'utf8');
}

function getTextPayload(result: any): string {
  const textEntry = Array.isArray(result?.content)
    ? result.content.find((entry: any) => typeof entry?.text === 'string')
    : null;
  return typeof textEntry?.text === 'string' ? textEntry.text : '';
}

function parseToolPayload(text: string): any {
  if (!text || text.trim().length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resolveToolArgs(step: EmulatedScenarioStep, ctx: EmulatedScenarioContext): Record<string, unknown> {
  if (typeof step.args === 'function') {
    return step.args(ctx);
  }
  return step.args;
}

function verifyScenarioStepPreflight(step: EmulatedScenarioStep, env: NodeJS.ProcessEnv): void {
  if (step.requiresSigningProxy || SIGNING_PROXY_REQUIRED_TOOLS.has(step.tool)) {
    if (!env.AGENT_SIGNING_PROXY_URL || !env.AGENT_SIGNING_PROXY_TOKEN) {
      throw new Error(`Signing proxy not configured for tool "${step.tool}"`);
    }
  }

  const requiredEnv = new Set<string>([
    ...(step.requiredEnv || []),
    ...(TOOL_REQUIRED_ENV[step.tool] || []),
  ]);
  for (const key of requiredEnv) {
    if (!env[key]) {
      throw new Error(`Missing required env var "${key}" for tool "${step.tool}"`);
    }
  }
}

async function createDefaultMcpClient(params: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}): Promise<McpClient> {
  const transport = new StdioClientTransport({
    command: params.command,
    args: params.args,
    cwd: params.cwd,
    env: params.env,
  });

  const client = new Client(
    { name: 'jinn-emulated-runtime', version: '1.0.0' },
    { capabilities: {} } as any
  );

  await client.connect(transport);

  return {
    callTool: async (name, args) => client.callTool({ name, arguments: args }),
    close: async () => {
      await client.close();
    },
  };
}

export class EmulatedBackend implements AgentRuntimeBackend {
  readonly name = 'emulated' as const;

  private readonly createMcpClient: (params: {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  }) => Promise<McpClient>;

  constructor(
    private readonly context: EmulatedBackendContext,
    deps: EmulatedBackendDeps = {}
  ) {
    this.createMcpClient = deps.createMcpClient || createDefaultMcpClient;
  }

  async run(prompt: string): Promise<AgentRuntimeExecutionResult> {
    const telemetryDir = this.context.env.JINN_TELEMETRY_DIR || tmpdir();
    mkdirSync(telemetryDir, { recursive: true });
    const telemetryFile = join(
      telemetryDir,
      `telemetry-${Date.now()}-${Math.random().toString(36).slice(2, 11)}.json`
    );
    this.context.onTelemetryFileCreated?.(telemetryFile);

    try {
      const promptDir = dirname(this.context.settingsPath);
      mkdirSync(promptDir, { recursive: true });
      writeFileSync(join(promptDir, 'last-prompt.txt'), prompt, 'utf8');
    } catch {
      // Best-effort debug artifact only.
    }

    const settings = JSON.parse(readFileSync(this.context.settingsPath, 'utf8')) as RuntimeSettings;
    const serverName = settings.mcpServers?.metacog
      ? 'metacog'
      : Object.keys(settings.mcpServers || {})[0];
    if (!serverName) {
      return {
        output: '',
        telemetryFile,
        stderr: 'NO_MCP_SERVER: no mcp server configured in generated settings',
        exitCode: 1,
      };
    }

    const server = settings.mcpServers?.[serverName];
    if (!server?.command) {
      return {
        output: '',
        telemetryFile,
        stderr: `MCP_SERVER_INVALID: missing command for server "${serverName}"`,
        exitCode: 1,
      };
    }

    const allowedTools = new Set<string>(server.includeTools || []);
    const scenarioContext: EmulatedScenarioContext = {
      prompt,
      env: this.context.env,
      jobName: this.context.jobName || this.context.env.JINN_CTX_JOB_NAME,
    };
    const scenario = resolveScenario(scenarioContext);
    if (!scenario) {
      return {
        output: '',
        telemetryFile,
        stderr: `NO_EMULATION_SCENARIO: unsupported jobName "${scenarioContext.jobName || 'unknown'}"`,
        exitCode: 1,
      };
    }

    const steps = scenario.buildSteps(scenarioContext);
    if (steps.length === 0) {
      return {
        output: '',
        telemetryFile,
        stderr: `NO_EMULATION_STEPS: scenario "${scenario.id}" has no executable steps`,
        exitCode: 1,
      };
    }

    for (const step of steps) {
      if (allowedTools.size > 0 && !allowedTools.has(step.tool)) {
        return {
          output: '',
          telemetryFile,
          stderr: `TOOL_POLICY_DENIED: tool "${step.tool}" not in includeTools`,
          exitCode: 1,
        };
      }
      try {
        verifyScenarioStepPreflight(step, this.context.env);
      } catch (error) {
        return {
          output: '',
          telemetryFile,
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        };
      }
    }

    const coreTools = settings.tools?.core || [];
    appendTelemetryEvent(telemetryFile, {
      'event.name': 'gemini_cli.config',
      core_tools_enabled: JSON.stringify(coreTools),
      runtime_backend: 'emulated',
    });
    appendTelemetryEvent(telemetryFile, {
      'event.name': 'gemini_cli.user_prompt',
      prompt,
      prompt_length: prompt.length,
    });

    let client: McpClient | null = null;
    const stdoutLines: string[] = [];
    const conversation: Array<Record<string, unknown>> = [];
    let totalTokens = 0;

    try {
      client = await this.createMcpClient({
        command: server.command,
        args: server.args || [],
        cwd: this.context.agentRoot,
        env: sanitizeEnv(this.context.env),
      });

      for (const step of steps) {
        const args = resolveToolArgs(step, scenarioContext);
        const requestText = JSON.stringify(conversation);
        appendTelemetryEvent(telemetryFile, {
          'event.name': 'gemini_cli.api_request',
          model: this.context.model,
          request_text: requestText,
        });

        const start = Date.now();
        try {
          const result = await client.callTool(step.tool, args);
          const durationMs = Date.now() - start;
          const textPayload = getTextPayload(result);
          const parsedPayload = parseToolPayload(textPayload);

          if (result?.isError) {
            throw new Error(`MCP_TRANSPORT_ERROR: ${textPayload || 'tool returned isError=true'}`);
          }

          if (parsedPayload?.meta?.ok === false) {
            throw new Error(
              `BUSINESS_ERROR[${parsedPayload.meta.code || 'UNKNOWN'}]: ${parsedPayload.meta.message || 'tool returned meta.ok=false'}`
            );
          }

          appendTelemetryEvent(telemetryFile, {
            'event.name': 'gemini_cli.tool_call',
            function_name: step.tool,
            function_args: JSON.stringify(args),
            duration_ms: durationMs,
            success: true,
          });

          const outputText = textPayload || JSON.stringify(parsedPayload || result);
          conversation.push({
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: step.tool,
                  response: {
                    output: outputText,
                  },
                },
              },
            ],
          });

          // Keep request_text snapshots compatible with downstream parser logic.
          appendTelemetryEvent(telemetryFile, {
            'event.name': 'gemini_cli.api_request',
            model: this.context.model,
            request_text: JSON.stringify(conversation),
          });

          totalTokens += 32;
          appendTelemetryEvent(telemetryFile, {
            'event.name': 'gemini_cli.api_response',
            response_text: outputText.slice(0, 4000),
            input_token_count: 16,
            output_token_count: 16,
            total_token_count: totalTokens,
            duration_ms: durationMs,
          });

          stdoutLines.push(`Tool call: ${step.tool}. Success: true. Duration: ${durationMs}ms.`);
        } catch (error) {
          const durationMs = Date.now() - start;
          const message = error instanceof Error ? error.message : String(error);
          appendTelemetryEvent(telemetryFile, {
            'event.name': 'gemini_cli.tool_call',
            function_name: step.tool,
            function_args: JSON.stringify(args),
            duration_ms: durationMs,
            success: false,
            error: message,
          });
          return {
            output: stdoutLines.join('\n'),
            telemetryFile,
            stderr: message,
            exitCode: 1,
          };
        }
      }

      const output = [
        ...stdoutLines,
        `Emulated backend completed scenario "${scenario.id}".`,
      ].join('\n').trim();

      return {
        output,
        telemetryFile,
        stderr: '',
        exitCode: 0,
      };
    } finally {
      if (client) {
        await client.close().catch(() => {});
      }
    }
  }
}
