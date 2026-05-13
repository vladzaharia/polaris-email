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
