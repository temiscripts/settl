'use strict';

const rateLimit = require('express-rate-limit');

const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Applied to routes that call the real Nomba API (account provisioning) —
// tighter than the webhook limiter since each request incurs a real Nomba
// call, not just local DB/CPU cost.
const accountsRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

module.exports = { webhookRateLimiter, accountsRateLimiter };
