'use strict';

let refreshPromise = null;

async function withTokenRefreshLock(refreshFn) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = refreshFn().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

module.exports = { withTokenRefreshLock };
