import type { AgentRuntimeBackendName } from './types.js';

function normalizeBackend(value: string | undefined): AgentRuntimeBackendName | null {
  if (!value) return null;
  if (value === 'gemini' || value === 'emulated') {
    return value;
  }
  return null;
}

export function resolveRuntimeBackend(env: NodeJS.ProcessEnv): AgentRuntimeBackendName {
  const explicit = normalizeBackend(env.AGENT_RUNTIME_BACKEND);
  if (explicit) return explicit;

  const runtimeEnvironment = env.RUNTIME_ENVIRONMENT;
  if (runtimeEnvironment === 'test' || runtimeEnvironment === 'review') {
    return 'emulated';
  }

  return 'gemini';
}

