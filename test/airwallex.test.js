'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAirwallexIssuer } = require('../src/airwallex');

const CARD_POLICY = {
  authorization_controls: {
    allowed_transaction_count: 'SINGLE',
    transaction_limits: { currency: 'USD', limits: [{ amount: 28000, interval: 'ALL_TIME' }] }
  }
};

const SANDBOX_ENV = {
  AWX_CLIENT_ID: 'client',
  AWX_API_KEY: 'key',
  AWX_BASE_URL: 'https://api.sandbox.airwallex.com/api/v1'
};

const silentLogger = { error() {} };

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname.replace('/api/v1', '');
    calls.push({ path, headers: options.headers, body: JSON.parse(options.body) });
    const [status, body] = routes[path] || [404, { message: 'not found' }];
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

test('uses mock mode without credentials and never calls the network', async () => {
  const { calls, fetchImpl } = fakeFetch({});
  const issuer = createAirwallexIssuer({ env: {}, fetchImpl });

  assert.equal(issuer.mode, 'mock');
  const card = await issuer.issueCard(CARD_POLICY);
  assert.equal(card.mode, 'mock');
  assert.match(card.fallbackReason, /No Airwallex sandbox credentials/);
  assert.deepEqual(card.request.authorization_controls, CARD_POLICY.authorization_controls);
  assert.equal(calls.length, 0);
});

test('refuses non-sandbox endpoints even with credentials', async () => {
  const { calls, fetchImpl } = fakeFetch({});
  const issuer = createAirwallexIssuer({
    env: { ...SANDBOX_ENV, AWX_BASE_URL: 'https://api.airwallex.com/api/v1' },
    fetchImpl
  });

  assert.equal(issuer.mode, 'mock');
  const card = await issuer.issueCard(CARD_POLICY);
  assert.match(card.fallbackReason, /non-sandbox/);
  assert.equal(calls.length, 0);
});

test('logs in once, creates a delegate cardholder once, and issues cards with the policy controls', async () => {
  const { calls, fetchImpl } = fakeFetch({
    '/authentication/login': [201, { token: 'tok', expires_at: new Date(Date.now() + 30 * 60_000).toISOString() }],
    '/issuing/cardholders/create': [201, { cardholder_id: 'ch_1', status: 'READY' }],
    '/issuing/cards/create': [201, { card_id: 'card_1', card_status: 'ACTIVE' }]
  });
  const issuer = createAirwallexIssuer({ env: SANDBOX_ENV, fetchImpl, logger: silentLogger });

  const first = await issuer.issueCard(CARD_POLICY);
  const second = await issuer.issueCard(CARD_POLICY);

  assert.equal(first.mode, 'sandbox');
  assert.equal(first.card_id, 'card_1');
  assert.deepEqual(calls.map((call) => call.path), [
    '/authentication/login',
    '/issuing/cardholders/create',
    '/issuing/cards/create',
    '/issuing/cards/create'
  ]);

  const [login, cardholder, card] = calls;
  assert.equal(login.headers['x-client-id'], 'client');
  assert.equal(login.headers['x-api-key'], 'key');
  assert.equal(cardholder.body.type, 'DELEGATE');
  assert.equal(card.headers.Authorization, 'Bearer tok');
  assert.equal(card.body.cardholder_id, 'ch_1');
  assert.equal(card.body.form_factor, 'VIRTUAL');
  assert.deepEqual(card.body.authorization_controls, CARD_POLICY.authorization_controls);
  assert.notEqual(first.request.request_id, second.request.request_id);
});

test('reuses AWX_CARDHOLDER_ID instead of creating a cardholder', async () => {
  const { calls, fetchImpl } = fakeFetch({
    '/authentication/login': [201, { token: 'tok' }],
    '/issuing/cards/create': [201, { card_id: 'card_1', card_status: 'ACTIVE' }]
  });
  const issuer = createAirwallexIssuer({ env: { ...SANDBOX_ENV, AWX_CARDHOLDER_ID: 'ch_env' }, fetchImpl });

  const card = await issuer.issueCard(CARD_POLICY);
  assert.equal(card.cardholder_id, 'ch_env');
  assert.ok(!calls.some((call) => call.path === '/issuing/cardholders/create'));
});

test('falls back to a mock card and explains why when the sandbox rejects the request', async () => {
  const { fetchImpl } = fakeFetch({
    '/authentication/login': [401, { code: 'credentials_invalid', message: 'Invalid credentials' }]
  });
  const issuer = createAirwallexIssuer({ env: SANDBOX_ENV, fetchImpl, logger: silentLogger });

  const card = await issuer.issueCard(CARD_POLICY);
  assert.equal(card.mode, 'mock');
  assert.match(card.fallbackReason, /Invalid credentials/);
});
