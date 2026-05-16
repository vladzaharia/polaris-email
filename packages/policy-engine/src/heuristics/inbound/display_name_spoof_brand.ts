import { PROTECTED_BRANDS, parseAddress, registrableDomain } from '../helpers.js';
import type { Heuristic } from '../../types.js';

// From: "PayPal Security" <random@gmail.com> — display-name claims a brand
// that doesn't match the From-domain.
export const displayNameSpoofBrand: Heuristic = (input) => {
  const from = parseAddress(input.message.headers['from']);
  if (!from.display_name || !from.domain) return null;
  const display = from.display_name.toLowerCase();
  const fromDomain = registrableDomain(from.domain);
  if (!fromDomain) return null;
  for (const entry of PROTECTED_BRANDS) {
    if (!display.includes(entry.brand)) continue;
    if (entry.domains.includes(fromDomain)) return null;
    return {
      reason_code: 'display_name_spoof_brand',
      score: -5,
      evidence: `Display-name claims "${entry.brand}" but From domain is ${fromDomain}`,
    };
  }
  return null;
};
