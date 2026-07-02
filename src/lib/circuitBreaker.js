'use strict';

const CircuitBreaker = require('opossum');
const logger = require('./logger');

const DEFAULT_OPTIONS = {
  timeout: 5000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
};

function createCircuitBreaker(fn, name, options = {}) {
  const breaker = new CircuitBreaker(fn, { ...DEFAULT_OPTIONS, ...options });

  breaker.on('open', () =>
    logger.warn({ circuitBreaker: name }, 'circuit breaker opened — nomba calls will fail fast'));
  breaker.on('halfOpen', () =>
    logger.info({ circuitBreaker: name }, 'circuit breaker half-open — testing nomba'));
  breaker.on('close', () =>
    logger.info({ circuitBreaker: name }, 'circuit breaker closed — nomba restored'));

  return breaker;
}

module.exports = { createCircuitBreaker };
