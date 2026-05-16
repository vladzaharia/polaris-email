// W6 — DMARC RUA aggregate report parser (RFC 7489 §7).
//
// The payload is XML, gzip-compressed by every major provider (Gmail,
// Yahoo, Microsoft, ProtonMail). Schema:
//
//   <feedback>
//     <report_metadata>
//       <org_name>...</org_name>
//       <email>...</email>
//       <report_id>...</report_id>
//       <date_range><begin>...</begin><end>...</end></date_range>
//     </report_metadata>
//     <policy_published>
//       <domain>...</domain>
//       <adkim>r|s</adkim>
//       <aspf>r|s</aspf>
//       <p>none|quarantine|reject</p>
//       <sp>none|quarantine|reject</sp>
//       <pct>0..100</pct>
//     </policy_published>
//     <record>
//       <row>
//         <source_ip>...</source_ip>
//         <count>N</count>
//         <policy_evaluated>
//           <disposition>none|quarantine|reject</disposition>
//           <dkim>pass|fail</dkim>
//           <spf>pass|fail</spf>
//         </policy_evaluated>
//       </row>
//       <identifiers><header_from>...</header_from></identifiers>
//       <auth_results>
//         <dkim><domain>...</domain><result>pass|fail</result></dkim>
//         <spf><domain>...</domain><result>pass|fail</result></spf>
//       </auth_results>
//     </record>
//     ... (more records)
//   </feedback>
//
// Parser is tolerant of element order, missing fields, and the rare ZIP
// archive wrapper (we don't unzip ZIP — only gzip; ZIP is a documented
// follow-up if we see one in the wild).

export interface DmarcRecord {
  sourceIp: string | null;
  count: number;
  disposition: string | null;
  dkimEvaluated: string | null;
  spfEvaluated: string | null;
  headerFrom: string | null;
  dkimAuthDomain: string | null;
  dkimAuthResult: string | null;
  spfAuthDomain: string | null;
  spfAuthResult: string | null;
}

export interface DmarcReport {
  orgName: string | null;
  orgEmail: string | null;
  reportId: string | null;
  dateRangeBegin: string | null; // ISO
  dateRangeEnd: string | null; // ISO
  policyDomain: string | null;
  policyP: string | null;
  policySp: string | null;
  policyPct: number | null;
  policyAdkim: string | null;
  policyAspf: string | null;
  records: DmarcRecord[];
  totalCount: number;
  totalDmarcPass: number;
  totalDkimPass: number;
  totalSpfPass: number;
}

// Tiny XML reader — we don't need attributes, namespaces, or DTDs, and
// DMARC reports are well-shaped enough to walk with element-text grabbers
// and one element-iterator.

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Find the next properly-delimited `<tag>` open from `pos`, where "properly
// delimited" means the character after the tag name is `>` or a whitespace
// (so `<p` doesn't false-match `<policy_published`).
function findOpenAt(xml: string, tag: string, pos: number): number {
  const needle = `<${tag}`;
  let cursor = pos;
  while (true) {
    const i = xml.indexOf(needle, cursor);
    if (i < 0) return -1;
    const next = xml.charCodeAt(i + needle.length);
    // 32=space, 9=tab, 10=LF, 13=CR, 62=`>`
    if (next === 32 || next === 9 || next === 10 || next === 13 || next === 62) return i;
    cursor = i + 1;
  }
}

/** Return the text content of the first <tag>...</tag> inside `xml`, or null. */
function firstTagText(xml: string, tag: string): string | null {
  const close = `</${tag}>`;
  const start = findOpenAt(xml, tag, 0);
  if (start < 0) return null;
  const openEnd = xml.indexOf('>', start);
  if (openEnd < 0) return null;
  const end = xml.indexOf(close, openEnd);
  if (end < 0) return null;
  return decodeEntities(xml.slice(openEnd + 1, end).trim());
}

/** Yield each <tag>...</tag> block (inner content) from xml in order. */
function* iterTagBlocks(xml: string, tag: string): IterableIterator<string> {
  const close = `</${tag}>`;
  let pos = 0;
  while (true) {
    const start = findOpenAt(xml, tag, pos);
    if (start < 0) return;
    const openEnd = xml.indexOf('>', start);
    if (openEnd < 0) return;
    const end = xml.indexOf(close, openEnd);
    if (end < 0) return;
    yield xml.slice(openEnd + 1, end);
    pos = end + close.length;
  }
}

function epochToIso(s: string | null): string | null {
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

export function parseDmarcReportXml(xml: string): DmarcReport {
  const metadata = firstTagText(xml, 'report_metadata') ?? '';
  // metadata can be a block of XML; pull subfields out of `xml` directly
  // because firstTagText decodes entities — we want unescaped XML here.
  const metaBlockStart = xml.indexOf('<report_metadata');
  const metaBlockEnd = xml.indexOf('</report_metadata>');
  const metaBlock =
    metaBlockStart >= 0 && metaBlockEnd > metaBlockStart
      ? xml.slice(metaBlockStart, metaBlockEnd + '</report_metadata>'.length)
      : metadata;
  const dateRangeStart = xml.indexOf('<date_range');
  const dateRangeEnd = xml.indexOf('</date_range>');
  const dateRangeBlock =
    dateRangeStart >= 0 && dateRangeEnd > dateRangeStart
      ? xml.slice(dateRangeStart, dateRangeEnd + '</date_range>'.length)
      : '';
  const policyBlock = (() => {
    const a = xml.indexOf('<policy_published');
    const b = xml.indexOf('</policy_published>');
    return a >= 0 && b > a ? xml.slice(a, b + '</policy_published>'.length) : '';
  })();

  const records: DmarcRecord[] = [];
  let totalCount = 0;
  let totalDmarcPass = 0;
  let totalDkimPass = 0;
  let totalSpfPass = 0;
  for (const recBlock of iterTagBlocks(xml, 'record')) {
    const sourceIp = firstTagText(recBlock, 'source_ip');
    const count = Number(firstTagText(recBlock, 'count') ?? '0') || 0;
    const disposition = firstTagText(recBlock, 'disposition');
    const dkimEvaluated = firstTagText(recBlock, 'dkim');
    const spfEvaluated = firstTagText(recBlock, 'spf');
    const headerFrom = firstTagText(recBlock, 'header_from');
    // auth_results contains separate <dkim>/<spf> blocks; iterate each.
    let dkimAuthDomain: string | null = null;
    let dkimAuthResult: string | null = null;
    let spfAuthDomain: string | null = null;
    let spfAuthResult: string | null = null;
    const authBlock = (() => {
      const a = recBlock.indexOf('<auth_results');
      const b = recBlock.indexOf('</auth_results>');
      return a >= 0 && b > a ? recBlock.slice(a, b + '</auth_results>'.length) : '';
    })();
    for (const dkimChunk of iterTagBlocks(authBlock, 'dkim')) {
      dkimAuthDomain = firstTagText(dkimChunk, 'domain');
      dkimAuthResult = firstTagText(dkimChunk, 'result');
      break;
    }
    for (const spfChunk of iterTagBlocks(authBlock, 'spf')) {
      spfAuthDomain = firstTagText(spfChunk, 'domain');
      spfAuthResult = firstTagText(spfChunk, 'result');
      break;
    }
    records.push({
      sourceIp,
      count,
      disposition,
      dkimEvaluated,
      spfEvaluated,
      headerFrom,
      dkimAuthDomain,
      dkimAuthResult,
      spfAuthDomain,
      spfAuthResult,
    });
    totalCount += count;
    if (disposition === 'none' && dkimEvaluated === 'pass') totalDmarcPass += count;
    else if (disposition === 'none' && spfEvaluated === 'pass') totalDmarcPass += count;
    if (dkimEvaluated === 'pass') totalDkimPass += count;
    if (spfEvaluated === 'pass') totalSpfPass += count;
  }

  return {
    orgName: firstTagText(metaBlock, 'org_name'),
    orgEmail: firstTagText(metaBlock, 'email'),
    reportId: firstTagText(metaBlock, 'report_id'),
    dateRangeBegin: epochToIso(firstTagText(dateRangeBlock, 'begin')),
    dateRangeEnd: epochToIso(firstTagText(dateRangeBlock, 'end')),
    policyDomain: firstTagText(policyBlock, 'domain'),
    policyP: firstTagText(policyBlock, 'p'),
    policySp: firstTagText(policyBlock, 'sp'),
    policyPct: (() => {
      const v = firstTagText(policyBlock, 'pct');
      return v ? Number(v) || null : null;
    })(),
    policyAdkim: firstTagText(policyBlock, 'adkim'),
    policyAspf: firstTagText(policyBlock, 'aspf'),
    records,
    totalCount,
    totalDmarcPass,
    totalDkimPass,
    totalSpfPass,
  };
}

export async function gunzipUtf8(gzipped: Uint8Array): Promise<string> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(gzipped);
      controller.close();
    },
  });
  const stream = source.pipeThrough(
    new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  );
  const decompressed = await new Response(stream).arrayBuffer();
  return new TextDecoder('utf-8').decode(decompressed);
}

export async function parseGzippedDmarcReport(gzipped: Uint8Array): Promise<DmarcReport> {
  const xml = await gunzipUtf8(gzipped);
  return parseDmarcReportXml(xml);
}
