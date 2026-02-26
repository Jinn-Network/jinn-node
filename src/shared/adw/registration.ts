/**
 * ADW Registration File Builder
 *
 * Pure function that constructs an ADW Registration File from existing
 * artifact/document data. No IO — just data mapping.
 */

import type {
  ADWRegistrationFile,
  ADWDocumentType,
  ADWProfile,
  Provenance,
  Trust,
  StorageLocation,
  ADWIdentifier,
} from './types.js';
import { ADW_CONTEXT, ADW_REGISTRATION_TYPE } from './types.js';

export interface BuildRegistrationFileParams {
  // Required fields
  contentHash: string;
  name: string;
  documentType: ADWDocumentType;
  creator: string;

  // Optional core
  description?: string;
  version?: string;
  created?: string;

  // Extended
  tags?: string[];
  license?: string;
  language?: string;
  supersedes?: string;
  identifiers?: ADWIdentifier[];
  storage?: StorageLocation[];
  provenance?: Provenance;
  trust?: Trust;
  profile?: ADWProfile;
}

/**
 * Build an ADW Registration File from artifact/document data.
 *
 * Maps existing Jinn fields to ADW spec:
 *   cid          → contentHash
 *   name         → name
 *   topic        → profile.topic (for artifacts)
 *   type         → profile.artifactType (for artifacts)
 *   tags         → tags
 *   worker addr  → creator (formatted as eip155:8453:0x...)
 */
export function buildRegistrationFile(params: BuildRegistrationFileParams): ADWRegistrationFile {
  const {
    contentHash,
    name,
    documentType,
    creator,
    description = '',
    version = '1.0.0',
    created = new Date().toISOString(),
    tags,
    license,
    language,
    supersedes,
    identifiers,
    storage,
    provenance,
    trust,
    profile,
  } = params;

  const registration: ADWRegistrationFile = {
    type: ADW_REGISTRATION_TYPE,
    '@context': ADW_CONTEXT,
    documentType,
    version,
    name,
    description,
    contentHash,
    creator,
    created,
  };

  // Extended metadata — only include if present
  if (tags?.length) registration.tags = tags;
  if (license) registration.license = license;
  if (language) registration.language = language;
  if (supersedes) registration.supersedes = supersedes;
  if (identifiers?.length) registration.identifiers = identifiers;
  if (storage?.length) registration.storage = storage;
  if (provenance) registration.provenance = provenance;
  if (trust) registration.trust = trust;
  if (profile) registration.profile = profile;

  return registration;
}

/**
 * Format a wallet address as an ADW creator identifier.
 * Uses CAIP-10 format: eip155:{chainId}:{address}
 */
export function formatCreatorId(address: string, chainId: number = 8453): string {
  return `eip155:${chainId}:${address}`;
}

/**
 * Build an IPFS storage location entry.
 */
export function buildIpfsStorageLocation(cid: string, gateway?: string): StorageLocation {
  return {
    provider: 'ipfs',
    uri: `ipfs://${cid}`,
    ...(gateway ? { gateway } : {}),
  };
}
