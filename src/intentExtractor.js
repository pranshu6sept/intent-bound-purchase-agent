'use strict';

const DEFAULT_MODEL = 'openai/gpt-oss-20b';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 20_000;

// Forces the model to answer through a single tool call, so the response is
// always well-formed JSON instead of prose that has to be parsed and hoped for.
const EXTRACT_TOOL = {
  type: 'function',
  function: {
    name: 'extract_purchase',
    description: 'Extract structured SaaS purchase details from free text such as a quote, email, or request.',
    parameters: {
      type: 'object',
      properties: {
        vendor: { type: 'string', description: 'Vendor or product name.' },
        availableCash: { type: 'number', description: 'Total cash currently available, in USD.' },
        reserveFloor: { type: 'number', description: 'Minimum cash reserve that must remain available, in USD.' },
        annualCost: { type: 'number', description: 'Price of the annual plan, in USD.' },
        monthlyCost: { type: 'number', description: 'Price of the monthly plan, in USD.' },
        monthlyOverhead: {
          type: 'number',
          description: 'Extra monthly cost from paying monthly instead of annually (admin, fees). 0 if not mentioned.'
        },
        purchaseIntent: {
          type: 'string',
          enum: ['strategic', 'urgent', 'noncritical'],
          description:
            'strategic: a core, proven tool. urgent: needed now, fit unproven. noncritical: nice-to-have. Infer the best fit; default to strategic if unclear.'
        }
      },
      required: ['vendor', 'availableCash', 'reserveFloor', 'annualCost', 'monthlyCost', 'purchaseIntent']
    }
  }
};

function createIntentExtractor({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = {
    apiKey: env.GROQ_API_KEY?.trim(),
    model: env.GROQ_MODEL?.trim() || DEFAULT_MODEL
  };

  const mockReason = config.apiKey
    ? null
    : 'No GROQ_API_KEY configured. Fill in the purchase form by hand instead.';

  async function extract(text) {
    if (mockReason) {
      const error = new Error(mockReason);
      error.code = 'unavailable';
      throw error;
    }

    const response = await fetchImpl(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: `Extract the purchase details from this text. Only include a field if the text actually supports it; leave required fields out rather than guessing a number.\n\nText:\n${text}`
          }
        ],
        tools: [EXTRACT_TOOL],
        tool_choice: { type: 'function', function: { name: 'extract_purchase' } }
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data.error?.message || `HTTP ${response.status}`;
      const error = new Error(`Groq API request failed: ${detail}`);
      error.code = 'upstream_error';
      throw error;
    }

    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      const error = new Error('The model did not return structured purchase details.');
      error.code = 'extraction_failed';
      throw error;
    }

    try {
      return JSON.parse(toolCall.function.arguments);
    } catch {
      const error = new Error('The model returned malformed purchase details.');
      error.code = 'extraction_failed';
      throw error;
    }
  }

  return { mode: mockReason ? 'unavailable' : 'llm', mockReason, extract };
}

module.exports = { createIntentExtractor };
