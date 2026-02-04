/**
 * Transaction Executor Interface
 * 
 * This interface defines the contract that all transaction executors must implement
 * in the dual-rail execution architecture. It provides a common interface for both
 * EOA (Externally Owned Account) and Safe (Gnosis Safe) execution strategies.
 * 
 * @version 2.0.0
 * @since Phase 3 - Dual Rail Architecture with Queue Abstraction
 */

import { TransactionRequest } from './queue/types.js';
import { ExecutionResult } from './types.js';
import { ITransactionQueue } from './queue/index.js';

/**
 * Interface that all transaction executors must implement
 */
export interface ITransactionExecutor {
  /**
   * Process a single transaction request
   * 
   * This method handles the complete lifecycle of a transaction:
   * 1. Validates the transaction against security constraints
   * 2. Executes the transaction using the appropriate method (EOA or Safe)
   * 3. Updates the queue with the result via the provided queue abstraction
   * 
   * @param request The transaction request to process
   * @param queue The queue abstraction for status updates
   */
  processTransactionRequest(request: TransactionRequest, queue: ITransactionQueue): Promise<void>;
}
