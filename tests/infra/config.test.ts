import { App } from 'aws-cdk-lib';

import { DEFAULT_MONTHLY_LIMIT_USD, readConfig } from '../../infra/lib/config';
import { cdkJsonContext } from './cdk-context';

function configFor(context: Record<string, unknown>) {
  return readConfig(new App({ context: cdkJsonContext(context) }).node, {});
}

describe('readConfig', () => {
  it('leaves budgetEmail undefined when context is absent or empty', () => {
    expect(configFor({}).budgetEmail).toBeUndefined();
    expect(configFor({ budgetEmail: '' }).budgetEmail).toBeUndefined();
  });

  it('trims a valid email', () => {
    expect(configFor({ budgetEmail: '  me@example.com ' }).budgetEmail).toBe('me@example.com');
  });

  it.each(['not-an-email', 42, 'a@', '@example.com'])('rejects budgetEmail %p', (value) => {
    expect(() => configFor({ budgetEmail: value })).toThrow(/budgetEmail/);
  });

  it('defaults the monthly limit to 5 USD', () => {
    expect(DEFAULT_MONTHLY_LIMIT_USD).toBe(5);
    expect(configFor({}).monthlyLimitUsd).toBe(5);
  });

  it.each(['0', '-1', 'abc', '5000'])('rejects budgetLimitUsd %p', (value) => {
    expect(() => configFor({ budgetLimitUsd: value })).toThrow(/budgetLimitUsd/);
  });

  it('reads account and region only when the CDK sets them', () => {
    expect(readConfig(new App({ context: cdkJsonContext() }).node, {}).env).toEqual({});
    expect(
      readConfig(new App({ context: cdkJsonContext() }).node, {
        CDK_DEFAULT_ACCOUNT: '123',
        CDK_DEFAULT_REGION: 'us-east-1',
      }).env,
    ).toEqual({ account: '123', region: 'us-east-1' });
  });
});

describe('alertEmail', () => {
  it('prefers alertEmail, falls back to budgetEmail, else undefined', () => {
    expect(
      configFor({ alertEmail: 'a@example.com', budgetEmail: 'b@example.com' }).alertEmail,
    ).toBe('a@example.com');
    expect(configFor({ budgetEmail: 'b@example.com' }).alertEmail).toBe('b@example.com');
    expect(configFor({}).alertEmail).toBeUndefined();
  });

  it('rejects an invalid alertEmail', () => {
    expect(() => configFor({ alertEmail: 'nope' })).toThrow(/alertEmail/);
  });
});

describe('ingest limits', () => {
  it('are undefined unless set, and validated when set', () => {
    expect(configFor({}).ingestDailyQuota).toBeUndefined();
    expect(configFor({ ingestDailyQuota: '50000', ingestRateLimit: '40' })).toMatchObject({
      ingestDailyQuota: 50000,
      ingestRateLimit: 40,
    });
    expect(() => configFor({ ingestDailyQuota: '5' })).toThrow(/ingestDailyQuota/);
    expect(() => configFor({ ingestRateLimit: 'fast' })).toThrow(/ingestRateLimit/);
  });
});
