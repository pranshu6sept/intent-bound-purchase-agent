'use strict';

const crypto = require('node:crypto');

const DEFAULT_BASE_URL = 'https://api.sandbox.airwallex.com/api/v1';
const REQUEST_TIMEOUT_MS = 20_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_TTL_MS = 25 * 60_000;

// Commercial virtual card program, per the Airwallex "create commercial cards" guide.
// Change this if your sandbox account is provisioned for a different program type.
const CARD_PROGRAM = { purpose: 'COMMERCIAL', type: 'CREDIT', sub_type: 'GOOD_FUNDS_CREDIT' };

function isSandboxUrl(url) {
  try {
    return new URL(url).hostname.endsWith('sandbox.airwallex.com');
  } catch {
    return false;
  }
}

function createAirwallexIssuer({ env = process.env, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const config = {
    clientId: env.AWX_CLIENT_ID?.trim(),
    apiKey: env.AWX_API_KEY?.trim(),
    baseUrl: (env.AWX_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    cardholderId: env.AWX_CARDHOLDER_ID?.trim(),
    cardholderEmail: env.AWX_CARDHOLDER_EMAIL?.trim() || 'finance-ops@example.com',
    createdBy: env.AWX_CARD_CREATED_BY?.trim() || 'Intent-Bound Purchase Agent'
  };

  const hasCredentials = Boolean(config.clientId && config.apiKey);
  const isSandbox = isSandboxUrl(config.baseUrl);

  let mockReason = null;
  if (!hasCredentials) mockReason = 'No Airwallex sandbox credentials configured.';
  else if (!isSandbox) mockReason = `Refusing to call non-sandbox Airwallex endpoint ${config.baseUrl}.`;

  let token = null;
  let tokenExpiresAt = 0;
  let cardholderId = config.cardholderId || null;

  async function request(path, { body, headers = {} }) {
    const response = await fetchImpl(`${config.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text.slice(0, 200) };
    }

    if (!response.ok) {
      const detail = data.message || data.code || `HTTP ${response.status}`;
      throw new Error(`${path} failed (${response.status}): ${detail}`);
    }
    return data;
  }

  async function getToken() {
    if (token && Date.now() < tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) return token;

    const data = await request('/authentication/login', {
      body: {},
      headers: { 'x-client-id': config.clientId, 'x-api-key': config.apiKey }
    });
    if (!data.token) throw new Error('/authentication/login returned no token');

    const expiresAt = Date.parse(data.expires_at);
    token = data.token;
    tokenExpiresAt = Number.isNaN(expiresAt) ? Date.now() + DEFAULT_TOKEN_TTL_MS : expiresAt;
    return token;
  }

  async function authedRequest(path, body) {
    return request(path, { body, headers: { Authorization: `Bearer ${await getToken()}` } });
  }

  // Reuses AWX_CARDHOLDER_ID when provided, otherwise creates one delegate
  // cardholder per process so repeated demos don't pile up cardholders.
  async function getCardholderId() {
    if (cardholderId) return cardholderId;
    const data = await authedRequest('/issuing/cardholders/create', {
      type: 'DELEGATE',
      email: config.cardholderEmail
    });
    if (!data.cardholder_id) throw new Error('/issuing/cardholders/create returned no cardholder_id');
    cardholderId = data.cardholder_id;
    return cardholderId;
  }

  function buildCreateCardRequest(cardPolicy, forCardholderId) {
    return {
      request_id: crypto.randomUUID(),
      cardholder_id: forCardholderId,
      created_by: config.createdBy,
      form_factor: 'VIRTUAL',
      is_personalized: false,
      program: CARD_PROGRAM,
      authorization_controls: cardPolicy.authorization_controls
    };
  }

  function mockCard(cardPolicy, fallbackReason) {
    const request = buildCreateCardRequest(cardPolicy, 'mock-cardholder');
    return {
      mode: 'mock',
      fallbackReason,
      card_id: `mock_${request.request_id.slice(0, 8)}`,
      card_status: 'ACTIVE',
      cardholder_id: request.cardholder_id,
      request
    };
  }

  async function issueCard(cardPolicy) {
    if (mockReason) return mockCard(cardPolicy, mockReason);

    try {
      const request = buildCreateCardRequest(cardPolicy, await getCardholderId());
      const card = await authedRequest('/issuing/cards/create', request);
      return {
        mode: 'sandbox',
        card_id: card.card_id,
        card_status: card.card_status,
        cardholder_id: request.cardholder_id,
        request
      };
    } catch (error) {
      logger.error('Airwallex sandbox card issuance failed:', error.message);
      return mockCard(cardPolicy, `Airwallex sandbox call failed, showing mock card instead. ${error.message}`);
    }
  }

  return {
    mode: mockReason ? 'mock' : 'sandbox',
    mockReason,
    issueCard
  };
}

module.exports = { createAirwallexIssuer };
