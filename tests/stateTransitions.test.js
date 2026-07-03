'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateStateTransition, ALLOWED } = require('../src/lib/stateTransitions');

// Valid transitions — must not throw
const VALID = [
  ['initiated', 'pending'],
  ['pending',   'settled'],
  ['pending',   'failed'],
  ['failed',    'reversing'],
  ['reversing', 'reversed'],
];

for (const [from, to] of VALID) {
  test(`valid: ${from} → ${to}`, () => {
    assert.doesNotThrow(() => validateStateTransition(from, to));
  });
}

// Every state-to-state pair that is NOT in ALLOWED must throw
test('illegal transitions throw with descriptive message', () => {
  const allStates = Object.keys(ALLOWED);
  for (const from of allStates) {
    for (const to of allStates) {
      if (ALLOWED[from].includes(to)) continue;
      assert.throws(
        () => validateStateTransition(from, to),
        (err) => {
          assert.match(err.message, /Illegal state transition/);
          return true;
        },
        `expected throw for ${from} → ${to}`
      );
    }
  }
});

test('unknown from-state throws', () => {
  assert.throws(() => validateStateTransition('nonexistent', 'pending'), /Illegal state transition/);
});

test('terminal states have no outgoing transitions', () => {
  assert.deepEqual(ALLOWED.settled,  []);
  assert.deepEqual(ALLOWED.reversed, []);
});
