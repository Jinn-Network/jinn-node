import type { Blockstore } from 'interface-blockstore';
import { MemoryBlockstore } from 'blockstore-core';
import { FsBlockstore } from 'blockstore-fs';
import { jsonToCid, bytesToCid, cidToDigestHex } from './cid.js';

export interface JinnBlockStore {
  putJson(payload: unknown): Promise<{ cid: CID; digestHex: string; bytes: Uint8Array }>;
  putBytes(bytes: Uint8Array): Promise<{ cid: CID; digestHex: string }>;
  getJson(cid: CID): Promise<unknown | null>;
  getBytes(cid: CID): Promise<Uint8Array | null>;
  has(cid: CID): Promise<boolean>;
  close(): Promise<void>;
  readonly inner: Blockstore;
}

export interface BlockStoreConfig {
  type: 'memory' | 'filesystem';
  path?: string; // required for filesystem
}

/**
 * Collect all chunks from a blockstore get() result into a single Uint8Array.
 * blockstore-core v6 returns a Generator<Uint8Array> from get().
 */
function collectBytes(result: unknown): Uint8Array {
  if (result instanceof Uint8Array) return result;

  // Generator/Iterable of Uint8Array chunks
  if (result && typeof (result as any)[Symbol.iterator] === 'function') {
    const chunks: Uint8Array[] = [];
    for (const chunk of result as Iterable<Uint8Array>) {
      chunks.push(chunk);
    }
    if (chunks.length === 1) return chunks[0];
    const total = chunks.reduce((acc, c) => acc + c.length, 0);
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return combined;
  }

  throw new Error(`Unexpected blockstore get result type: ${typeof result}`);
}

export async function createBlockStore(config: BlockStoreConfig): Promise<JinnBlockStore> {
  const inner: Blockstore = config.type === 'filesystem'
    ? new FsBlockstore(config.path!)
    : new MemoryBlockstore();

  return {
    inner,

    async putJson(payload: unknown) {
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const cid = await jsonToCid(payload);
      await inner.put(cid, bytes);
      return { cid, digestHex: cidToDigestHex(cid), bytes };
    },

    async putBytes(bytes: Uint8Array) {
      const cid = await bytesToCid(bytes);
      await inner.put(cid, bytes);
      return { cid, digestHex: cidToDigestHex(cid) };
    },

    async getJson(cid: CID) {
      try {
        const result = await inner.get(cid);
        const bytes = collectBytes(result);
        return JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return null;
      }
    },

    async getBytes(cid: CID) {
      try {
        const result = await inner.get(cid);
        return collectBytes(result);
      } catch {
        return null;
      }
    },

    async has(cid: CID) {
      return inner.has(cid);
    },

    async close() {
      if ('close' in inner && typeof (inner as any).close === 'function') {
        await (inner as any).close();
      }
    },
  };
}
