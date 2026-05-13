import { describe, expect, it } from 'vitest';
import { deriveTenantPepper, pepperVersionFromMaster } from '../src/pepper.js';

const MASTER = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
const MASTER_ALT = Buffer.from(new Uint8Array(32).fill(11)).toString('base64');

describe('deriveTenantPepper', () => {
  it('is deterministic for same master+tenant', async () => {
    const a = await deriveTenantPepper(MASTER, 'tenant-a');
    const b = await deriveTenantPepper(MASTER, 'tenant-a');
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
    expect(a.length).toBe(32);
  });

  it('differs across tenants', async () => {
    const a = await deriveTenantPepper(MASTER, 'tenant-a');
    const b = await deriveTenantPepper(MASTER, 'tenant-b');
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });

  it('differs across masters', async () => {
    const a = await deriveTenantPepper(MASTER, 'tenant-a');
    const b = await deriveTenantPepper(MASTER_ALT, 'tenant-a');
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });

  it('rejects empty master/tenant', async () => {
    await expect(deriveTenantPepper('', 'x')).rejects.toThrow();
    await expect(deriveTenantPepper(MASTER, '')).rejects.toThrow();
  });
});

describe('pepperVersionFromMaster', () => {
  it('is stable for the same master', () => {
    expect(pepperVersionFromMaster(MASTER)).toBe(pepperVersionFromMaster(MASTER));
  });

  it('differs (likely) for different masters', () => {
    // Not guaranteed, but for these chosen masters it should hold.
    expect(pepperVersionFromMaster(MASTER)).not.toBe(pepperVersionFromMaster(MASTER_ALT));
  });

  it('returns a 16-bit number', () => {
    const v = pepperVersionFromMaster(MASTER);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(0xffff);
  });
});
