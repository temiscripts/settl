'use strict';

const ALLOWED = {
  initiated:  ['pending'],
  pending:    ['settled', 'failed'],
  failed:     ['reversing'],
  reversing:  ['reversed'],
  reversed:   [],
  settled:    [],
};

function validateStateTransition(from, to) {
  if (!ALLOWED[from]?.includes(to)) {
    throw new Error(`Illegal state transition: ${from} → ${to}`);
  }
}

module.exports = { validateStateTransition, ALLOWED };
