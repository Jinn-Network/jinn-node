import type { Helia } from '@helia/interface';
import type { CID } from 'multiformats/cid';
import type { GossipSub } from '@libp2p/gossipsub';

export const CONTENT_TOPIC = 'jinn/content/v1';

function getPubsub(helia: Helia): GossipSub {
  const pubsub = (helia.libp2p.services as Record<string, unknown>).pubsub as GossipSub | undefined;
  if (!pubsub) {
    throw new Error('Gossipsub service not available on this Helia node');
  }
  return pubsub;
}

/**
 * Publish a content announcement to the gossipsub network.
 * Peers subscribed to the topic will receive the CID and can fetch it via bitswap.
 */
export async function publishContentAnnouncement(helia: Helia, cid: CID): Promise<void> {
  const pubsub = getPubsub(helia);
  const message = new TextEncoder().encode(JSON.stringify({
    type: 'content',
    cid: cid.toString(),
    timestamp: Date.now(),
  }));
  await pubsub.publish(CONTENT_TOPIC, message);
}

/**
 * Subscribe to content announcements from the gossipsub network.
 * Returns an unsubscribe function that removes the listener and unsubscribes from the topic.
 */
export function subscribeContentAnnouncements(
  helia: Helia,
  onAnnouncement: (cidStr: string, from: string) => void,
): () => void {
  const pubsub = getPubsub(helia);

  const handler = (event: CustomEvent): void => {
    if (event.detail.topic !== CONTENT_TOPIC) return;
    try {
      const data = JSON.parse(new TextDecoder().decode(event.detail.data));
      if (data.type === 'content' && data.cid) {
        onAnnouncement(data.cid, event.detail.from?.toString() ?? 'unknown');
      }
    } catch {
      // Ignore malformed messages
    }
  };

  pubsub.subscribe(CONTENT_TOPIC);
  pubsub.addEventListener('message', handler as EventListener);

  return () => {
    pubsub.removeEventListener('message', handler as EventListener);
    pubsub.unsubscribe(CONTENT_TOPIC);
  };
}
