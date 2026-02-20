const JINN_JOB_ENV_KEY_PATTERN = /^JINN_JOB_[A-Z0-9_]+$/;

export function assertValidJinnJobEnvKey(key: string, source: string): void {
  if (!JINN_JOB_ENV_KEY_PATTERN.test(key)) {
    throw new Error(
      `${source} contains invalid env key "${key}". Only JINN_JOB_* keys are allowed.`,
    );
  }
}

export function assertValidJinnJobEnvMap(rawEnv: unknown, source: string): Record<string, string> {
  if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
    throw new Error(`${source} must be an object map of JINN_JOB_* keys to string values.`);
  }

  const validated: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv as Record<string, unknown>)) {
    assertValidJinnJobEnvKey(key, source);
    if (typeof value !== 'string') {
      throw new Error(`${source} has non-string value for key "${key}".`);
    }
    validated[key] = value;
  }
  return validated;
}
