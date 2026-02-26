import type { PeerId, ConnectionGater } from '@libp2p/interface';
import { peerIdToEthAddress } from './identity.js';

export interface StakingGaterConfig {
  isStaked: (ethAddress: string) => Promise<boolean>;
  trustedPeerIds?: Iterable<string>;
}

async function checkStaked(
  peerId: PeerId,
  isStaked: StakingGaterConfig['isStaked'],
  trustedPeerIds: Set<string>,
): Promise<boolean> {
  if (trustedPeerIds.has(peerId.toString())) {
    return false;
  }

  try {
    const ethAddress = peerIdToEthAddress(peerId);
    return !(await isStaked(ethAddress));
  } catch {
    return true; // Deny if we can't derive the address (non-secp256k1 peer)
  }
}

export function createStakingGater(config: StakingGaterConfig): ConnectionGater {
  const trustedPeerIds = new Set(
    Array.from(config.trustedPeerIds ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );

  return {
    denyDialMultiaddr: async () => false,
    denyDialPeer: async () => false,
    denyInboundConnection: async () => false,
    denyOutboundConnection: async () => false,
    denyInboundEncryptedConnection: async (peerId: PeerId) =>
      checkStaked(peerId, config.isStaked, trustedPeerIds),
    denyOutboundEncryptedConnection: async (peerId: PeerId) =>
      checkStaked(peerId, config.isStaked, trustedPeerIds),
    denyInboundUpgradedConnection: async () => false,
    denyOutboundUpgradedConnection: async () => false,
  };
}
