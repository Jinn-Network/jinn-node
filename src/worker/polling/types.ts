/**
 * Event types for 8183 + 8004 polling
 * Part of JINN-457: Invariant Restoration Marketplace on EIP-8183
 */

import { JobStatus } from '../contracts/RestorationMarketplace.js';

export interface BaseEvent {
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

// ============ 8183 Events ============

export interface JobCreatedEvent extends BaseEvent {
  type: 'JobCreated';
  jobId: number;
  client: string;
  evaluator: string;
  provider: string;
  hook: string;
  expiredAt: bigint;
}

export interface JobFundedEvent extends BaseEvent {
  type: 'JobFunded';
  jobId: number;
  amount: bigint;
}

export interface JobSubmittedEvent extends BaseEvent {
  type: 'JobSubmitted';
  jobId: number;
  deliverable: string; // bytes, typically a CID
}

export interface JobCompletedEvent extends BaseEvent {
  type: 'JobCompleted';
  jobId: number;
  reason: string;
}

export interface JobRejectedEvent extends BaseEvent {
  type: 'JobRejected';
  jobId: number;
  reason: string;
}

export interface JobExpiredEvent extends BaseEvent {
  type: 'JobExpired';
  jobId: number;
}

// ============ 8004 Events ============

export interface DocumentRegisteredEvent extends BaseEvent {
  type: 'DocumentRegistered';
  documentId: bigint;
  documentURI: string;
  contentHash: string;
  documentType: string;
}

// ============ Union Types ============

export type MarketplaceEvent =
  | JobCreatedEvent
  | JobFundedEvent
  | JobSubmittedEvent
  | JobCompletedEvent
  | JobRejectedEvent
  | JobExpiredEvent;

export type DocumentEvent = DocumentRegisteredEvent;

export type PolledEvent = MarketplaceEvent | DocumentEvent;

// ============ Poller State ============

export interface PollerCheckpoint {
  lastBlock: number;
  updatedAt: number; // unix ms
}
