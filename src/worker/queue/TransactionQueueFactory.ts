/**
 * Transaction Queue Factory
 * 
 * Factory for creating transaction queue instances based on configuration.
 * Supports both local SQLite and Supabase implementations.
 */

import { ITransactionQueue } from './ITransactionQueue.js';
import { LocalTransactionQueue } from './LocalTransactionQueue.js';
import { QueueConfig } from './types.js';

export class TransactionQueueFactory {
  /**
   * Create a transaction queue instance based on configuration
   * @param config Queue configuration
   * @returns Configured queue instance
   */
  static create(config: QueueConfig): ITransactionQueue {
    switch (config.type) {
      case 'local':
        if (!config.local) {
          throw new Error('Local queue configuration is required when type is "local"');
        }
        return new LocalTransactionQueue(config.local);

      default:
        throw new Error(`Unknown queue type: ${(config as any).type}. Only "local" is currently supported.`);
    }
  }

  /**
   * Create queue from environment variables
   * Uses LOCAL_QUEUE_DB_PATH for local SQLite queue
   * @returns Configured queue instance
   */
  static createFromEnv(): ITransactionQueue {
    const localDbPath = process.env.LOCAL_QUEUE_DB_PATH || './data/transaction_queue.db';

    // Use local SQLite queue (default option)
    const config: QueueConfig = {
      type: 'local',
      local: {
        dbPath: localDbPath,
        walMode: true,
        cacheSize: 64000
      }
    };
    return this.create(config);
  }

  /**
   * Validate queue configuration
   * @param config Configuration to validate
   * @returns True if valid, throws error otherwise
   */
  static validateConfig(config: QueueConfig): boolean {
    if (!config.type) {
      throw new Error('Queue type is required');
    }

    switch (config.type) {
      case 'local':
        if (!config.local?.dbPath) {
          throw new Error('Database path is required for local queue');
        }
        break;

      default:
        throw new Error(`Invalid queue type: ${config.type}. Only "local" is currently supported.`);
    }

    return true;
  }
}