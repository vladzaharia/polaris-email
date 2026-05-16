export {
  parseStrict,
  serialize,
  getHeader,
  setHeader,
  MimeError,
  TRANSPORT_FORBIDDEN_HEADERS,
  type Header,
  type ParsedMime,
} from './canonicalize.js';

export {
  enforceSenderPolicy,
  extractSingleAddress,
  SenderPolicyError,
  type SenderPolicy,
} from './sender-policy.js';

export {
  normalizeAddress,
  addressesEqual,
  longestSuffixMatch,
  AddressError,
  type NormalizedAddress,
} from './address-norm.js';

export {
  mimeToMessage,
  composeFromJson,
  summarizeMime,
  extractAttachmentParts,
  type UnifiedMessage,
  type MessageRowMeta,
  type MessageAttachmentMeta,
  type SendRequestLike,
  type ParsedMimeSummary,
  type ExtractedAttachment,
} from './json.js';

export {
  parseAddressList,
  parseFirstAddress,
  decodeMimeWord,
  parseAuthResults,
  type AuthResults,
} from './headers.js';

export * from './limits.js';
