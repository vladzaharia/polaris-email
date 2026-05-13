# D1 + Durable Objects spike

```bash
cd scripts/spike/d1-do-spike
wrangler d1 create polaris-spike-control
wrangler d1 create polaris-spike-messages
# Edit wrangler.toml with the database_ids returned above.
wrangler deploy
curl https://polaris-d1-do-spike.<your-subdomain>.workers.dev
```

Cleanup:
```bash
wrangler d1 delete polaris-spike-control
wrangler d1 delete polaris-spike-messages
wrangler delete --name polaris-d1-do-spike
```
