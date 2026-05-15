export {
  parseStrict,
  serialize,
  getHeader,
  setHeader,
  MimeError,
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
  type UnifiedMessage,
  type MessageRowMeta,
  type MessageAttachmentMeta,
  type SendRequestLike,
  type ParsedMimeSummary,
} from './json.js';

export {
  parseAddressList,
  parseFirstAddress,
  decodeMimeWord,
  parseAuthResults,
  type AuthResults,
} from './headers.js';
