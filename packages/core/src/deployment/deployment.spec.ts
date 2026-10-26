import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_MODES, mayCreateWorkspace, publicSignUpOpen } from './index.js';

describe('deployment modes', () => {
  it('are exactly the two the product ships', () => {
    expect([...DEPLOYMENT_MODES]).toEqual(['multi_tenant', 'single_tenant']);
  });

  it('open public sign-up only on a multi-tenant installation', () => {
    expect(publicSignUpOpen('multi_tenant')).toBe(true);
    expect(publicSignUpOpen('single_tenant')).toBe(false);
  });

  it('let the operator create any number of workspaces on a multi-tenant installation', () => {
    for (const existing of [0, 1, 2, 500])
      expect(mayCreateWorkspace('multi_tenant', existing)).toBe(true);
  });

  it('let the operator create exactly one workspace on a single-tenant installation', () => {
    expect(mayCreateWorkspace('single_tenant', 0)).toBe(true);
    expect(mayCreateWorkspace('single_tenant', 1)).toBe(false);
    expect(mayCreateWorkspace('single_tenant', 2)).toBe(false);
  });
});
