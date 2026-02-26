/**
 * Delivery payload: structure output, telemetry, PR URL for IPFS registry
 */

import type { AgentExecutionResult, IpfsMetadata, RecognitionPhaseResult, ReflectionResult } from '../types.js';
import type { MeasurementCoverage } from '../execution/measurementCoverage.js';
import type { Provenance } from '../../shared/adw/types.js';

/**
 * Build execution provenance metadata from available params.
 * Returns an ADW Provenance object for embedding in artifacts.
 */
function buildExecutionProvenance(params: {
  requestId: string;
  metadata: IpfsMetadata;
  workerAddress?: string;
  durationMs?: number;
}): Provenance {
  const { requestId, metadata, workerAddress, durationMs } = params;

  const provenance: Provenance = {
    method: 'agent-execution',
    execution: {
      requestId,
      ...(workerAddress ? { agent: `eip155:8453:${workerAddress}` } : {}),
      ...(metadata.blueprint ? { blueprint: metadata.blueprint } : {}),
      ...(metadata.enabledTools ? { tools: metadata.enabledTools } : {}),
      chain: 'eip155:8453',
      timestamp: new Date().toISOString(),
      ...(durationMs ? { duration: `PT${Math.round(durationMs / 1000)}S` } : {}),
    },
    derivedFrom: [],
  };

  // Add blueprint as a derivedFrom source if present
  if (metadata.blueprint) {
    provenance.derivedFrom!.push({
      contentHash: metadata.blueprint,
      relationship: 'blueprint',
      description: 'Blueprint that defined the execution constraints',
    });
  }

  // Add template reference if present
  if (metadata.templateId) {
    provenance.derivedFrom!.push({
      contentHash: metadata.templateId,
      relationship: 'template',
      description: 'Template that structured the workflow',
    });
  }

  // Clean up empty derivedFrom
  if (provenance.derivedFrom!.length === 0) {
    delete provenance.derivedFrom;
  }

  return provenance;
}

/**
 * Build delivery payload for IPFS registry
 */
export function buildDeliveryPayload(params: {
  requestId: string;
  result: AgentExecutionResult;
  metadata: IpfsMetadata;
  recognition?: RecognitionPhaseResult | null;
  reflection?: ReflectionResult | null;
  workerTelemetry?: any;
  finalStatus?: { status: string; message?: string };
  measurementCoverage?: MeasurementCoverage | null;
}): any {
  const { requestId, result, metadata, recognition, reflection, workerTelemetry, finalStatus, measurementCoverage } = params;

  // Build execution provenance from available data
  const workerAddress = process.env.JINN_SERVICE_MECH_ADDRESS;
  const durationMs = result.telemetry?.durationMs || workerTelemetry?.durationMs;
  const provenance = buildExecutionProvenance({ requestId, metadata, workerAddress, durationMs });

  // Enrich artifacts with provenance metadata
  const artifacts = (result.artifacts || []).map((artifact) => ({
    ...artifact,
    provenance,
  }));

  return {
    requestId: String(requestId),
    output: result.output || '',
    structuredSummary: result.structuredSummary || result.output?.slice(-1200) || '',
    telemetry: result.telemetry || {},
    artifacts,
    provenance,
    ...(result.jobInstanceStatusUpdate ? { jobInstanceStatusUpdate: result.jobInstanceStatusUpdate } : {}),
    ...(metadata?.jobDefinitionId ? { jobDefinitionId: metadata.jobDefinitionId } : {}),
    ...(metadata?.jobName ? { jobName: metadata.jobName } : {}),
    ...(metadata?.blueprint ? { blueprint: metadata.blueprint } : {}),
    // Template passthrough: include templateId and outputSpec so x402 gateway can use them directly
    ...(metadata?.templateId ? { templateId: metadata.templateId } : {}),
    ...(metadata?.outputSpec ? { outputSpec: metadata.outputSpec } : {}),
    ...(finalStatus ? { status: finalStatus.status, statusMessage: finalStatus.message } : {}),
    ...(workerTelemetry ? { workerTelemetry } : {}),
    ...(measurementCoverage ? { measurementCoverage } : {}),
    ...(recognition
      ? {
        recognition: {
          initialSituation: recognition.initialSituation,
          embeddingStatus: recognition.embeddingStatus,
          similarJobs: recognition.similarJobs,
          learnings: recognition.rawLearnings,
          learningsMarkdown: recognition.learningsMarkdown,
          searchQuery: recognition.searchQuery,
          progressCheckpoint: recognition.progressCheckpoint,
        },
      }
      : {}),
    ...(reflection
      ? {
        reflection: {
          output: reflection.output,
          telemetry: reflection.telemetry,
        },
      }
      : {}),
    ...(result.pullRequestUrl ? { pullRequestUrl: result.pullRequestUrl } : {}),
    ...(metadata?.codeMetadata?.branch?.name
      ? {
        executionPolicy: {
          branch: metadata.codeMetadata.branch.name,
          ensureTestsPass: true,
          description: 'Agent executed work on the provided branch and passed required validations.',
        },
      }
      : {}),
  };
}
