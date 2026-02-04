/**
 * Delivery payload: structure output, telemetry, PR URL for IPFS registry
 */

import type { AgentExecutionResult, IpfsMetadata, RecognitionPhaseResult, ReflectionResult } from '../types.js';
import type { MeasurementCoverage } from '../execution/measurementCoverage.js';

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

  return {
    requestId: String(requestId),
    output: result.output || '',
    structuredSummary: result.structuredSummary || result.output?.slice(-1200) || '',
    telemetry: result.telemetry || {},
    artifacts: result.artifacts || [],
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

