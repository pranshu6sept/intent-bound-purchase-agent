'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_FILE_PATH = path.join(__dirname, '..', 'data', 'audit-log.jsonl');

// Append-only JSON-lines log of every evaluation and approval, so finance
// teams can review what the agent decided and why after the fact.
function createAuditLog({ filePath = DEFAULT_FILE_PATH, fileSystem = fs } = {}) {
  function record(entry) {
    const line = JSON.stringify({ id: crypto.randomUUID(), at: new Date().toISOString(), ...entry });
    fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
    fileSystem.appendFileSync(filePath, `${line}\n`);
  }

  function list({ limit = 50 } = {}) {
    let text;
    try {
      text = fileSystem.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }

    const entries = text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    return entries.slice(-limit).reverse();
  }

  return { record, list };
}

module.exports = { createAuditLog };
