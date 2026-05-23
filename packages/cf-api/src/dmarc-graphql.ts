import type { CloudflareApiClient } from './client.js';
import { graphqlQuery } from './graphql.js';

export interface DmarcAggregateRow {
  day: string;
  domain: string;
  totalCount: number;
  dmarcPass: number;
  dkimPass: number;
  spfPass: number;
}

export interface FetchDmarcAggregatesOpts {
  zoneTag: string;
  since: string;
  until: string;
}

const QUERY = `
query DmarcAggregatesByDay($zoneTag: String!, $since: Time!, $until: Time!) {
  viewer {
    zones(filter: {zoneTag: $zoneTag}) {
      dmarcReportsAdaptive(
        filter: { datetime_geq: $since, datetime_leq: $until }
        orderBy: [dimensions_date_ASC]
        limit: 10000
      ) {
        dimensions { date headerFrom }
        sum {
          totalCount
          dmarcPassedCount
          dkimPassedCount
          spfPassedCount
        }
      }
    }
  }
}
`;

interface RawResponse {
  viewer: {
    zones: Array<{
      dmarcReportsAdaptive: Array<{
        dimensions: { date: string; headerFrom: string };
        sum: {
          totalCount: number;
          dmarcPassedCount: number;
          dkimPassedCount: number;
          spfPassedCount: number;
        };
      }>;
    }>;
  };
}

export async function fetchDmarcAggregatesByDay(
  client: CloudflareApiClient,
  opts: FetchDmarcAggregatesOpts,
): Promise<DmarcAggregateRow[]> {
  const data = await graphqlQuery<RawResponse>(client, {
    query: QUERY,
    variables: { zoneTag: opts.zoneTag, since: opts.since, until: opts.until },
  });
  const zone = data.viewer.zones[0];
  if (!zone) return [];
  return zone.dmarcReportsAdaptive.map((row) => ({
    day: row.dimensions.date,
    domain: row.dimensions.headerFrom,
    totalCount: row.sum.totalCount,
    dmarcPass: row.sum.dmarcPassedCount,
    dkimPass: row.sum.dkimPassedCount,
    spfPass: row.sum.spfPassedCount,
  }));
}
