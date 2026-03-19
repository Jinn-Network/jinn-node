/**
 * Session types for the restoration marketplace worker.
 * Part of JINN-457: Invariant Restoration Marketplace on EIP-8183
 */

export enum SessionType {
  CREATE = 'CREATE',
  DELIVER = 'DELIVER',
  EVALUATE = 'EVALUATE',
}

export interface EpochProgress {
  creates: number;
  delivers: number;
  evaluates: number;
  epochStart: number; // unix timestamp
}

export interface SessionConfig {
  /** Minimum CREATE sessions per epoch */
  minCreatesPerEpoch: number;
  /** Minimum DELIVER sessions per epoch */
  minDeliversPerEpoch: number;
  /** Minimum EVALUATE sessions per epoch */
  minEvaluatesPerEpoch: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  minCreatesPerEpoch: 1,
  minDeliversPerEpoch: 1,
  minEvaluatesPerEpoch: 1,
};

export interface SessionResult {
  type: SessionType;
  success: boolean;
  /** 8183 job ID if applicable */
  jobId?: number;
  /** 8004 document CIDs produced */
  documentCIDs?: string[];
  /** Error message if failed */
  error?: string;
  /** Duration in ms */
  durationMs: number;
}
