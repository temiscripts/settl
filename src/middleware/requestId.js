'use strict';

const { v4: uuidv4 } = require('uuid');

function requestId(req, res, next) {
  req.requestId = uuidv4();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

module.exports = requestId;
