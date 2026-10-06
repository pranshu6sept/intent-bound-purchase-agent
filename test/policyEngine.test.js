'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePurchaseInput, evaluatePurchase, buildCardPolicy } = require('../src/policyEngine');

const NOW = new Date('2026-10-06T12:00:00Z');

function evaluate(overrides = {}) {
  const { value, errors } = validatePurchaseInput({
    vendor: 'Acme Analytics',
    availableCash: 60000,
    reserveFloor: 20000,
    annualCost: 28000,
    monthlyCost: 2800,
    monthlyOverhead: 100,
    purchaseIntent: 'strategic',
    ...overrides
  });
  assert.deepEqual(errors, []);
  return evaluatePurchase(value, { now: NOW });
}

test('recommends annual when it is safe and cheaper', () => {
  const result = evaluate();
  assert.equal(result.recommendation, 'annual');
  assert.equal(result.annual.cashAfterPurchase, 32000);
  assert.equal(result.annual.headroom, 12000);
  assert.equal(result.monthly.twelveMonthCost, 34800);
  assert.equal(result.savings.amount, 6800);
  assert.ok(result.checks.every((check) => check.status === 'pass'));
});

test('treats annual as cheaper when 12 monthly payments cost more (savings sign)', () => {
  const result = evaluate({ monthlyCost: 5500, monthlyOverhead: 0 });
  assert.equal(result.savings.amount, 38000);
  assert.equal(result.recommendation, 'annual');
});

test('falls back to monthly when annual breaches the reserve floor', () => {
  const result = evaluate({ availableCash: 45000 });
  assert.equal(result.recommendation, 'monthly');
  assert.equal(result.annual.withinPolicy, false);
  assert.equal(result.monthly.cashAfterPurchase, 42100);
  assert.match(result.reason, /below the reserve floor/);
});

test('picks monthly when annual is not cheaper', () => {
  const result = evaluate({ annualCost: 40000 });
  assert.equal(result.recommendation, 'monthly');
  assert.match(result.reason, /not cheaper/);
});

test('counts monthly overhead in the 12-month comparison', () => {
  // 12 x 2,300 = 27,600 < 28,000, but overhead makes it 12 x 2,400 = 28,800.
  assert.equal(evaluate({ monthlyCost: 2300, monthlyOverhead: 0 }).recommendation, 'monthly');
  assert.equal(evaluate({ monthlyCost: 2300, monthlyOverhead: 100 }).recommendation, 'annual');
});

test('urgent intent needs at least 20% savings before committing to annual', () => {
  const result = evaluate({ purchaseIntent: 'urgent' });
  assert.equal(result.savings.pct, 0.1954);
  assert.equal(result.recommendation, 'monthly');
  assert.match(result.reason, /only 19\.5%/);

  assert.equal(evaluate({ purchaseIntent: 'urgent', annualCost: 25000 }).recommendation, 'annual');
});

test('non-critical intent requires a 25% cushion above the reserve floor', () => {
  assert.equal(evaluate({ availableCash: 24000 }).recommendation, 'monthly');

  const result = evaluate({ availableCash: 24000, purchaseIntent: 'noncritical' });
  assert.equal(result.policy.requiredCash, 25000);
  assert.equal(result.recommendation, 'blocked');
});

test('blocks the purchase when both plans breach the reserve floor', () => {
  const result = evaluate({ availableCash: 20500 });
  assert.equal(result.recommendation, 'blocked');
  assert.match(result.reason, /will not issue a card/);
  assert.equal(buildCardPolicy(result, { now: NOW }), null);
});

test('annual card is single-use, capped at the exact price, valid for 30 days', () => {
  const policy = buildCardPolicy(evaluate(), { now: NOW });
  assert.deepEqual(policy.authorization_controls, {
    allowed_transaction_count: 'SINGLE',
    transaction_limits: { currency: 'USD', limits: [{ amount: 28000, interval: 'ALL_TIME' }] },
    allowed_merchant_categories: ['5734', '5817', '5818', '7372'],
    active_from: '2026-10-06T12:00:00+0000',
    active_to: '2026-11-05T12:00:00+0000'
  });
});

test('monthly card is recurring and capped per charge, per month, and for 12 months', () => {
  const policy = buildCardPolicy(evaluate({ availableCash: 45000 }), { now: NOW });
  const controls = policy.authorization_controls;
  assert.equal(controls.allowed_transaction_count, 'MULTIPLE');
  assert.deepEqual(controls.transaction_limits.limits, [
    { amount: 2800, interval: 'PER_TRANSACTION' },
    { amount: 2800, interval: 'MONTHLY' },
    { amount: 33600, interval: 'ALL_TIME' }
  ]);
  assert.equal(controls.active_to, '2027-10-06T12:00:00+0000');
});

test('validation accepts numeric strings and defaults optional fields', () => {
  const { value, errors } = validatePurchaseInput({
    availableCash: ' 1000.50 ',
    reserveFloor: '0',
    annualCost: 100,
    monthlyCost: '10'
  });
  assert.deepEqual(errors, []);
  assert.equal(value.availableCash, 1000.5);
  assert.equal(value.monthlyOverhead, 0);
  assert.equal(value.purchaseIntent, 'strategic');
  assert.equal(value.vendor, 'SaaS vendor');
});

test('validation reports every bad field', () => {
  const { errors } = validatePurchaseInput({
    availableCash: 'lots',
    reserveFloor: -1,
    annualCost: 0,
    purchaseIntent: 'impulse',
    vendor: 42
  });
  assert.deepEqual(errors.map((error) => error.field), [
    'availableCash',
    'reserveFloor',
    'annualCost',
    'monthlyCost',
    'purchaseIntent',
    'vendor'
  ]);
});

test('validation rejects non-object bodies', () => {
  assert.equal(validatePurchaseInput(null).errors.length, 4);
  assert.equal(validatePurchaseInput([1, 2]).errors.length, 4);
});
