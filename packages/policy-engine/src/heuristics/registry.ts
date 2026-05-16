// Heuristic registry — the static lists the engine iterates per direction.
//
// Adding a heuristic is a single PR: drop the file under inbound/ or
// outbound/, register it in the array below, add a Vitest. No plugin
// system. The static array keeps execution order deterministic for tests.

import type { Heuristic } from '../types.js';

// Inbound — auth alignment.
import { authDmarcPass } from './inbound/auth_dmarc_pass.js';
import { authDmarcFail } from './inbound/auth_dmarc_fail.js';
import { authDmarcRejectPolicyFail } from './inbound/auth_dmarc_reject_policy_fail.js';
import { authSpfSoftfail } from './inbound/auth_spf_softfail.js';
import { authDkimFail } from './inbound/auth_dkim_fail.js';
import { dkimAlignedAuthor } from './inbound/dkim_aligned_author.js';

// Inbound — suppression / abuse profile.
import { suppressionRecipient } from './inbound/suppression_recipient.js';
import { inboundSenderBlocked } from './inbound/inbound_sender_blocked.js';
import { senderAbuseTier as inboundSenderAbuseTier } from './inbound/sender_abuse_tier.js';

// Inbound — content heuristics.
import { phishyTermsSubject } from './inbound/phishy_terms_subject.js';
import { urlAnchorMismatch } from './inbound/url_anchor_mismatch.js';
import { displayNameSpoofBrand } from './inbound/display_name_spoof_brand.js';
import { displayNameSpoofInternal } from './inbound/display_name_spoof_internal.js';
import { idnMixedScriptFrom } from './inbound/idn_mixed_script_from.js';
import { idnSkeletonBrandCollision } from './inbound/idn_skeleton_brand_collision.js';
import { typosquatLevenshtein2Brand } from './inbound/typosquat_levenshtein_2_brand.js';
import { replyToDomainMismatch } from './inbound/reply_to_domain_mismatch.js';
import { firstContactFinancialIntent } from './inbound/first_contact_financial_intent.js';
import { forgedRecipients } from './inbound/forged_recipients.js';
import { attachmentExecutable as inboundAttachmentExecutable } from './inbound/attachment_executable.js';
import { attachmentDoubleExtension as inboundAttachmentDoubleExtension } from './inbound/attachment_double_extension.js';
import { attachmentMacroOffice as inboundAttachmentMacroOffice } from './inbound/attachment_macro_office.js';
import { mimeHtmlOnlyNoText } from './inbound/mime_html_only_no_text.js';
import { headerReceivedCount } from './inbound/header_received_count.js';
import { headerMessageIdSane } from './inbound/header_message_id_sane.js';
import { headerMessageIdMissing } from './inbound/header_message_id_missing.js';
import { headerInvalidDate } from './inbound/header_invalid_date.js';
import { listIdPresent } from './inbound/list_id_present.js';
import { listUnsubPresent } from './inbound/list_unsub_present.js';

// Outbound.
import { suppressionRecipient as outboundSuppressionRecipient } from './outbound/suppression_recipient.js';
import { suppressionSender } from './outbound/suppression_sender.js';
import { senderAbuseTier as outboundSenderAbuseTier } from './outbound/sender_abuse_tier.js';
import { streamMarketingNoUnsub } from './outbound/stream_marketing_no_unsub.js';
import { phishyTermsSubject as outboundPhishyTermsSubject } from './outbound/phishy_terms_subject.js';
import { displayNameSpoofBrand as outboundDisplayNameSpoofBrand } from './outbound/display_name_spoof_brand.js';
import { urlAnchorMismatch as outboundUrlAnchorMismatch } from './outbound/url_anchor_mismatch.js';
import { recipientRoleAccount } from './outbound/recipient_role_account.js';
import { attachmentExecutable as outboundAttachmentExecutable } from './outbound/attachment_executable.js';
import { attachmentDoubleExtension as outboundAttachmentDoubleExtension } from './outbound/attachment_double_extension.js';
import { attachmentMacroOffice as outboundAttachmentMacroOffice } from './outbound/attachment_macro_office.js';
import { dmarcAlignmentOk } from './outbound/dmarc_alignment_ok.js';
import { dkimSignedPolaris } from './outbound/dkim_signed_polaris.js';
import { agentSelfReplyChain } from './outbound/agent_self_reply_chain.js';

export const INBOUND_HEURISTICS: Heuristic[] = [
  authDmarcPass,
  authDmarcFail,
  authDmarcRejectPolicyFail,
  authSpfSoftfail,
  authDkimFail,
  dkimAlignedAuthor,
  suppressionRecipient,
  inboundSenderBlocked,
  inboundSenderAbuseTier,
  phishyTermsSubject,
  urlAnchorMismatch,
  displayNameSpoofBrand,
  displayNameSpoofInternal,
  idnMixedScriptFrom,
  idnSkeletonBrandCollision,
  typosquatLevenshtein2Brand,
  replyToDomainMismatch,
  firstContactFinancialIntent,
  forgedRecipients,
  inboundAttachmentExecutable,
  inboundAttachmentDoubleExtension,
  inboundAttachmentMacroOffice,
  mimeHtmlOnlyNoText,
  headerReceivedCount,
  headerMessageIdSane,
  headerMessageIdMissing,
  headerInvalidDate,
  listIdPresent,
  listUnsubPresent,
];

export const OUTBOUND_HEURISTICS: Heuristic[] = [
  outboundSuppressionRecipient,
  suppressionSender,
  outboundSenderAbuseTier,
  streamMarketingNoUnsub,
  outboundPhishyTermsSubject,
  outboundDisplayNameSpoofBrand,
  outboundUrlAnchorMismatch,
  recipientRoleAccount,
  outboundAttachmentExecutable,
  outboundAttachmentDoubleExtension,
  outboundAttachmentMacroOffice,
  dmarcAlignmentOk,
  dkimSignedPolaris,
  agentSelfReplyChain,
];
