/**
 * Active Service Context — Identity singleton for multi-service rotation
 *
 * Holds the currently active service identity (mech, safe, key, service ID).
 * When populated, operate-profile.ts getters use this instead of reading
 * from the .operate directory, enabling hot-swap between services.
 *
 * In single-service mode this is never populated, so existing behavior
 * is preserved with zero overhead.
 */

export interface ActiveServiceIdentity {
  mechAddress: string;
  safeAddress: string;
  privateKey: string;
  chainConfig: string;
  serviceId: number;
  serviceConfigId: string;
  stakingContract: string | null;
}

let _active: ActiveServiceIdentity | null = null;

/** Set the active service identity (called by ServiceRotator) */
export function setActiveService(identity: ActiveServiceIdentity): void {
  _active = identity;
}

/** Get the active service identity, or null if single-service mode */
export function getActiveService(): ActiveServiceIdentity | null {
  return _active;
}

/** Clear the active service (revert to .operate directory reads) */
export function clearActiveService(): void {
  _active = null;
}

// Typed getters matching operate-profile.ts interface

export function getActiveMechAddress(): string | null {
  return _active?.mechAddress ?? null;
}

export function getActiveSafeAddress(): string | null {
  return _active?.safeAddress ?? null;
}

export function getActivePrivateKey(): string | null {
  return _active?.privateKey ?? null;
}

export function getActiveChainConfig(): string | null {
  return _active?.chainConfig ?? null;
}
