export type AgentRuntimeBackendName = 'gemini' | 'emulated';

export type AgentRuntimeExecutionResult = {
  output: string;
  telemetryFile: string;
  stderr: string;
  exitCode: number;
};

export interface AgentRuntimeBackend {
  readonly name: AgentRuntimeBackendName;
  run(prompt: string): Promise<AgentRuntimeExecutionResult>;
}

