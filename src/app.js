'use strict';

const path = require('node:path');
const express = require('express');
const { INTENTS, validatePurchaseInput, evaluatePurchase, buildCardPolicy } = require('./policyEngine');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp({ issuer, auditLog, intentExtractor }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(PUBLIC_DIR));

  function parsePurchase(req, res) {
    const { value, errors } = validatePurchaseInput(req.body);
    if (errors.length > 0) {
      res.status(400).json({ error: 'invalid_input', message: 'Some purchase inputs are invalid.', details: errors });
      return null;
    }
    return value;
  }

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'intent-bound-purchase-agent', issuerMode: issuer.mode });
  });

  app.get('/api/config', (req, res) => {
    res.json({
      issuerMode: issuer.mode,
      issuerNote: issuer.mockReason,
      extractorMode: intentExtractor.mode,
      extractorNote: intentExtractor.mockReason,
      intents: INTENTS
    });
  });

  // Not logged to the audit trail: the UI calls this on every keystroke (debounced),
  // and only an approval decision (POST /api/virtual-card) is a consequential event.
  app.post('/api/recommendation', (req, res) => {
    const input = parsePurchase(req, res);
    if (!input) return;
    res.json(evaluatePurchase(input));
  });

  app.get('/api/audit-log', (req, res) => {
    res.json({ entries: auditLog.list({ limit: 50 }) });
  });

  app.post('/api/extract-purchase', async (req, res, next) => {
    const text = req.body && typeof req.body.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      res.status(400).json({ error: 'invalid_input', message: 'Provide purchase text to extract from.' });
      return;
    }

    try {
      const fields = await intentExtractor.extract(text);
      res.json({ fields });
    } catch (error) {
      if (error.code === 'unavailable') {
        res.status(503).json({ error: 'extractor_unavailable', message: error.message });
        return;
      }
      if (error.code === 'upstream_error' || error.code === 'extraction_failed') {
        res.status(502).json({ error: error.code, message: error.message });
        return;
      }
      next(error);
    }
  });

  // The decision is always recomputed server-side from the raw inputs, so a client
  // can never talk the agent into issuing a card for a plan it would not approve.
  app.post('/api/virtual-card', async (req, res, next) => {
    try {
      const input = parsePurchase(req, res);
      if (!input) return;

      const evaluation = evaluatePurchase(input);
      const cardPolicy = buildCardPolicy(evaluation);
      if (!cardPolicy) {
        auditLog.record({ type: 'blocked', vendor: evaluation.vendor, recommendation: evaluation.recommendation, reason: evaluation.reason });
        res.status(422).json({ error: 'policy_blocked', message: evaluation.reason, evaluation });
        return;
      }

      const card = await issuer.issueCard(cardPolicy);
      auditLog.record({
        type: 'card_issued',
        vendor: evaluation.vendor,
        recommendation: evaluation.recommendation,
        reason: evaluation.reason,
        cardId: card.card_id,
        cardMode: card.mode
      });
      res.status(201).json({ evaluation, cardPolicy, card });
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not_found', message: `No API route for ${req.method} ${req.originalUrl}.` });
  });

  app.get('*', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  // Express identifies error handlers by their four-argument signature.
  app.use((error, req, res, next) => {
    if (error.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json', message: 'Request body must be valid JSON.' });
      return;
    }
    if (error.type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large', message: 'Request body is too large.' });
      return;
    }
    console.error(error);
    res.status(500).json({ error: 'internal_error', message: 'Unexpected server error.' });
  });

  return app;
}

module.exports = { createApp };
