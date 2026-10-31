'use strict';

// End-to-end walkthrough of the brief's sequence:
//   1. Create/reuse a cardholder
//   2. Compare two quotes (annual vs monthly) against cash + policy, issue a card
//      whose authorization_controls match the decision
//   3. Simulate an over-limit authorization -> expect it to decline
//   4. Simulate an at-limit authorization -> expect it to clear
//   5. Fetch the card's limits back from Airwallex to confirm they match
//
// Works in both sandbox mode (real Airwallex calls) and mock mode (no credentials),
// so it also doubles as a dry run. Run with: npm run demo:authorizations

require('dotenv').config();
const { evaluatePurchase, buildCardPolicy } = require('../src/policyEngine');
const { createAirwallexIssuer } = require('../src/airwallex');

const PURCHASE = {
  vendor: 'Acme Analytics',
  availableCash: 60000,
  reserveFloor: 20000,
  annualCost: 28000,
  monthlyCost: 2800,
  monthlyOverhead: 100,
  purchaseIntent: 'strategic'
};

function printResult(label, result, expected) {
  const passed = expected(result);
  console.log(`${passed ? 'PASS' : 'FAIL'} - ${label}`);
  console.log(`  status: ${result.status}  transaction_type: ${result.transaction_type}  failure_reason: ${result.failure_reason}`);
  if (result.fallbackReason) console.log(`  (fallback: ${result.fallbackReason})`);
  return passed;
}

async function main() {
  const issuer = createAirwallexIssuer();
  console.log(`Issuer mode: ${issuer.mode}${issuer.mockReason ? ` (${issuer.mockReason})` : ''}\n`);

  console.log('1-2. Comparing two quotes against cash + policy, then issuing a card for the decision...');
  const evaluation = evaluatePurchase(PURCHASE);
  console.log(`  decision: ${evaluation.recommendation} - ${evaluation.reason}\n`);

  const cardPolicy = buildCardPolicy(evaluation);
  if (!cardPolicy) {
    console.error('Purchase was blocked; nothing to issue a card for. Adjust PURCHASE and re-run.');
    process.exitCode = 1;
    return;
  }

  const card = await issuer.issueCard(cardPolicy);
  console.log(`  card_id: ${card.card_id}  mode: ${card.mode}`);
  if (card.fallbackReason) console.log(`  (fallback: ${card.fallbackReason})`);

  const limits = cardPolicy.authorization_controls.transaction_limits.limits;
  const limitAmount = (limits.find((l) => l.interval === 'ALL_TIME') || limits[0]).amount;
  const currency = cardPolicy.authorization_controls.transaction_limits.currency;
  console.log(`  configured limit: ${currency} ${limitAmount}\n`);

  console.log('3. Simulating an over-limit authorization (should decline)...');
  const overLimit = await issuer.simulateAuthorization({
    cardId: card.card_id,
    amount: limitAmount + 1,
    currency,
    limitAmount
  });
  const overLimitPassed = printResult('over-limit authorization declines', overLimit, (r) => r.status === 'FAILED');
  console.log();

  console.log('4. Simulating an at-limit authorization (should clear - the limit is inclusive)...');
  const atLimit = await issuer.simulateAuthorization({
    cardId: card.card_id,
    amount: limitAmount,
    currency,
    limitAmount
  });
  const atLimitPassed = printResult('at-limit authorization clears', atLimit, (r) => r.transaction_type === 'CLEARING' || r.status === 'APPROVED');
  console.log();

  console.log('5. Fetching the card limits back from Airwallex...');
  const fetchedLimits = await issuer.getCardLimits(card.card_id);
  console.log(`  mode: ${fetchedLimits.mode}`);
  console.log(`  limits: ${JSON.stringify(fetchedLimits.limits)}`);
  if (fetchedLimits.fallbackReason) console.log(`  (fallback: ${fetchedLimits.fallbackReason})`);

  process.exitCode = overLimitPassed && atLimitPassed ? 0 : 1;
}

main().catch((error) => {
  console.error('Unexpected error running the demo:', error);
  process.exitCode = 1;
});
