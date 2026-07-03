'use strict';

const axios = require('axios');
const retry = require('async-retry');
const { withTokenRefreshLock } = require('../lib/tokenMutex');
const { createCircuitBreaker } = require('../lib/circuitBreaker');
const logger = require('../lib/logger');

const BASE_URL = process.env.NOMBA_BASE_URL;
// v2 base derived from v1 — transfers live under /v2, everything else /v1
const BASE_URL_V2 = BASE_URL?.replace('/v1', '/v2');
const PARENT_ACCOUNT_ID = process.env.NOMBA_PARENT_ACCOUNT_ID;
const SUB_ACCOUNT_ID = process.env.NOMBA_SUB_ACCOUNT_ID;
const CLIENT_ID = process.env.NOMBA_CLIENT_ID;
const CLIENT_SECRET = process.env.NOMBA_CLIENT_SECRET;

// accountId header must always be the PARENT account ID per Nomba docs.
// The sub-account is scoped via {subAccountId} in the path param instead.
const NOMBA_HEADERS = () => ({ accountId: PARENT_ACCOUNT_ID });

let cachedToken = null;
let refreshToken = null;
// Subtract 60s to refresh before the window closes rather than after.
let tokenExpiresAt = 0;

async function issueToken() {
  const res = await axios.post(
    `${BASE_URL}/auth/token/issue`,
    { grant_type: 'client_credentials', clientId: CLIENT_ID, secret: CLIENT_SECRET },
    { timeout: 5000 }
  );
  const { access_token, refresh_token } = res.data.data;
  cachedToken = access_token;
  refreshToken = refresh_token;
  tokenExpiresAt = Date.now() + (30 * 60 - 60) * 1000;
  logger.info('nomba token issued');
}

async function doTokenRefresh() {
  if (!refreshToken) {
    return issueToken();
  }
  try {
    const res = await axios.post(
      `${BASE_URL}/auth/token/refresh`,
      { refresh_token: refreshToken },
      { timeout: 5000 }
    );
    const { access_token, refresh_token: newRefreshToken } = res.data.data;
    cachedToken = access_token;
    refreshToken = newRefreshToken;
    tokenExpiresAt = Date.now() + (30 * 60 - 60) * 1000;
    logger.info('nomba token refreshed');
  } catch (err) {
    logger.warn({ err }, 'token refresh failed, falling back to re-issue');
    await issueToken();
  }
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  await withTokenRefreshLock(doTokenRefresh);
  return cachedToken;
}

async function nombaRequest(method, path, data, extraHeaders = {}, baseUrl = BASE_URL) {
  const token = await getToken();
  const res = await axios({
    method,
    url: `${baseUrl}${path}`,
    data,
    timeout: 5000,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...NOMBA_HEADERS(),
      ...extraHeaders,
    },
  });
  return res.data;
}

async function nombaRequestWithRetry(method, path, data, extraHeaders, baseUrl) {
  return retry(
    async (bail, attempt) => {
      try {
        return await nombaRequest(method, path, data, extraHeaders, baseUrl);
      } catch (err) {
        if (err.response?.status >= 400 && err.response?.status < 500) {
          bail(err);
          return;
        }
        // jitter prevents thundering herd on retry storms after an outage
        const delay = Math.pow(2, attempt - 1) * 1000 + Math.random() * 1000;
        logger.warn({ attempt, path, delay: Math.round(delay) }, 'nomba call failed, retrying');
        throw err;
      }
    },
    { retries: 3, minTimeout: 1000 }
  );
}

const createVirtualAccountBreaker = createCircuitBreaker(
  (data) => nombaRequestWithRetry('POST', `/accounts/virtual/${SUB_ACCOUNT_ID}`, data),
  'createVirtualAccount'
);

const requeryBreaker = createCircuitBreaker(
  (sessionId) => nombaRequestWithRetry('GET', `/transactions/requery/${sessionId}`),
  'requeryTransaction'
);

const reversalBreaker = createCircuitBreaker(
  ({ data, idempotencyKey }) =>
    nombaRequestWithRetry('POST', `/transfers/bank/${SUB_ACCOUNT_ID}`, data, { 'X-Idempotency-Key': idempotencyKey }, BASE_URL_V2),
  'initiateReversal'
);

async function createVirtualAccount(data) {
  return createVirtualAccountBreaker.fire(data);
}

async function requeryTransaction(sessionId) {
  return requeryBreaker.fire(sessionId);
}

async function initiateReversal(data, merchantTxRef) {
  return reversalBreaker.fire({ data, idempotencyKey: `${merchantTxRef}:reversal` });
}

function getCircuitBreakerStates() {
  return {
    createVirtualAccount: createVirtualAccountBreaker.status.stats,
    requeryTransaction: requeryBreaker.status.stats,
    initiateReversal: reversalBreaker.status.stats,
  };
}

module.exports = {
  createVirtualAccount,
  requeryTransaction,
  initiateReversal,
  getCircuitBreakerStates,
};
