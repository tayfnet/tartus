(()=>{
  'use strict';
  const DIRECT_WORKER_API_BASE_URL = 'https://taif-cloudflare-api.mhmadsayfzaim.workers.dev';
  const toText = (value) => String(value ?? '').trim();

  function isLocalHost(hostname){
    const host = toText(hostname).toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.local');
  }

  function isGithubPagesHost(hostname){
    return /(^|\.)github\.io$/i.test(toText(hostname));
  }

  function resolvePrimaryApiBaseUrl(){
    try{
      const loc = window.location || {};
      const protocol = toText(loc.protocol).toLowerCase();
      const hostname = toText(loc.hostname).toLowerCase();
      const origin = toText(loc.origin).replace(/\/+$/, '');
      if((protocol === 'http:' || protocol === 'https:') && origin && !isLocalHost(hostname) && !isGithubPagesHost(hostname)) return origin;
    }catch{}
    return DIRECT_WORKER_API_BASE_URL;
  }

  window.TAIF_PUBLIC_PRICE_CONFIG = Object.freeze({
    CLOUDFLARE_API_BASE_URL: resolvePrimaryApiBaseUrl(),
    DIRECT_CLOUDFLARE_API_BASE_URL: DIRECT_WORKER_API_BASE_URL,
    API_PREFIX: '/api',
    WORKSPACE_ID: 'default',
    STATE_KEY: 'taif-currency-management-module-v1',
    POLL_INTERVAL_MS: 60000,
    REQUEST_TIMEOUT_MS: 5000,
    SHOW_STATUS: false,
    DEBUG: false,
    BUILD_VERSION: '20260718-stage52-new-account-ready'
  });
})();
