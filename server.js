'use strict';

require('dotenv').config();

const { createApp } = require('./src/app');
const { createAirwallexIssuer } = require('./src/airwallex');

const PORT = Number(process.env.PORT) || 3000;
const issuer = createAirwallexIssuer();
const app = createApp({ issuer });

app.listen(PORT, () => {
  console.log(`Intent-Bound Purchase Agent running at http://localhost:${PORT}`);
  console.log(`Card issuer: ${issuer.mode}${issuer.mockReason ? ` (${issuer.mockReason})` : ''}`);
});
