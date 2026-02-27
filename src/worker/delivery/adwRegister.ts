/**
 * ADW On-Chain Registration
 *
 * After delivery succeeds, register each artifact's Registration File
 * on the ADW DocumentRegistry contract. This makes documents discoverable
 * by the ADW subgraph and any third-party indexer.
 *
 * Registration is best-effort — failures don't affect delivery.
 */

import { ethers } from 'ethers';
import { workerLogger } from '../../logging/index.js';
import { getRequiredRpcUrl } from '../../agent/mcp/tools/shared/env.js';
import { getServicePrivateKey } from '../../env/operate-profile.js';

const log = workerLogger.child({ component: 'ADW_REGISTER' });

const DOCUMENT_REGISTRY_ADDRESS = '0x40Eac2B201D12b13b442c330eED0A2aB04b06DeE';

const DOCUMENT_REGISTRY_ABI = [
  'function register(string documentURI, bytes32 contentHash, string documentType) returns (uint256 documentId)',
  'function contentHashToDocumentId(bytes32) view returns (uint256)',
];

interface ArtifactForRegistration {
  cid: string;          // Registration File CID
  contentCid?: string;  // Raw content CID
  documentType?: string;
}

/**
 * Register artifacts on the ADW DocumentRegistry.
 * Best-effort: logs errors but never throws.
 */
export async function registerArtifactsOnChain(
  artifacts: ArtifactForRegistration[],
): Promise<void> {
  const registrable = artifacts.filter((a) => a.documentType && a.cid);
  if (registrable.length === 0) return;

  const privateKey = getServicePrivateKey();
  if (!privateKey) {
    log.debug('No private key available — skipping ADW on-chain registration');
    return;
  }

  let rpcUrl: string;
  try {
    rpcUrl = getRequiredRpcUrl();
  } catch {
    log.debug('No RPC URL available — skipping ADW on-chain registration');
    return;
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const registry = new ethers.Contract(DOCUMENT_REGISTRY_ADDRESS, DOCUMENT_REGISTRY_ABI, wallet);

  for (const artifact of registrable) {
    try {
      // Build the content hash as bytes32 from the CID
      // Use SHA-256 of the CID string as the content hash
      const contentHashBytes = ethers.keccak256(ethers.toUtf8Bytes(artifact.cid));

      // Check if already registered
      const existingId = await registry.contentHashToDocumentId(contentHashBytes);
      if (existingId > 0n) {
        log.debug({ cid: artifact.cid, documentId: existingId.toString() }, 'Artifact already registered on-chain');
        continue;
      }

      const documentURI = `ipfs://${artifact.cid}`;
      const documentType = artifact.documentType!;

      log.info({ cid: artifact.cid, documentType }, 'Registering artifact on ADW DocumentRegistry');

      const tx = await registry.register(documentURI, contentHashBytes, documentType);
      const receipt = await tx.wait();

      log.info(
        { cid: artifact.cid, txHash: receipt.hash, blockNumber: receipt.blockNumber },
        'Artifact registered on-chain'
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn({ cid: artifact.cid, error: message }, 'Failed to register artifact on-chain (non-fatal)');
    }
  }
}
