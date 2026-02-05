/**
 * Control API configuration utilities.
 * Centralized location for Control API feature flags.
 */

/**
 * Checks if the Control API is enabled.
 * @returns {boolean} - `true` if the Control API is enabled, `false` otherwise.
 */
export function isControlApiEnabled(): boolean {
  return (process.env.USE_CONTROL_API ?? 'true') !== 'false';
}

