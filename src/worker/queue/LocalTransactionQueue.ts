/**
 * Local SQLite Transaction Queue Implementation
 * 
 * This implementation provides a local, file-based transaction queue using SQLite
 * with atomic operations for multi-worker environments.
 */

import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { ITransactionQueue } from './ITransactionQueue.js';
import {
  TransactionInput,
  TransactionRequest,
  TransactionStatus,
  UpdateMetadata,
  QueueMetrics,
  LocalQueueConfig,
  CLAIM_TIMEOUT_MS
} from './types.js';

interface DatabaseTransaction {
  id: string;
  status: string;
  attempt_count: number;
  payload_hash: string;
  worker_id: string | null;
  claimed_at: number | null;
  completed_at: number | null;
  payload: string;
  chain_id: number;
  safe_tx_hash: string | null;
  tx_hash: string | null;
  error_code: string | null;
  error_message: string | null;
  source_job_id: string | null;
  created_at: number;
  updated_at: number;
  execution_strategy: string;
  idempotency_key: string | null;
}

export class LocalTransactionQueue implements ITransactionQueue {
  private db: Database.Database;
  private config: LocalQueueConfig;

  // Prepared statements for performance
  private insertTransactionStmt!: Database.Statement;
  private selectByIdStmt!: Database.Statement;
  private selectByPayloadHashStmt!: Database.Statement;
  private updateStatusStmt!: Database.Statement;
  private updateStatusWithMetadataStmt!: Database.Statement;
  private selectPendingStmt!: Database.Statement;
  private selectExpiredClaimsStmt!: Database.Statement;
  private claimTransactionStmt!: Database.Statement;
  private cleanupStmt!: Database.Statement;

  constructor(config: LocalQueueConfig) {
    this.config = {
      walMode: true,
      cacheSize: 64000, // 64MB
      ...config
    };

    // Ensure directory exists
    const dbDir = dirname(this.config.dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(this.config.dbPath);
    
    // Configure SQLite for optimal performance and concurrency
    this.configureDatabase();
  }

  async initialize(): Promise<void> {
    this.createTables();
    this.prepareStatements();
  }

  private configureDatabase(): void {
    // Enable WAL mode for better concurrency
    if (this.config.walMode) {
      this.db.pragma('journal_mode = WAL');
    }

    // Optimize for write performance
    this.db.pragma('synchronous = NORMAL');
    
    // Set cache size
    if (this.config.cacheSize) {
      this.db.pragma(`cache_size = -${this.config.cacheSize}`);
    }

    // Enable foreign key constraints
    this.db.pragma('foreign_keys = ON');

    // Set busy timeout to 30 seconds
    this.db.pragma('busy_timeout = 30000');
  }

  private createTables(): void {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS transaction_requests (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'CLAIMED', 'CONFIRMED', 'FAILED')),
        attempt_count INTEGER DEFAULT 0,
        payload_hash TEXT UNIQUE NOT NULL,
        worker_id TEXT,
        claimed_at INTEGER,
        completed_at INTEGER,
        payload TEXT NOT NULL,
        chain_id INTEGER,
        safe_tx_hash TEXT,
        tx_hash TEXT,
        error_code TEXT,
        error_message TEXT,
        source_job_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        execution_strategy TEXT CHECK (execution_strategy IN ('EOA', 'SAFE')),
        idempotency_key TEXT UNIQUE
      )
    `;

    const createIndicesSQL = [
      'CREATE INDEX IF NOT EXISTS idx_status_created ON transaction_requests(status, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_worker_claimed ON transaction_requests(worker_id, claimed_at)',
      'CREATE INDEX IF NOT EXISTS idx_source_job ON transaction_requests(source_job_id)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_payload_hash ON transaction_requests(payload_hash)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_key ON transaction_requests(idempotency_key)'
    ];

    this.db.exec(createTableSQL);
    createIndicesSQL.forEach(sql => this.db.exec(sql));
  }

  private prepareStatements(): void {
    this.insertTransactionStmt = this.db.prepare(`
      INSERT INTO transaction_requests (
        id, status, payload_hash, payload, chain_id, execution_strategy, 
        idempotency_key, source_job_id, created_at, updated_at
      ) VALUES (?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.selectByIdStmt = this.db.prepare(`
      SELECT * FROM transaction_requests WHERE id = ?
    `);

    this.selectByPayloadHashStmt = this.db.prepare(`
      SELECT * FROM transaction_requests WHERE payload_hash = ?
    `);

    this.updateStatusStmt = this.db.prepare(`
      UPDATE transaction_requests 
      SET status = ?, updated_at = ?
      WHERE id = ?
    `);

    this.updateStatusWithMetadataStmt = this.db.prepare(`
      UPDATE transaction_requests 
      SET status = ?, safe_tx_hash = ?, tx_hash = ?, error_code = ?, 
          error_message = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `);

    this.selectPendingStmt = this.db.prepare(`
      SELECT * FROM transaction_requests 
      WHERE status = 'PENDING' 
      ORDER BY created_at ASC 
      LIMIT ?
    `);

    this.selectExpiredClaimsStmt = this.db.prepare(`
      SELECT * FROM transaction_requests 
      WHERE status = 'CLAIMED' AND claimed_at < ?
    `);

    this.cleanupStmt = this.db.prepare(`
      DELETE FROM transaction_requests 
      WHERE status IN ('CONFIRMED', 'FAILED') AND completed_at < ?
    `);
  }

  async enqueue(transaction: TransactionInput): Promise<TransactionRequest> {
    const payloadHash = this.calculatePayloadHash(transaction.payload);
    
    try {
      const id = randomUUID();
      const now = Date.now();

      this.insertTransactionStmt.run([
        id,
        payloadHash,
        JSON.stringify(transaction.payload),
        transaction.chainId,
        transaction.executionStrategy,
        transaction.idempotencyKey || null,
        transaction.sourceJobId || null,
        now,
        now
      ]);

      const result = this.selectByIdStmt.get(id) as DatabaseTransaction;
      return this.deserializeTransaction(result);
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        // Return existing transaction for idempotency
        const existing = this.selectByPayloadHashStmt.get(payloadHash) as DatabaseTransaction;
        if (existing) {
          return this.deserializeTransaction(existing);
        }
      }
      throw error;
    }
  }

  async claim(workerId: string): Promise<TransactionRequest | null> {
    // Use transaction to ensure atomicity
    const result = this.db.transaction(() => {
      const now = Date.now();
      const expiredTime = now - CLAIM_TIMEOUT_MS;

      // Find oldest PENDING or expired CLAIMED transaction
      const candidate = this.db.prepare(`
        SELECT * FROM transaction_requests 
        WHERE (
          status = 'PENDING' 
          OR (status = 'CLAIMED' AND claimed_at < ?)
        )
        ORDER BY created_at ASC
        LIMIT 1
      `).get(expiredTime) as DatabaseTransaction | undefined;

      if (!candidate) {
        return null;
      }

      // Update atomically
      this.db.prepare(`
        UPDATE transaction_requests 
        SET status = 'CLAIMED',
            worker_id = ?,
            claimed_at = ?,
            attempt_count = attempt_count + 1,
            updated_at = ?
        WHERE id = ?
      `).run(workerId, now, now, candidate.id);

      // Return updated transaction
      const updated = this.selectByIdStmt.get(candidate.id) as DatabaseTransaction;
      return this.deserializeTransaction(updated);
    })();

    return result;
  }

  async updateStatus(
    id: string, 
    status: TransactionStatus, 
    metadata?: UpdateMetadata
  ): Promise<void> {
    const now = Date.now();

    if (metadata) {
      const completedAtMs = metadata.completed_at ? new Date(metadata.completed_at).getTime() : now;
      this.updateStatusWithMetadataStmt.run([
        status,
        metadata.safe_tx_hash || null,
        metadata.tx_hash || null,
        metadata.error_code || null,
        metadata.error_message || null,
        completedAtMs,
        now,
        id
      ]);
    } else {
      this.updateStatusStmt.run(status, now, id);
    }
  }

  async getStatus(id: string): Promise<TransactionRequest | null> {
    const result = this.selectByIdStmt.get(id) as DatabaseTransaction | undefined;
    return result ? this.deserializeTransaction(result) : null;
  }

  async getByPayloadHash(payloadHash: string): Promise<TransactionRequest | null> {
    const result = this.selectByPayloadHashStmt.get(payloadHash) as DatabaseTransaction | undefined;
    return result ? this.deserializeTransaction(result) : null;
  }

  async getPending(limit: number): Promise<TransactionRequest[]> {
    const results = this.selectPendingStmt.all(limit) as DatabaseTransaction[];
    return results.map(row => this.deserializeTransaction(row));
  }

  async getExpiredClaims(timeoutMs: number): Promise<TransactionRequest[]> {
    const expiredTime = Date.now() - timeoutMs;
    const results = this.selectExpiredClaimsStmt.all(expiredTime) as DatabaseTransaction[];
    return results.map(row => this.deserializeTransaction(row));
  }

  async cleanup(olderThanMs: number): Promise<number> {
    const cutoffTime = Date.now() - olderThanMs;
    const result = this.cleanupStmt.run(cutoffTime);
    return result.changes;
  }

  async getMetrics(): Promise<QueueMetrics> {
    const countsQuery = this.db.prepare(`
      SELECT 
        status,
        COUNT(*) as count
      FROM transaction_requests 
      GROUP BY status
    `);

    const avgTimeQuery = this.db.prepare(`
      SELECT AVG(completed_at - claimed_at) as avg_time
      FROM transaction_requests 
      WHERE status IN ('CONFIRMED', 'FAILED') 
        AND completed_at IS NOT NULL 
        AND claimed_at IS NOT NULL
    `);

    const oldestPendingQuery = this.db.prepare(`
      SELECT MIN(created_at) as oldest
      FROM transaction_requests 
      WHERE status = 'PENDING'
    `);

    const workerClaimsQuery = this.db.prepare(`
      SELECT 
        worker_id,
        COUNT(*) as count
      FROM transaction_requests 
      WHERE status = 'CLAIMED' AND worker_id IS NOT NULL
      GROUP BY worker_id
    `);

    const counts = countsQuery.all() as { status: string; count: number }[];
    const avgTimeResult = avgTimeQuery.get() as { avg_time: number | null } | undefined;
    const oldestResult = oldestPendingQuery.get() as { oldest: number | null } | undefined;
    const workerClaims = workerClaimsQuery.all() as { worker_id: string; count: number }[];

    const statusCounts = counts.reduce((acc, { status, count }) => {
      acc[status.toLowerCase() + '_count'] = count;
      return acc;
    }, {} as Record<string, number>);

    const now = Date.now();
    return {
      pending_count: statusCounts.pending_count || 0,
      claimed_count: statusCounts.claimed_count || 0,
      confirmed_count: statusCounts.confirmed_count || 0,
      failed_count: statusCounts.failed_count || 0,
      avg_processing_time_ms: avgTimeResult?.avg_time || 0,
      oldest_pending_age_ms: oldestResult?.oldest ? now - oldestResult.oldest : 0,
      worker_claims: new Map(workerClaims.map(w => [w.worker_id, w.count]))
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private calculatePayloadHash(payload: any): string {
    // Create canonical JSON representation for consistent hashing
    const canonicalPayload = JSON.stringify(payload, Object.keys(payload).sort());
    return createHash('sha256').update(canonicalPayload).digest('hex');
  }

  private deserializeTransaction(row: DatabaseTransaction): TransactionRequest {
    return {
      id: row.id,
      status: row.status as TransactionStatus,
      attempt_count: row.attempt_count,
      payload_hash: row.payload_hash,
      worker_id: row.worker_id,
      claimed_at: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
      completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
      payload: JSON.parse(row.payload),
      chain_id: row.chain_id,
      safe_tx_hash: row.safe_tx_hash,
      tx_hash: row.tx_hash,
      error_code: row.error_code,
      error_message: row.error_message,
      source_job_id: row.source_job_id,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      execution_strategy: row.execution_strategy as any,
      idempotency_key: row.idempotency_key
    };
  }
}