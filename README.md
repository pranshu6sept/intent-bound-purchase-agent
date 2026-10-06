# Intent-Bound Purchase Agent

This repo is a submission-ready demo for the Airwallex Agentic Banking Hackathon, built around Starter Kit 2: Intent-Bound Purchase Agent.

## Problem
A founder or procurement operator is deciding whether to buy SaaS annually or monthly. The annual plan is cheaper, but it can leave the company below its reserve floor. The monthly plan costs more but preserves liquidity and flexibility.

## Solution
This app models an agent that:
- reads the purchase terms and cash position
- compares annual and monthly options
- checks whether the deal would violate the reserve floor
- recommends the safest plan
- enforces the decision using a virtual-card style policy payload

The app is designed to work with the Airwallex sandbox and also includes a safe mock mode so it runs without credentials.

## How it works
The backend computes a recommendation using a policy engine:
- if annual plan would reduce cash below reserve floor, choose monthly
- if monthly plan is clearly safer and still within finance policy, recommend monthly
- otherwise choose annual when it remains safe and cheaper

It then produces a structured policy output and an optional Airwallex card configuration payload for an issuing flow.

## Project structure
- `server.js` – Express backend with the decision engine and sandbox integration
- `public/index.html` – UI for the purchase decision experience
- `public/app.js` – frontend logic that calls the API
- `public/styles.css` – styling for the dashboard

## Quick start

```bash
npm install
npm start
```

Then open http://localhost:3000

## Environment setup
Copy `.env.example` to `.env` and fill in Airwallex sandbox credentials if you want real sandbox calls:

```bash
cp .env.example .env
```

Example values:

```env
PORT=3000
AWX_CLIENT_ID=your_client_id_here
AWX_API_KEY=your_api_key_here
AWX_BASE_URL=https://api.sandbox.airwallex.com/api/v1
```

If these values are not set, the app runs in mock mode.

## Recommended hackathon submission narrative
"IntentBound Purchase Agent helps businesses choose the right SaaS payment plan without violating treasury policy. It evaluates annual vs monthly terms using cash runway, reserve thresholds, and purchase intent, then enforces the goal with a card policy that blocks out-of-policy spend."

## Airwallex sandbox integration
This project follows the starter kit conventions from the Airwallex guide:
- sandbox-only usage
- major units, not cents
- request IDs for mutating calls
- virtual card flow for policy enforcement

## Notes
This is a demo project intended for the Hackerearth Agentic Banking Hackathon and is meant to be extended with your own production-grade business logic and real Airwallex credentials.
