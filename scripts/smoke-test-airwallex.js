'use strict';

// Standalone check that real Airwallex sandbox credentials actually work end to
// end (login -> delegate cardholder -> create card), outside the app and tests.
// Run with: npm run smoke:airwallex

require('dotenv').config();
const { createAirwallexIssuer } = require('../src/airwallex');

function airwallexTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, '+0000');
}

const TEST_CARD_POLICY = {
  vendor: 'Smoke Test Vendor',
  summary: 'Smoke-test card: $1.00 single-use, valid 1 day.',
  authorization_controls: {
    allowed_transaction_count: 'SINGLE',
    transaction_limits: { currency: 'USD', limits: [{ amount: 1, interval: 'ALL_TIME' }] },
    allowed_merchant_categories: ['5734', '5817', '5818', '7372'],
    active_from: airwallexTimestamp(new Date()),
    active_to: airwallexTimestamp(new Date(Date.now() + 24 * 60 * 60_000))
  }
};

async function main() {
  const issuer = createAirwallexIssuer();
  console.log(`Issuer mode: ${issuer.mode}`);

  if (issuer.mode !== 'sandbox') {
    console.error(`\nNot configured for sandbox calls: ${issuer.mockReason}`);
    console.error('Set AWX_CLIENT_ID and AWX_API_KEY in .env (sandbox credentials), then re-run.');
    process.exitCode = 1;
    return;
  }

  console.log('Calling Airwallex sandbox: login -> cardholder -> create card...\n');
  const card = await issuer.issueCard(TEST_CARD_POLICY);

  if (card.mode === 'sandbox') {
    console.log('Sandbox round-trip succeeded.');
    console.log(`  card_id:       ${card.card_id}`);
    console.log(`  card_status:   ${card.card_status}`);
    console.log(`  cardholder_id: ${card.cardholder_id}`);
    console.log(`  request_id:    ${card.request.request_id}`);
    process.exitCode = 0;
    return;
  }

  console.error('Sandbox call failed and fell back to a mock card.');
  console.error(`  Reason: ${card.fallbackReason}\n`);
  console.error('Troubleshooting, based on which call the reason names:');
  console.error('  /authentication/login      -> AWX_CLIENT_ID / AWX_API_KEY are wrong, or not sandbox credentials.');
  console.error('  /issuing/cardholders/create -> the API key may lack Issuing permissions, or AWX_CARDHOLDER_EMAIL is invalid.');
  console.error('  /issuing/cards/create       -> CARD_PROGRAM in src/airwallex.js may not match your account\'s provisioned program.');
  process.exitCode = 1;
}

main().catch((error) => {
  console.error('Unexpected error running the smoke test:', error);
  process.exitCode = 1;
});
