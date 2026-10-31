'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createIntentExtractor } = require('../src/intentExtractor');

function fakeFetch(status, body) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

test('is unavailable without an API key and never calls the network', async () => {
  const { calls, fetchImpl } = fakeFetch(200, {});
  const extractor = createIntentExtractor({ env: {}, fetchImpl });

  assert.equal(extractor.mode, 'unavailable');
  await assert.rejects(() => extractor.extract('Buy Acme for $28k/year'), /GROQ_API_KEY/);
  assert.equal(calls.length, 0);
});

test('sends the text as a forced tool call and returns the extracted fields', async () => {
  const fields = {
    vendor: 'Acme Analytics',
    availableCash: 60000,
    reserveFloor: 20000,
    annualCost: 28000,
    monthlyCost: 2800,
    monthlyOverhead: 100,
    purchaseIntent: 'strategic'
  };
  const chatResponse = {
    choices: [
      {
        message: {
          tool_calls: [{ type: 'function', function: { name: 'extract_purchase', arguments: JSON.stringify(fields) } }]
        }
      }
    ]
  };
  const { calls, fetchImpl } = fakeFetch(200, chatResponse);
  const extractor = createIntentExtractor({ env: { GROQ_API_KEY: 'gsk-test' }, fetchImpl });

  assert.equal(extractor.mode, 'llm');
  const result = await extractor.extract('Acme Analytics: $28k/yr or $2,800/mo + $100 admin. $60k cash, $20k reserve.');

  assert.deepEqual(result, fields);
  assert.equal(calls[0].headers.Authorization, 'Bearer gsk-test');
  assert.equal(calls[0].body.tool_choice.function.name, 'extract_purchase');
});

test('raises an upstream_error when the Groq API call fails', async () => {
  const { fetchImpl } = fakeFetch(401, { error: { message: 'Invalid API Key' } });
  const extractor = createIntentExtractor({ env: { GROQ_API_KEY: 'bad' }, fetchImpl });

  await assert.rejects(() => extractor.extract('Buy Acme for $28k/year'), (error) => {
    assert.equal(error.code, 'upstream_error');
    assert.match(error.message, /Invalid API Key/);
    return true;
  });
});

test('raises extraction_failed when the model returns no tool call', async () => {
  const { fetchImpl } = fakeFetch(200, { choices: [{ message: { content: 'I need more information.' } }] });
  const extractor = createIntentExtractor({ env: { GROQ_API_KEY: 'gsk-test' }, fetchImpl });

  await assert.rejects(() => extractor.extract('not enough detail'), (error) => {
    assert.equal(error.code, 'extraction_failed');
    return true;
  });
});

test('raises extraction_failed when the tool call arguments are not valid JSON', async () => {
  const chatResponse = {
    choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'extract_purchase', arguments: '{not json' } }] } }]
  };
  const { fetchImpl } = fakeFetch(200, chatResponse);
  const extractor = createIntentExtractor({ env: { GROQ_API_KEY: 'gsk-test' }, fetchImpl });

  await assert.rejects(() => extractor.extract('garbled'), (error) => {
    assert.equal(error.code, 'extraction_failed');
    return true;
  });
});
