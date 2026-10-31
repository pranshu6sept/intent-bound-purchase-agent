'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createAirwallexIssuer } = require('../src/airwallex');
const { createAuditLog } = require('../src/auditLog');

const INPUT = {
  vendor: 'Acme Analytics',
  availableCash: 60000,
  reserveFloor: 20000,
  annualCost: 28000,
  monthlyCost: 2800,
  monthlyOverhead: 100,
  purchaseIntent: 'strategic'
};

let server;
let baseUrl;
let auditEntries;

before(async () => {
  auditEntries = [];
  const auditLog = { record: (entry) => auditEntries.push(entry), list: ({ limit = 50 } = {}) => auditEntries.slice(-limit).reverse() };
  const intentExtractor = {
    mode: 'unavailable',
    mockReason: 'No GROQ_API_KEY configured. Fill in the purchase form by hand instead.',
    extract: async () => {
      const error = new Error('No GROQ_API_KEY configured.');
      error.code = 'unavailable';
      throw error;
    }
  };
  const app = createApp({ issuer: createAirwallexIssuer({ env: {} }), auditLog, intentExtractor });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

test('GET /api/health reports the issuer mode', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'intent-bound-purchase-agent', issuerMode: 'mock' });
});

test('GET /api/config exposes the intents for the UI', async () => {
  const body = await (await fetch(`${baseUrl}/api/config`)).json();
  assert.deepEqual(Object.keys(body.intents), ['strategic', 'urgent', 'noncritical']);
});

test('POST /api/recommendation returns a decision with policy checks', async () => {
  const response = await post('/api/recommendation', INPUT);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.recommendation, 'annual');
  assert.equal(body.checks.length, 3);
});

test('POST /api/recommendation rejects invalid input with field details', async () => {
  const response = await post('/api/recommendation', { ...INPUT, annualCost: 'abc' });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, 'invalid_input');
  assert.deepEqual(body.details.map((detail) => detail.field), ['annualCost']);
});

test('malformed JSON gets a JSON 400, not an HTML error page', async () => {
  const response = await post('/api/recommendation', '{"availableCash":');
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_json');
});

test('POST /api/virtual-card issues a card bound to the approved plan', async () => {
  const response = await post('/api/virtual-card', INPUT);
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.evaluation.recommendation, 'annual');
  assert.equal(body.card.mode, 'mock');
  assert.deepEqual(body.card.request.authorization_controls.transaction_limits.limits, [
    { amount: 28000, interval: 'ALL_TIME' }
  ]);
});

test('POST /api/virtual-card refuses to issue a card for a blocked purchase', async () => {
  const response = await post('/api/virtual-card', { ...INPUT, availableCash: 20500 });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error, 'policy_blocked');
  assert.equal(body.evaluation.recommendation, 'blocked');
  assert.equal(body.card, undefined);
});

test('POST /api/virtual-card records the decision to the audit log', async () => {
  auditEntries.length = 0;
  await post('/api/virtual-card', INPUT);
  const log = await (await fetch(`${baseUrl}/api/audit-log`)).json();
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].type, 'card_issued');
  assert.equal(log.entries[0].vendor, 'Acme Analytics');
});

test('GET /api/audit-log returns the most recent entries first', async () => {
  auditEntries.length = 0;
  await post('/api/virtual-card', INPUT);
  await post('/api/virtual-card', { ...INPUT, availableCash: 20500 }); // blocked
  const log = await (await fetch(`${baseUrl}/api/audit-log`)).json();
  assert.equal(log.entries.length, 2);
  assert.equal(log.entries[0].type, 'blocked');
  assert.equal(log.entries[1].type, 'card_issued');
});

test('POST /api/extract-purchase reports 503 when no API key is configured', async () => {
  const response = await post('/api/extract-purchase', { text: 'Buy Acme Analytics, $28k annual.' });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, 'extractor_unavailable');
});

test('POST /api/extract-purchase rejects empty text', async () => {
  const response = await post('/api/extract-purchase', { text: '  ' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_input');
});

test('unknown API routes return JSON 404 while other paths serve the app', async () => {
  const apiResponse = await fetch(`${baseUrl}/api/nope`);
  assert.equal(apiResponse.status, 404);
  assert.equal((await apiResponse.json()).error, 'not_found');

  const pageResponse = await fetch(`${baseUrl}/some/page`);
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /Intent-Bound Purchase Agent/);
});
