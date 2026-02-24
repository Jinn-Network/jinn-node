import type { PeerId, ConnectionGater } from '@libp2p/interface';
import { peerIdToEthAddress } from './identity.js';

export interface StakingGaterConfig {
  isStaked: (ethAddress: string) => Promise<boolean>;
}

async function checkStaked(peerId: PeerId, isStaked: StakingGaterConfig['isStaked']): Promise<boolean> {
  try {
    const ethAddress = peerIdToEthAddress(peerId);
    return !(await isStaked(ethAddress));
  } catch {
    return true; // Deny if we can't derive the address (non-secp256k1 peer)
  }
}

export function createStakingGater(config: StakingGaterConfig): ConnectionGater {
  return {
    denyDialMultiaddr: async () => false,
    denyDialPeer: async () => false,
    denyInboundConnection: async () => false,
    denyOutboundConnection: async () => false,
    denyInboundEncryptedConnection: async (peerId: PeerId) =>
      checkStaked(peerId, config.isStaked),
    denyOutboundEncryptedConnection: async (peerId: PeerId) =>
      checkStaked(peerId, config.isStaked),
    denyInboundUpgradedConnection: async () => false,
    denyOutboundUpgradedConnection: async () => false,
  };
}
