'use strict';

require('dotenv').config();

const { createApp } = require('./src/app');
const { createAirwallexIssuer } = require('./src/airwallex');
const { createAuditLog } = require('./src/auditLog');
const { createIntentExtractor } = require('./src/intentExtractor');

const PORT = Number(process.env.PORT) || 3000;
const issuer = createAirwallexIssuer();
const auditLog = createAuditLog();
const intentExtractor = createIntentExtractor();
const app = createApp({ issuer, auditLog, intentExtractor });

app.listen(PORT, () => {
  console.log(`Intent-Bound Purchase Agent running at http://localhost:${PORT}`);
  console.log(`Card issuer: ${issuer.mode}${issuer.mockReason ? ` (${issuer.mockReason})` : ''}`);
  console.log(`Intent extractor: ${intentExtractor.mode}${intentExtractor.mockReason ? ` (${intentExtractor.mockReason})` : ''}`);
});
