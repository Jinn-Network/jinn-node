/**
 * BlueprintBuilder Configuration
 *
 * This module provides blueprint-specific configuration by importing
 * from the canonical config module (config/index.ts). It exists solely
 * to provide a typed interface for BlueprintBuilderConfig.
 *
 * All environment variable access goes through config/index.ts getters.
 * This module never reads process.env directly.
 *
 * See: docs/code-spec/spec.md "Centralize configuration access"
 */

import type { BlueprintBuilderConfig } from './types.js';
import {
  getBlueprintBuilderDebug,
  getBlueprintLogProviders,
  getBlueprintEnableSystem,
  getBlueprintEnableContextAssertions,
  getBlueprintEnableRecognition,
  getBlueprintEnableJobContext,
  getBlueprintEnableProgress,
  getBlueprintEnableBeads,
  getBlueprintEnableContextPhases,
} from '../../config/index.js';

/**
 * Default configuration for the BlueprintBuilder
 * All values come from centralized config
 */
export const DEFAULT_BLUEPRINT_CONFIG: BlueprintBuilderConfig = {
  enableSystemBlueprint: getBlueprintEnableSystem(),
  enableContextAssertions: getBlueprintEnableContextAssertions(),
  // Master switch overrides individual recognition/progress settings
  enableRecognitionLearnings: getBlueprintEnableContextPhases() && getBlueprintEnableRecognition(),
  enableJobContext: getBlueprintEnableJobContext(),
  enableProgressCheckpoint: getBlueprintEnableContextPhases() && getBlueprintEnableProgress(),
  enableBeadsAssertions: getBlueprintEnableBeads(),
  enableContextPhases: getBlueprintEnableContextPhases(),
  debug: getBlueprintBuilderDebug(),
  logProviders: getBlueprintLogProviders(),
};

/**
 * Create a config with explicit overrides
 * No longer reads from environment directly
 */
export function createConfigFromEnv(
  overrides?: Partial<BlueprintBuilderConfig>
): BlueprintBuilderConfig {
  return {
    ...DEFAULT_BLUEPRINT_CONFIG,
    ...overrides,
  };
}
