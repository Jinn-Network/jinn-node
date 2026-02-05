import { z } from 'zod';
import dotenv from 'dotenv';
import { configLogger } from '../logging/index.js';

import {
  getRequiredRpcUrl,
  getRequiredChainId,
  getOptionalWorkerPrivateKey,
  getRequiredWorkerPrivateKey,
  getOptionalWalletStoragePath,
  getOptionalTestRpcUrl,
  getDisableStsChecks,
  getOptionalSupabaseUrl,
  getOptionalSupabaseServiceRoleKey,
  getEnableTransactionExecutor,
  getOptionalWorkerId,
  getWorkerTxConfirmations,
} from '../config/index.js';

// ============================================================================
// Re-exports for backward compatibility
// ============================================================================

export {
  getRequiredRpcUrl,
  getRequiredChainId,
  getOptionalWorkerPrivateKey,
  getRequiredWorkerPrivateKey,
  getOptionalWalletStoragePath,
  getOptionalTestRpcUrl,
  getDisableStsChecks,
  getOptionalSupabaseUrl,
  getOptionalSupabaseServiceRoleKey,
  getEnableTransactionExecutor,
  getOptionalWorkerId,
  getWorkerTxConfirmations,
};

// ============================================================================
// Legacy exports for backward compatibility during migration
// ============================================================================

/**
 * Legacy WorkerConfig type
 * @deprecated Import specific getters from '../config/index.js' instead
 */
export interface WorkerConfig {
  WORKER_PRIVATE_KEY?: string;
  CHAIN_ID: number;
  RPC_URL: string;
  JINN_WALLET_STORAGE_PATH?: string;
  TEST_RPC_URL?: string;
  DISABLE_STS_CHECKS?: boolean;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  ENABLE_TRANSACTION_EXECUTOR: boolean;
  WORKER_ID?: string;
  WORKER_TX_CONFIRMATIONS: number;
}

/**
 * Legacy config object
 * @deprecated Use specific getters instead: getRequiredRpcUrl(), getRequiredChainId(), etc.
 */
export const config: WorkerConfig = {
  get WORKER_PRIVATE_KEY() { return getOptionalWorkerPrivateKey(); },
  get CHAIN_ID() { return getRequiredChainId(); },
  get RPC_URL() { return getRequiredRpcUrl(); },
  get JINN_WALLET_STORAGE_PATH() { return getOptionalWalletStoragePath(); },
  get TEST_RPC_URL() { return getOptionalTestRpcUrl(); },
  get DISABLE_STS_CHECKS() { return getDisableStsChecks(); },
  get SUPABASE_URL() { return getOptionalSupabaseUrl(); },
  get SUPABASE_SERVICE_ROLE_KEY() { return getOptionalSupabaseServiceRoleKey(); },
  get ENABLE_TRANSACTION_EXECUTOR() { return getEnableTransactionExecutor(); },
  get WORKER_ID() { return getOptionalWorkerId(); },
  get WORKER_TX_CONFIRMATIONS() { return getWorkerTxConfirmations(); },
};

// Legacy parseWorkerConfig function removed - configuration is now loaded automatically via getters

/**
 * Legacy helper: Get optional string from environment
 * @deprecated Use getOptional*() getters from '../config/index.js' instead
 */
export function getOptionalString(key: string, defaultValue?: string): string | undefined {
  // TODO(JINN-234): Migrate callers to use specific getters from config/index.ts
  return process.env[key] ?? defaultValue;
}

/**
 * Legacy helper: Get required string from environment
 * @deprecated Use getRequired*() getters from '../config/index.js' instead
 */
export function getRequiredString(key: string): string {
  // TODO(JINN-234): Migrate callers to use specific getters from config/index.ts
  const value = process.env[key];
  if (value === undefined) {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value;
}

/**
 * Legacy helper: Get optional number from environment
 * @deprecated Use getOptional*() getters from '../config/index.js' instead
 */
export function getOptionalNumber(key: string, defaultValue?: number): number | undefined {
  // TODO(JINN-234): Migrate callers to use specific getters from config/index.ts
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  const num = Number(value);
  return isNaN(num) ? defaultValue : num;
}
