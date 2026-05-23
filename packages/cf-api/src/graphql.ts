import type { CloudflareApiClient } from './client.js';

export interface GraphqlRequest<V = Record<string, unknown>> {
  query: string;
  variables?: V;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

export async function graphqlQuery<T, V = Record<string, unknown>>(
  client: CloudflareApiClient,
  req: GraphqlRequest<V>,
): Promise<T> {
  const res = await client.fetchImpl(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${client.apiToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query: req.query, variables: req.variables ?? {} }),
  });
  if (!res.ok) {
    throw new Error(`cf graphql ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as GraphqlResponse<T>;
  if (body.errors && body.errors.length > 0) {
    throw new Error(`cf graphql errors: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  if (!body.data) throw new Error('cf graphql: missing data');
  return body.data;
}
