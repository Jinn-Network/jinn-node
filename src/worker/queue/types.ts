/**
 * Shared types for transaction queue operations
 * These types mirror the database schema and existing types.ts
 */

export interface TransactionInput {
  payload: TransactionPayload;
  chainId: number;
  executionStrategy: ExecutionStrategy;
  idempotencyKey?: string;
  sourceJobId?: string;
}

export interface TransactionPayload {
  to: string;
  data: string;
  value: string;
}

export type TransactionStatus = 'PENDING' | 'CLAIMED' | 'CONFIRMED' | 'FAILED';
export type ExecutionStrategy = 'EOA' | 'SAFE';

export interface TransactionRequest {
  id: string;
  status: TransactionStatus;
  attempt_count: number;
  payload_hash: string;
  worker_id: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  payload: TransactionPayload;
  chain_id: number;
  safe_tx_hash: string | null;
  tx_hash: string | null;
  error_code: string | null;
  error_message: string | null;
  source_job_id: string | null;
  created_at: string;
  updated_at: string;
  execution_strategy: ExecutionStrategy;
  idempotency_key: string | null;
}

export interface UpdateMetadata {
  safe_tx_hash?: string;
  tx_hash?: string;
  error_code?: string;
  error_message?: string;
  completed_at?: string;
}

export interface QueueMetrics {
  pending_count: number;
  claimed_count: number;
  confirmed_count: number;
  failed_count: number;
  avg_processing_time_ms: number;
  oldest_pending_age_ms: number;
  worker_claims: Map<string, number>;
}

export interface QueueConfig {
  type: 'local' | 'supabase';
  local?: LocalQueueConfig;
  supabase?: SupabaseQueueConfig;
}

export interface LocalQueueConfig {
  dbPath: string;
  walMode?: boolean;
  cacheSize?: number;
}

export interface SupabaseQueueConfig {
  url: string;
  key: string;
}

export const CLAIM_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes