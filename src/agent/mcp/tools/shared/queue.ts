/**
 * Shared Transaction Queue Instance
 * 
 * Provides a singleton transaction queue instance for use across MCP tools.
 * Configured via environment variables.
 */

import { TransactionQueueFactory, ITransactionQueue } from '../../../../worker/queue/index.js';

let queueInstance: ITransactionQueue | null = null;

/**
 * Get or create the shared transaction queue instance
 */
export function getTransactionQueue(): ITransactionQueue {
  if (!queueInstance) {
    queueInstance = TransactionQueueFactory.createFromEnv();
  }
  return queueInstance;
}

/**
 * Initialize the queue (should be called once at startup)
 */
export async function initializeQueue(): Promise<void> {
  const queue = getTransactionQueue();
  await queue.initialize();
}

/**
 * Close the queue (should be called at shutdown)
 */
export async function closeQueue(): Promise<void> {
  if (queueInstance) {
    await queueInstance.close();
    queueInstance = null;
  }
}