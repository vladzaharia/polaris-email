// Re-export the unified pipeline so existing in-tree imports keep working.
// Implementation lives in `@polaris-email/pipeline` so both services/api and
// services/in can call the same function.
export {
  processMessage,
  ProcessMessageError,
  type ProcessMessageArgs,
  type ProcessMessageResult,
  type FanoutEnqueue,
  type OutboundQueueMessage,
} from '@polaris-email/pipeline';
