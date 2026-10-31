'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuditLog } = require('../src/auditLog');

function fakeFileSystem(initialFiles = {}) {
  const files = { ...initialFiles };
  return {
    files,
    mkdirSync() {},
    appendFileSync(filePath, text) {
      files[filePath] = (files[filePath] || '') + text;
    },
    readFileSync(filePath) {
      if (!(filePath in files)) {
        const error = new Error('not found');
        error.code = 'ENOENT';
        throw error;
      }
      return files[filePath];
    }
  };
}

test('list() returns an empty array when the log file does not exist yet', () => {
  const auditLog = createAuditLog({ filePath: '/tmp/audit.jsonl', fileSystem: fakeFileSystem() });
  assert.deepEqual(auditLog.list(), []);
});

test('record() appends a timestamped, identified entry; list() returns newest first', () => {
  const fileSystem = fakeFileSystem();
  const auditLog = createAuditLog({ filePath: '/tmp/audit.jsonl', fileSystem });

  auditLog.record({ type: 'card_issued', vendor: 'Acme' });
  auditLog.record({ type: 'blocked', vendor: 'Beta Co' });

  const entries = auditLog.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].vendor, 'Beta Co');
  assert.equal(entries[1].vendor, 'Acme');
  for (const entry of entries) {
    assert.ok(entry.id);
    assert.ok(entry.at);
  }
});

test('list() respects the limit and still returns newest first', () => {
  const fileSystem = fakeFileSystem();
  const auditLog = createAuditLog({ filePath: '/tmp/audit.jsonl', fileSystem });

  for (let i = 0; i < 5; i += 1) auditLog.record({ type: 'card_issued', vendor: `Vendor ${i}` });

  const entries = auditLog.list({ limit: 2 });
  assert.deepEqual(entries.map((entry) => entry.vendor), ['Vendor 4', 'Vendor 3']);
});
