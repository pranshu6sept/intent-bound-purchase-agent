const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const AWX_BASE_URL = process.env.AWX_BASE_URL || 'https://api.sandbox.airwallex.com/api/v1';

app.use(express.json());
app.use(express.static('public'));

function determineRecommendation(input) {
  const {
    availableCash,
    reserveFloor,
    annualCost,
    monthlyCost,
    monthlyOverhead,
    riskTolerance = 0.15,
    purchaseIntent = 'strategic'
  } = input;

  const annualAfterPurchase = availableCash - annualCost;
  const monthlyAfterPurchase = availableCash - monthlyCost;
  const annualStatus = annualAfterPurchase >= reserveFloor;
  const monthlyStatus = monthlyAfterPurchase >= reserveFloor;

  const annualSavings = annualCost - (monthlyCost * 12);
  const annualIsCheaper = annualSavings > 0;

  let decision = 'monthly';
  let reason = 'The monthly plan keeps the business above reserve and reduces treasury risk.';

  if (annualStatus && annualIsCheaper && purchaseIntent !== 'urgent') {
    decision = 'annual';
    reason = 'The annual plan remains above the reserve threshold and is materially cheaper.';
  } else if (annualStatus && monthlyStatus && annualIsCheaper && riskTolerance < 0.2) {
    decision = 'annual';
    reason = 'The business stays safe and annual plan pricing is still favorable.';
  } else if (!annualStatus && monthlyStatus) {
    decision = 'monthly';
    reason = 'Annual billing would breach the reserve floor, so the monthly structure is safer.';
  } else if (!monthlyStatus && annualStatus) {
    decision = 'annual';
    reason = 'The monthly option also breaches the reserve floor, while annual still passes the policy check.';
  }

  const annualHeadroom = annualAfterPurchase - reserveFloor;
  const monthlyHeadroom = monthlyAfterPurchase - reserveFloor;

  return {
    recommendation: decision,
    reason,
    annual: {
      status: annualStatus,
      postPurchaseCash: annualAfterPurchase,
      headroom: annualHeadroom,
      cost: annualCost,
      savingsVsMonthly: annualSavings,
      policyPass: annualStatus
    },
    monthly: {
      status: monthlyStatus,
      postPurchaseCash: monthlyAfterPurchase,
      headroom: monthlyHeadroom,
      cost: monthlyCost,
      overhead: monthlyOverhead,
      policyPass: monthlyStatus
    },
    reserveFloor,
    availableCash,
    generatedAt: new Date().toISOString()
  };
}

async function airwallexLogin() {
  const clientId = process.env.AWX_CLIENT_ID;
  const apiKey = process.env.AWX_API_KEY;

  if (!clientId || !apiKey) {
    return null;
  }

  try {
    const response = await axios.post(
      `${AWX_BASE_URL.replace(/\/api\/v1$/, '')}/api/v1/authentication/login`,
      {},
      {
        headers: {
          'x-client-id': clientId,
          'x-api-key': apiKey
        },
        timeout: 20000
      }
    );

    return response.data?.token || response.data?.access_token || null;
  } catch (error) {
    console.error('Airwallex login failed:', error.response?.data || error.message);
    return null;
  }
}

async function createMockCardConfiguration(recommendation) {
  const plan = recommendation.recommendation;
  const want = plan === 'annual' ? 2500 : 800;

  return {
    mode: 'mock',
    cardholder: {
      name: 'Finance Ops',
      type: 'INDIVIDUAL'
    },
    card: {
      cardholder_id: 'mock-cardholder-123',
      currency: 'USD',
      spend_limit: want,
      merchant_categories: ['software', 'saas'],
      policy: {
        allowed: plan === 'annual' ? ['software', 'saas'] : ['software', 'saas', 'admin'],
        notes: recommendation.reason
      }
    },
    status: 'mock_created'
  };
}

async function createAirwallexCardPayload(recommendation) {
  const token = await airwallexLogin();

  if (!token) {
    return createMockCardConfiguration(recommendation);
  }

  const requestId = uuidv4();
  const payload = {
    request_id: requestId,
    cardholder: {
      name: 'Finance Ops',
      type: 'INDIVIDUAL'
    },
    card: {
      currency: 'USD',
      spend_limit: recommendation.recommendation === 'annual' ? 2500 : 800,
      allowed_categories: ['software', 'saas'],
      policy_summary: recommendation.reason
    }
  };

  try {
    const response = await axios.post(
      `${AWX_BASE_URL}/issuing/cardholders/create`,
      payload.cardholder,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    return {
      mode: 'sandbox',
      cardholder_response: response.data,
      staged_policy: payload.card,
      recommendation: recommendation.recommendation
    };
  } catch (error) {
    console.error('Airwallex card creation failed:', error.response?.data || error.message);
    return createMockCardConfiguration(recommendation);
  }
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'intent-bound-purchase-agent' });
});

app.post('/api/recommendation', (req, res) => {
  const result = determineRecommendation(req.body || {});
  res.json(result);
});

app.post('/api/virtual-card', async (req, res) => {
  const recommendation = determineRecommendation(req.body || {});
  const cardConfig = await createAirwallexCardPayload(recommendation);

  res.json({
    recommendation,
    cardConfig
  });
});

app.get('*', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Purchase Agent demo running at http://localhost:${PORT}`);
});
