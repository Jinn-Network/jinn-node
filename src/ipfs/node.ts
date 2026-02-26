import { createHelia, libp2pDefaults } from 'helia';
import { tcp } from '@libp2p/tcp';
import { bootstrap } from '@libp2p/bootstrap';
import { gossipsub } from '@libp2p/gossipsub';
import { FsBlockstore } from 'blockstore-fs';
import { LevelDatastore } from 'datastore-level';
import { MemoryBlockstore } from 'blockstore-core';
import { privateKeyFromRaw } from '@libp2p/crypto/keys';
import { createStakingGater, type StakingGaterConfig } from './gater.js';
import { hexToBytes } from './cid.js';
import type { Helia } from '@helia/interface';

export interface JinnNodeConfig {
  /** Worker's secp256k1 private key (hex) */
  privateKey: string;
  /** Staking check function */
  isStaked: StakingGaterConfig['isStaked'];
  /** Peer IDs that bypass staking checks (infra peers like local gateway) */
  trustedPeerIds?: string[];
  /** Bootstrap peer multiaddrs */
  bootstrapPeers?: string[];
  /** Addresses to advertise to peers (e.g. public IP in containers) */
  announceAddresses?: string[];
  /** Storage config */
  storage?: {
    type: 'memory' | 'filesystem';
    blocksPath?: string;
    datastorePath?: string;
  };
  /** TCP listen port (default: 4001, use 0 for random) */
  listenPort?: number;
}

export async function createJinnNode(config: JinnNodeConfig): Promise<Helia> {
  const privateKey = privateKeyFromRaw(hexToBytes(config.privateKey));

  const port = config.listenPort ?? 4001;

  const defaults = libp2pDefaults({ privateKey });

  // Strip unnecessary public network services
  delete (defaults.services as any).autoNAT;
  delete (defaults.services as any).autoTLS;
  delete (defaults.services as any).dcutr;
  delete (defaults.services as any).delegatedRouting;
  delete (defaults.services as any).upnp;
  delete (defaults.services as any).relay;
  delete (defaults.services as any).http;

  // TCP-only transport
  defaults.addresses = {
    listen: [`/ip4/0.0.0.0/tcp/${port}`],
    ...(config.announceAddresses?.length && { announce: config.announceAddresses }),
  };
  defaults.transports = [tcp()];

  // Bootstrap peers
  if (config.bootstrapPeers?.length) {
    defaults.peerDiscovery = [bootstrap({ list: config.bootstrapPeers })];
  } else {
    defaults.peerDiscovery = [];
  }

  // Gossipsub — floodPublish for private network (all peers are trusted/staked)
  (defaults.services as any).pubsub = gossipsub({
    emitSelf: false,
    allowPublishToZeroTopicPeers: true,
    floodPublish: true,
  });

  // Staking-based ConnectionGater with optional trusted infrastructure peers.
  const trustedPeerIds = [
    ...(config.trustedPeerIds ?? []),
    ...(process.env.IPFS_GATEWAY_PEER_ID ? [process.env.IPFS_GATEWAY_PEER_ID] : []),
  ];
  defaults.connectionGater = createStakingGater({
    isStaked: config.isStaked,
    trustedPeerIds,
  });

  // Storage
  const storageType = config.storage?.type ?? 'memory';
  const blockstore = storageType === 'filesystem'
    ? new FsBlockstore(config.storage!.blocksPath!)
    : new MemoryBlockstore();
  const datastore = storageType === 'filesystem'
    ? new LevelDatastore(config.storage!.datastorePath!)
    : undefined;

  const helia = await createHelia({
    blockstore,
    datastore,
    libp2p: defaults,
  });

  return helia;
}
