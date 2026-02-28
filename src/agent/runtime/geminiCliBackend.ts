import type { AgentRuntimeBackend, AgentRuntimeExecutionResult } from './types.js';

export class GeminiCliBackend implements AgentRuntimeBackend {
  readonly name = 'gemini' as const;

  constructor(
    private readonly runGemini: (prompt: string) => Promise<AgentRuntimeExecutionResult>
  ) {}

  run(prompt: string): Promise<AgentRuntimeExecutionResult> {
    return this.runGemini(prompt);
  }
}

