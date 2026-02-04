/**
 * Setup module exports
 *
 * Provides the interactive service setup CLI and test isolation utilities.
 */

export { createIsolatedMiddlewareEnvironment, type IsolatedEnvironment } from './test-isolation.js';
export { runPreflight, type PreflightResult, type PreflightOptions } from './preflight.js';

// CLI is typically run directly, but export for programmatic use
export { } from './cli.js';
