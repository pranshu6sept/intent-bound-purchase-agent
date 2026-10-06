'use strict';

// Each purchase intent tunes how conservative the agent is. Keeping this as data
// makes the policy easy to explain (and to change) without touching the logic.
const INTENTS = {
  strategic: {
    label: 'Strategic',
    description: 'Core tool with a proven long-term need. Commit to annual whenever it is safe and cheaper.',
    minAnnualSavingsPct: 0,
    reserveBufferPct: 0
  },
  urgent: {
    label: 'Urgent',
    description: 'Needed now, long-term fit unproven. Stay on monthly unless annual saves at least 20%.',
    minAnnualSavingsPct: 0.2,
    reserveBufferPct: 0
  },
  noncritical: {
    label: 'Non-critical',
    description: 'Nice-to-have. Must leave a 25% cushion above the reserve floor; annual needs 10%+ savings.',
    minAnnualSavingsPct: 0.1,
    reserveBufferPct: 0.25
  }
};

// Merchant category codes a SaaS subscription is expected to clear under.
const SAAS_MERCHANT_CATEGORIES = [
  { code: '5734', label: 'Computer software stores' },
  { code: '5817', label: 'Digital goods: applications' },
  { code: '5818', label: 'Digital goods: large merchants' },
  { code: '7372', label: 'Software & data processing services' }
];

const ANNUAL_PURCHASE_WINDOW_DAYS = 30;
const MAX_AMOUNT = 1e12;
const MAX_VENDOR_LENGTH = 80;

const AMOUNT_FIELDS = {
  availableCash: { label: 'Available cash', required: true, positive: false },
  reserveFloor: { label: 'Reserve floor', required: true, positive: false },
  annualCost: { label: 'Annual cost', required: true, positive: true },
  monthlyCost: { label: 'Monthly cost', required: true, positive: true },
  monthlyOverhead: { label: 'Monthly overhead', required: false, positive: false }
};

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function formatMoney(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function formatPct(value) {
  return `${Number((value * 100).toFixed(1))}%`;
}

// Airwallex documents timestamps as e.g. 2018-10-31T00:00:00+0000.
function formatAirwallexTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, '+0000');
}

function validatePurchaseInput(raw) {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const value = {};

  for (const [field, rule] of Object.entries(AMOUNT_FIELDS)) {
    let input = body[field];
    if (typeof input === 'string') input = input.trim();

    if (input === undefined || input === null || input === '') {
      if (rule.required) errors.push({ field, message: `${rule.label} is required.` });
      else value[field] = 0;
      continue;
    }

    const amount = typeof input === 'string' ? Number(input) : input;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      errors.push({ field, message: `${rule.label} must be a number.` });
    } else if (rule.positive ? amount <= 0 : amount < 0) {
      errors.push({ field, message: `${rule.label} must be ${rule.positive ? 'greater than zero' : 'zero or more'}.` });
    } else if (amount > MAX_AMOUNT) {
      errors.push({ field, message: `${rule.label} is unrealistically large.` });
    } else {
      value[field] = roundMoney(amount);
    }
  }

  const intent = body.purchaseIntent ?? 'strategic';
  if (!Object.hasOwn(INTENTS, intent)) {
    errors.push({
      field: 'purchaseIntent',
      message: `Purchase intent must be one of: ${Object.keys(INTENTS).join(', ')}.`
    });
  } else {
    value.purchaseIntent = intent;
  }

  const vendor = body.vendor ?? '';
  if (typeof vendor !== 'string' || vendor.trim().length > MAX_VENDOR_LENGTH) {
    errors.push({ field: 'vendor', message: `Vendor must be text of at most ${MAX_VENDOR_LENGTH} characters.` });
  } else {
    value.vendor = vendor.trim() || 'SaaS vendor';
  }

  return { value, errors };
}

function evaluatePurchase(input, { now = new Date() } = {}) {
  const { availableCash, reserveFloor, annualCost, monthlyCost, monthlyOverhead, purchaseIntent, vendor } = input;
  const intent = INTENTS[purchaseIntent];

  const requiredCash = roundMoney(reserveFloor * (1 + intent.reserveBufferPct));
  const floorLabel = intent.reserveBufferPct > 0
    ? `reserve floor plus a ${formatPct(intent.reserveBufferPct)} cushion (${formatMoney(requiredCash)})`
    : `reserve floor (${formatMoney(requiredCash)})`;

  function describeOption(upfrontCharge, twelveMonthCost) {
    const cashAfterPurchase = roundMoney(availableCash - upfrontCharge);
    return {
      upfrontCharge,
      twelveMonthCost,
      cashAfterPurchase,
      headroom: roundMoney(cashAfterPurchase - requiredCash),
      withinPolicy: cashAfterPurchase >= requiredCash
    };
  }

  const monthlyCharge = roundMoney(monthlyCost + monthlyOverhead);
  const annual = describeOption(annualCost, annualCost);
  const monthly = describeOption(monthlyCharge, roundMoney(monthlyCharge * 12));

  const savings = roundMoney(monthly.twelveMonthCost - annual.twelveMonthCost);
  const savingsPct = savings / monthly.twelveMonthCost;
  const savingsJustifyCommitment = savings > 0 && savingsPct >= intent.minAnnualSavingsPct;

  // If monthly breaches policy but annual does not, annual must cost less than one
  // monthly charge, so it always clears the savings bar and lands in the first branch.
  let recommendation;
  let reason;
  if (annual.withinPolicy && savingsJustifyCommitment) {
    recommendation = 'annual';
    reason = `Annual billing saves ${formatMoney(savings)} (${formatPct(savingsPct)}) over 12 months and still leaves ${formatMoney(annual.headroom)} above the ${floorLabel}.`;
  } else if (monthly.withinPolicy) {
    recommendation = 'monthly';
    if (!annual.withinPolicy) {
      reason = `Paying ${formatMoney(annualCost)} upfront would leave ${formatMoney(annual.cashAfterPurchase)}, below the ${floorLabel}. Monthly billing keeps ${formatMoney(monthly.headroom)} of headroom.`;
    } else if (savings <= 0) {
      reason = `Annual billing is not cheaper than 12 monthly payments, so monthly keeps the same tool with more flexibility.`;
    } else {
      reason = `Annual saves only ${formatPct(savingsPct)}, below the ${formatPct(intent.minAnnualSavingsPct)} needed to justify a 12-month commitment for ${intent.label.toLowerCase()} purchases.`;
    }
  } else {
    recommendation = 'blocked';
    reason = `Both plans would push cash below the ${floorLabel}. The agent will not issue a card for this purchase.`;
  }

  const checks = [
    {
      id: 'annual-reserve',
      label: 'Annual plan keeps cash above the required floor',
      status: annual.withinPolicy ? 'pass' : 'fail',
      detail: `${formatMoney(annual.cashAfterPurchase)} left after paying ${formatMoney(annualCost)} upfront; ${formatMoney(requiredCash)} required.`
    },
    {
      id: 'monthly-reserve',
      label: 'Monthly plan keeps cash above the required floor',
      status: monthly.withinPolicy ? 'pass' : 'fail',
      detail: `${formatMoney(monthly.cashAfterPurchase)} left after the first ${formatMoney(monthlyCharge)} charge; ${formatMoney(requiredCash)} required.`
    },
    {
      id: 'annual-savings',
      label: 'Annual savings justify a 12-month commitment',
      status: savingsJustifyCommitment ? 'pass' : 'fail',
      detail: savings > 0
        ? `Saves ${formatMoney(savings)} (${formatPct(savingsPct)}) vs 12 monthly payments; ${intent.label.toLowerCase()} intent requires ${intent.minAnnualSavingsPct > 0 ? `at least ${formatPct(intent.minAnnualSavingsPct)}` : 'any saving'}.`
        : `Costs ${formatMoney(-savings)} more than 12 monthly payments.`
    }
  ];

  return {
    recommendation,
    reason,
    vendor,
    intent: { key: purchaseIntent, ...intent },
    policy: { availableCash, reserveFloor, requiredCash },
    annual,
    monthly: { ...monthly, vendorCharge: monthlyCost, overhead: monthlyOverhead },
    savings: { amount: savings, pct: Math.round(savingsPct * 10000) / 10000, justifiesCommitment: savingsJustifyCommitment },
    checks,
    generatedAt: now.toISOString()
  };
}

// Translates an approved decision into Airwallex card authorization controls, so the
// card can only be used for the purchase the agent approved. Returns null when blocked.
function buildCardPolicy(evaluation, { now = new Date(), currency = 'USD' } = {}) {
  if (evaluation.recommendation === 'blocked') return null;

  const isAnnual = evaluation.recommendation === 'annual';
  const activeTo = new Date(now);
  let limits;
  let summary;

  if (isAnnual) {
    const amount = evaluation.annual.upfrontCharge;
    activeTo.setUTCDate(activeTo.getUTCDate() + ANNUAL_PURCHASE_WINDOW_DAYS);
    limits = [{ amount, interval: 'ALL_TIME' }];
    summary = `Single-use card for one ${formatMoney(amount)} annual payment to ${evaluation.vendor}, valid for ${ANNUAL_PURCHASE_WINDOW_DAYS} days.`;
  } else {
    const amount = evaluation.monthly.vendorCharge;
    activeTo.setUTCFullYear(activeTo.getUTCFullYear() + 1);
    limits = [
      { amount, interval: 'PER_TRANSACTION' },
      { amount, interval: 'MONTHLY' },
      { amount: roundMoney(amount * 12), interval: 'ALL_TIME' }
    ];
    summary = `Recurring card for ${evaluation.vendor}, capped at ${formatMoney(amount)} per month for 12 months.`;
  }

  return {
    plan: evaluation.recommendation,
    vendor: evaluation.vendor,
    summary,
    merchantCategories: SAAS_MERCHANT_CATEGORIES,
    authorization_controls: {
      allowed_transaction_count: isAnnual ? 'SINGLE' : 'MULTIPLE',
      transaction_limits: { currency, limits },
      allowed_merchant_categories: SAAS_MERCHANT_CATEGORIES.map((category) => category.code),
      active_from: formatAirwallexTimestamp(now),
      active_to: formatAirwallexTimestamp(activeTo)
    }
  };
}

module.exports = {
  INTENTS,
  SAAS_MERCHANT_CATEGORIES,
  validatePurchaseInput,
  evaluatePurchase,
  buildCardPolicy
};
