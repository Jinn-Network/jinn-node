import { z } from 'zod';
import { getTransactionQueue } from './shared/queue.js';
import fetch from 'cross-fetch';
import { isControlApiEnabled } from './shared/control_api.js';
import { getMechAddress } from '../../../env/operate-profile.js';

// Control API URL
const CONTROL_API_URL = process.env.CONTROL_API_URL || 'http://localhost:4001/graphql';

export const getTransactionStatusParams = z.object({
  request_id: z.string().uuid('A valid UUID for the transaction request is required.'),
});

export const schema = {
  description: 'Gets the status and details of a queued transaction request, including explorer URLs for any resulting hashes.',
  inputSchema: getTransactionStatusParams.shape
};

// Private helper function to get explorer URLs
function getExplorerUrl(chainId: number, txHash: string): string {
  const explorers: Record<number, string> = {
    1: 'https://etherscan.io',
    8453: 'https://basescan.org',
    10: 'https://optimistic.etherscan.io',
    42161: 'https://arbiscan.io',
    137: 'https://polygonscan.com',
    11155111: 'https://sepolia.etherscan.io'
  };
  
  const baseUrl = explorers[chainId] || 'https://etherscan.io';
  return `${baseUrl}/tx/${txHash}`;
}

/**
 * Get the status of a transaction request and construct explorer URLs for any resulting hashes.
 * @param {object} params - The parameters for the tool.
 * @param {string} params.request_id - The UUID of the transaction request to query.
 * @returns {object} The result of the operation, including transaction status and explorer URLs.
 */
export async function getTransactionStatus(params: z.infer<typeof getTransactionStatusParams>) {
  try {
    let data;

    // Use Control API when enabled (for on-chain jobs)
    if (isControlApiEnabled()) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Worker-Address': getMechAddress() || ''
      };
      const query = `query GetTx($id: String!) { getTransactionStatus(id: $id) { id chain_id safe_tx_hash tx_hash status } }`;
      const body = { query, variables: { id: params.request_id } };
      const res = await fetch(CONTROL_API_URL, { method: 'POST', headers, body: JSON.stringify(body) });
      const json = await res.json();
      if (json.errors) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'CONTROL_API_ERROR', message: json.errors[0]?.message || 'Unknown error' }, null, 2) }] };
      }
      data = json.data.getTransactionStatus;
    } else {
      // Fallback: Use local transaction queue
      const queue = getTransactionQueue();
      data = await queue.getStatus(params.request_id);
    }

    const response = {
      id: data.id,
      status: data.status,
      attempt_count: data.attempt_count,
      payload_hash: data.payload_hash,
      worker_id: data.worker_id,
      claimed_at: data.claimed_at,
      completed_at: data.completed_at,
      payload: data.payload,
      chain_id: data.chain_id,
      safe_tx_hash: data.safe_tx_hash,
      tx_hash: data.tx_hash,
      error_code: data.error_code,
      error_message: data.error_message,
      source_job_id: data.source_job_id,
      created_at: data.created_at,
      updated_at: data.updated_at,
      execution_strategy: data.execution_strategy,
      idempotency_key: data.idempotency_key,
      safeTxExplorerUrl: data.safe_tx_hash ? getExplorerUrl(data.chain_id, data.safe_tx_hash) : null,
      txExplorerUrl: data.tx_hash ? getExplorerUrl(data.chain_id, data.tx_hash) : null,
    };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response, null, 2)
      }]
    };
  } catch (error: any) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `An unexpected error occurred: ${error.message}`
      }]
    };
  }
}
