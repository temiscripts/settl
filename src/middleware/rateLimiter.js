'use strict';

const rateLimit = require('express-rate-limit');

const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

module.exports = { webhookRateLimiter };
