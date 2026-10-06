const PRESETS = {
  fits: {
    vendor: 'Acme Analytics',
    availableCash: 60000,
    reserveFloor: 20000,
    annualCost: 28000,
    monthlyCost: 2800,
    monthlyOverhead: 100,
    purchaseIntent: 'strategic'
  },
  breach: {
    vendor: 'Acme Analytics',
    availableCash: 45000,
    reserveFloor: 20000,
    annualCost: 28000,
    monthlyCost: 2800,
    monthlyOverhead: 100,
    purchaseIntent: 'strategic'
  },
  tight: {
    vendor: 'Mockup Studio',
    availableCash: 24000,
    reserveFloor: 20000,
    annualCost: 28000,
    monthlyCost: 2800,
    monthlyOverhead: 100,
    purchaseIntent: 'noncritical'
  }
};

const PLAN_LABELS = { annual: 'Annual plan', monthly: 'Monthly plan', blocked: 'Purchase blocked' };
const INTERVAL_LABELS = { PER_TRANSACTION: 'per transaction', DAILY: 'per day', WEEKLY: 'per week', MONTHLY: 'per month', ALL_TIME: 'lifetime' };

const $ = (id) => document.getElementById(id);
const form = $('purchase-form');
const intentSelect = form.elements.purchaseIntent;
const submitButton = form.querySelector('button[type="submit"]');
const cardButton = $('card-button');

let intents = {};
let lastEvaluation = null;
let requestSeq = 0;
let debounceTimer = null;

const moneyFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const formatMoney = (value) => moneyFormat.format(value);
const formatPct = (value) => `${Number((value * 100).toFixed(1))}%`;

// Airwallex timestamps use a +0000 offset, which not every browser parses.
function formatDate(timestamp) {
  const date = new Date(timestamp.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function readForm() {
  return Object.fromEntries(new FormData(form).entries());
}

function fillForm(values) {
  for (const [name, value] of Object.entries(values)) {
    form.elements[name].value = value;
  }
  updateIntentHint();
}

function updateIntentHint() {
  $('intent-hint').textContent = intents[intentSelect.value]?.description || '';
}

function setLoading(isLoading) {
  $('loading').classList.toggle('hidden', !isLoading);
  submitButton.disabled = isLoading;
  cardButton.disabled = isLoading || !lastEvaluation || lastEvaluation.recommendation === 'blocked';
}

function clearError() {
  $('error').classList.add('hidden');
  $('error').replaceChildren();
  for (const element of form.elements) element.removeAttribute('aria-invalid');
}

function showError(message, details = []) {
  const box = $('error');
  const heading = document.createElement('strong');
  heading.textContent = message;
  box.replaceChildren(heading);

  if (details.length > 0) {
    const list = document.createElement('ul');
    for (const detail of details) {
      const item = document.createElement('li');
      item.textContent = detail.message;
      list.append(item);
      form.elements[detail.field]?.setAttribute('aria-invalid', 'true');
    }
    box.append(list);
  }
  box.classList.remove('hidden');
}

async function postJson(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data };
}

function renderEvaluation(evaluation) {
  lastEvaluation = evaluation;
  const { recommendation, annual, monthly, savings } = evaluation;
  $('decision').classList.remove('stale');

  const pill = $('decision-pill');
  pill.textContent = PLAN_LABELS[recommendation];
  pill.className = `pill ${recommendation}`;
  $('reason-text').textContent = evaluation.reason;

  $('annual-cash').textContent = formatMoney(annual.cashAfterPurchase);
  $('monthly-cash').textContent = formatMoney(monthly.cashAfterPurchase);

  if (recommendation === 'blocked') {
    $('headroom-label').textContent = 'Shortfall on best plan';
    $('headroom').textContent = formatMoney(Math.abs(Math.max(annual.headroom, monthly.headroom)));
  } else {
    $('headroom-label').textContent = `Headroom on ${recommendation} plan`;
    $('headroom').textContent = formatMoney(evaluation[recommendation].headroom);
  }

  $('savings').textContent = savings.amount > 0
    ? `${formatMoney(savings.amount)} (${formatPct(savings.pct)})`
    : 'None';

  const checks = evaluation.checks.map((check) => {
    const item = document.createElement('li');
    item.className = check.status;
    const label = document.createElement('strong');
    label.textContent = check.label;
    const detail = document.createElement('span');
    detail.textContent = check.detail;
    item.append(label, detail);
    item.setAttribute('aria-label', `${check.status === 'pass' ? 'Passed' : 'Failed'}: ${check.label}. ${check.detail}`);
    return item;
  });
  $('checks').replaceChildren(...checks);

  cardButton.disabled = recommendation === 'blocked';
  cardButton.textContent = recommendation === 'blocked'
    ? 'No card: purchase blocked'
    : `Approve & issue ${recommendation} card`;
}

function renderCard({ cardPolicy, card }) {
  const controls = cardPolicy.authorization_controls;
  const isSingleUse = controls.allowed_transaction_count === 'SINGLE';
  const primaryLimit = controls.transaction_limits.limits.find(
    (limit) => limit.interval === (isSingleUse ? 'ALL_TIME' : 'MONTHLY')
  );

  $('vc-mode').textContent = card.mode === 'sandbox' ? 'Sandbox' : 'Mock';
  $('vc-mode').className = `vc-mode ${card.mode}`;
  $('vc-vendor').textContent = cardPolicy.vendor;
  $('vc-limit').textContent = `${formatMoney(primaryLimit.amount)} ${isSingleUse ? 'one-time' : 'per month'}`;
  $('vc-usage').textContent = isSingleUse ? 'Single use' : 'Recurring';
  $('vc-valid').textContent = `Valid to ${formatDate(controls.active_to)}`;

  $('card-summary').textContent = cardPolicy.summary;
  $('card-note').textContent = card.fallbackReason || '';
  $('card-note').classList.toggle('hidden', !card.fallbackReason);
  $('card-id').textContent = `${card.card_id} (${card.card_status})`;
  $('card-limits').textContent = controls.transaction_limits.limits
    .map((limit) => `${formatMoney(limit.amount)} ${INTERVAL_LABELS[limit.interval] || limit.interval}`)
    .join(' · ');
  $('card-mccs').textContent = cardPolicy.merchantCategories
    .map((category) => `${category.code} ${category.label}`)
    .join(', ');
  $('card-window').textContent = `${formatDate(controls.active_from)} to ${formatDate(controls.active_to)}`;
  $('card-json').textContent = JSON.stringify(card.request, null, 2);

  $('card-result').classList.remove('hidden');
}

function hideCard() {
  $('card-result').classList.add('hidden');
}

async function analyze() {
  const seq = ++requestSeq;
  clearError();
  setLoading(true);

  try {
    const { ok, data } = await postJson('/api/recommendation', readForm());
    if (seq !== requestSeq) return;
    if (!ok) {
      lastEvaluation = null;
      $('decision').classList.add('stale');
      showError(data.message || 'Could not evaluate this purchase.', data.details);
      return;
    }
    renderEvaluation(data);
  } catch {
    if (seq === requestSeq) showError('Could not reach the agent. Is the server running?');
  } finally {
    if (seq === requestSeq) setLoading(false);
  }
}

async function issueCard() {
  const seq = ++requestSeq;
  clearError();
  setLoading(true);

  try {
    const { ok, data } = await postJson('/api/virtual-card', readForm());
    if (seq !== requestSeq) return;
    if (data.evaluation) renderEvaluation(data.evaluation);
    if (!ok) {
      hideCard();
      showError(data.message || 'The agent could not issue a card.', data.details);
      return;
    }
    renderCard(data);
  } catch {
    if (seq === requestSeq) showError('Could not reach the agent. Is the server running?');
  } finally {
    if (seq === requestSeq) setLoading(false);
  }
}

async function init() {
  try {
    const response = await fetch('/api/config');
    const config = await response.json();
    intents = config.intents;

    intentSelect.replaceChildren(...Object.entries(intents).map(([key, intent]) => new Option(intent.label, key)));

    const tag = $('mode-tag');
    tag.textContent = config.issuerMode === 'sandbox' ? 'Airwallex sandbox' : 'Mock issuer';
    tag.classList.add(config.issuerMode);
    if (config.issuerNote) tag.title = config.issuerNote;
  } catch {
    showError('Could not load agent configuration. Is the server running?');
    return;
  }

  fillForm(PRESETS.fits);
  await analyze();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  clearTimeout(debounceTimer);
  hideCard();
  analyze();
});

form.addEventListener('input', () => {
  updateIntentHint();
  hideCard();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(analyze, 350);
});

document.querySelectorAll('[data-preset]').forEach((button) => {
  button.addEventListener('click', () => {
    clearTimeout(debounceTimer);
    hideCard();
    fillForm(PRESETS[button.dataset.preset]);
    analyze();
  });
});

cardButton.addEventListener('click', issueCard);

init();
