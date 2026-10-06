const form = document.getElementById('purchase-form');
const resultBox = document.getElementById('result-box');
const reasonText = document.getElementById('reason-text');
const policyOutput = document.getElementById('policy-output');
const loading = document.getElementById('loading');
const recommendationPill = document.getElementById('recommendation-pill');
const annualCash = document.getElementById('annualCash');
const monthlyCash = document.getElementById('monthlyCash');
const reserveHeadroom = document.getElementById('reserveHeadroom');
const recommendedSource = document.getElementById('recommendedSource');
const cardButton = document.getElementById('card-button');

function toCurrency(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value || 0);
}

function renderDecision(data) {
  const recommended = data.recommendation === 'annual' ? 'Annual plan' : 'Monthly plan';
  const annualHeadroom = data.annual?.headroom ?? 0;
  const monthlyHeadroom = data.monthly?.headroom ?? 0;

  recommendationPill.textContent = recommended;
  recommendationPill.classList.toggle('annual', data.recommendation === 'annual');

  reasonText.textContent = data.reason;
  annualCash.textContent = toCurrency(data.annual?.postPurchaseCash || 0);
  monthlyCash.textContent = toCurrency(data.monthly?.postPurchaseCash || 0);
  reserveHeadroom.textContent = toCurrency(Math.max(annualHeadroom, monthlyHeadroom));
  recommendedSource.textContent = data.recommendation === 'annual' ? 'Annual' : 'Monthly';
  policyOutput.textContent = JSON.stringify(data, null, 2);
}

async function fetchRecommendation(payload) {
  loading.classList.remove('hidden');

  try {
    const response = await fetch('/api/recommendation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    renderDecision(data);
  } finally {
    loading.classList.add('hidden');
  }
}

async function createVirtualCard() {
  const payload = {
    availableCash: Number(document.getElementById('availableCash').value),
    reserveFloor: Number(document.getElementById('reserveFloor').value),
    annualCost: Number(document.getElementById('annualCost').value),
    monthlyCost: Number(document.getElementById('monthlyCost').value),
    monthlyOverhead: Number(document.getElementById('monthlyOverhead').value),
    purchaseIntent: document.getElementById('purchaseIntent').value
  };

  loading.classList.remove('hidden');

  try {
    const response = await fetch('/api/virtual-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    const output = {
      recommendation: result.recommendation,
      cardConfig: result.cardConfig
    };

    policyOutput.textContent = JSON.stringify(output, null, 2);
    renderDecision(result.recommendation);
  } finally {
    loading.classList.add('hidden');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const payload = {
    availableCash: Number(document.getElementById('availableCash').value),
    reserveFloor: Number(document.getElementById('reserveFloor').value),
    annualCost: Number(document.getElementById('annualCost').value),
    monthlyCost: Number(document.getElementById('monthlyCost').value),
    monthlyOverhead: Number(document.getElementById('monthlyOverhead').value),
    purchaseIntent: document.getElementById('purchaseIntent').value
  };

  await fetchRecommendation(payload);
});

cardButton.addEventListener('click', createVirtualCard);

fetchRecommendation({
  availableCash: 60000,
  reserveFloor: 20000,
  annualCost: 28000,
  monthlyCost: 5500,
  monthlyOverhead: 500,
  purchaseIntent: 'strategic'
});
