/**
 * Transaction Queue Interface
 * 
 * This interface defines the contract that all transaction queue implementations
 * must implement, whether local SQLite or remote Supabase.
 */

import { 
  TransactionInput, 
  TransactionRequest, 
  TransactionStatus, 
  UpdateMetadata, 
  QueueMetrics 
} from './types.js';

export interface ITransactionQueue {
  /**
   * Initialize the queue (create tables, setup connections, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Enqueue a new transaction request
   * @param transaction - The transaction to enqueue
   * @returns The created transaction request
   * @throws {Error} If validation fails or duplicate detected
   */
  enqueue(transaction: TransactionInput): Promise<TransactionRequest>;

  /**
   * Atomically claim the next pending transaction for processing
   * @param workerId - Unique identifier for the worker claiming the transaction
   * @returns The claimed transaction or null if none available
   */
  claim(workerId: string): Promise<TransactionRequest | null>;

  /**
   * Update the status and metadata of a transaction
   * @param id - Transaction ID
   * @param status - New status
   * @param metadata - Additional metadata to update
   */
  updateStatus(
    id: string, 
    status: TransactionStatus, 
    metadata?: UpdateMetadata
  ): Promise<void>;

  /**
   * Get transaction status and details by ID
   * @param id - Transaction ID
   * @returns Transaction details or null if not found
   */
  getStatus(id: string): Promise<TransactionRequest | null>;

  /**
   * Get transaction by payload hash (for idempotency)
   * @param payloadHash - The payload hash
   * @returns Transaction details or null if not found
   */
  getByPayloadHash(payloadHash: string): Promise<TransactionRequest | null>;

  /**
   * Get pending transactions (for monitoring/debugging)
   * @param limit - Maximum number of transactions to return
   * @returns Array of pending transactions
   */
  getPending(limit: number): Promise<TransactionRequest[]>;

  /**
   * Get transactions with expired claims (stuck in CLAIMED state)
   * @param timeoutMs - Timeout threshold in milliseconds
   * @returns Array of expired transactions
   */
  getExpiredClaims(timeoutMs: number): Promise<TransactionRequest[]>;

  /**
   * Clean up old completed/failed transactions
   * @param olderThanMs - Delete transactions older than this (milliseconds)
   * @returns Number of transactions deleted
   */
  cleanup(olderThanMs: number): Promise<number>;

  /**
   * Get queue metrics for monitoring
   * @returns Current queue metrics
   */
  getMetrics(): Promise<QueueMetrics>;

  /**
   * Close database connections and cleanup resources
   */
  close(): Promise<void>;
}