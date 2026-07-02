'use strict';

const logger = require('../lib/logger');

function errorHandler(err, req, res, next) {
  logger.error({ requestId: req.requestId, err }, 'Unhandled error');
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    requestId: req.requestId,
  });
}

module.exports = errorHandler;
