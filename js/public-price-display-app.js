(()=>{
  'use strict';

  const root = window;
  const TAIF = root.TAIF || {};
  const config = root.TAIF_PUBLIC_PRICE_CONFIG || {};
  const panel = document.querySelector('main.taif-public-price-app.panel[data-view="price-screen"]');
  const statusEl = document.querySelector('[data-taif-public-price-status]');

  let initialized = false;
  let pollTimer = 0;
  let consecutiveFailures = 0;
  let lastStateSignature = '';
  let lastAppliedAt = 0;
  let lastRefreshAt = 0;
  let refreshInFlight = false;
  let refreshQueued = false;
  let stopped = false;
  let lastFailureLogAt = 0;
  let lastFailureLogSignature = '';
  let retryBackoffUntil = 0;
  let retryBackoffMs = 120000;
  const PRICE_DISPLAY_CACHE_KEY = 'taif-public-price-display-online-cache-v1';
  const PRICE_DISPLAY_BACKOFF_KEY = 'taif-public-price-display-network-backoff-v3';
  const PRICE_DISPLAY_BACKOFF_MIN_MS = 120000;
  const PRICE_DISPLAY_BACKOFF_MAX_MS = 900000;

  function debugError(...args){
    if(config.DEBUG) console.error(...args);
  }

  function logRefreshFailure(error){
    if(!config.DEBUG) return;
    const now = Date.now();
    const signature = `${error?.status || ''}:${String(error?.message || error || '').slice(0, 240)}`;
    if(signature !== lastFailureLogSignature || now - lastFailureLogAt > 30000){
      lastFailureLogSignature = signature;
      lastFailureLogAt = now;
      debugError('[TAIF][PublicPriceDisplay] refresh failed', error);
    }
  }

  function isBrowserOffline(){
    try{ return typeof navigator !== 'undefined' && navigator.onLine === false; }catch{}
    return false;
  }

  function readStoredRefreshBackoff(){
    try{
      const raw = root.localStorage?.getItem?.(PRICE_DISPLAY_BACKOFF_KEY);
      if(!raw) return 0;
      const parsed = JSON.parse(raw);
      const until = Number(parsed?.retryBackoffUntil || 0);
      if(until > Date.now()) return until;
      root.localStorage?.removeItem?.(PRICE_DISPLAY_BACKOFF_KEY);
    }catch{}
    return 0;
  }

  function persistRefreshBackoff(){
    try{
      if(Number(retryBackoffUntil || 0) > Date.now()){
        root.localStorage?.setItem?.(PRICE_DISPLAY_BACKOFF_KEY, JSON.stringify({
          retryBackoffUntil,
          retryBackoffMs,
          savedAt:Date.now()
        }));
      }else{
        root.localStorage?.removeItem?.(PRICE_DISPLAY_BACKOFF_KEY);
      }
    }catch{}
  }

  function restoreRefreshBackoff(){
    const until = readStoredRefreshBackoff();
    if(until > Date.now()) retryBackoffUntil = Math.max(Number(retryBackoffUntil) || 0, until);
  }

  function isRetryBackoffActive(){
    restoreRefreshBackoff();
    return Date.now() < Number(retryBackoffUntil || 0);
  }

  function canAttemptNetworkRefresh(){
    return !isBrowserOffline() && !isRetryBackoffActive();
  }

  function rememberRefreshFailure(error){
    const message = String(error?.message || error || '');
    const status = Number(error?.status) || 0;
    const looksNetwork = status === 0 || status === 408 || error instanceof TypeError || /failed to fetch|networkerror|internet_disconnected|load failed|timeout/i.test(message);
    if(!looksNetwork) return;
    const delay = Math.min(PRICE_DISPLAY_BACKOFF_MAX_MS, Math.max(PRICE_DISPLAY_BACKOFF_MIN_MS, Number(retryBackoffMs) || PRICE_DISPLAY_BACKOFF_MIN_MS));
    retryBackoffUntil = Date.now() + delay;
    retryBackoffMs = Math.min(PRICE_DISPLAY_BACKOFF_MAX_MS, Math.round(delay * 1.7));
    persistRefreshBackoff();
  }

  function clearRefreshBackoff(){
    retryBackoffUntil = 0;
    retryBackoffMs = PRICE_DISPLAY_BACKOFF_MIN_MS;
    persistRefreshBackoff();
  }


  function isUsablePriceState(state){
    return Boolean(state && typeof state === 'object' && !Array.isArray(state) && Array.isArray(state.currencies) && state.currencies.length);
  }

  function readCachedPriceState(){
    try{
      const raw = root.localStorage ? root.localStorage.getItem(PRICE_DISPLAY_CACHE_KEY) : '';
      if(!raw) return null;
      const parsed = JSON.parse(raw);
      return isUsablePriceState(parsed) ? parsed : null;
    }catch{}
    return null;
  }

  function writeCachedPriceState(state){
    if(!isUsablePriceState(state)) return;
    try{
      root.localStorage?.setItem?.(PRICE_DISPLAY_CACHE_KEY, JSON.stringify({
        ...state,
        __taifPublicPriceCache:true,
        __taifPublicPriceCachedAt:Date.now()
      }));
    }catch{}
  }

  function showStatus(message, force = false){
    if(!statusEl || (!config.SHOW_STATUS && !force)) return;
    statusEl.textContent = message || '';
    statusEl.classList.toggle('is-visible', Boolean(message));
  }

  function normalizeUrl(url){
    return String(url || '').trim().replace(/\/+$/,'');
  }

  function getWorkspaceId(){
    return String(config.WORKSPACE_ID || config.ORG_ID || 'default').trim() || 'default';
  }

  function getWatchedStateKey(){
    return String(config.STATE_KEY || 'taif-currency-management-module-v1').trim() || 'taif-currency-management-module-v1';
  }

  function clonePlain(value){
    if(value == null || typeof value !== 'object') return value;
    try{ return JSON.parse(JSON.stringify(value)); }catch{}
    return Array.isArray(value) ? value.slice() : { ...value };
  }

  function stableStringify(value){
    if(value == null || typeof value !== 'object') return JSON.stringify(value ?? null);
    if(Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  function stateSignature(state){
    if(!state || typeof state !== 'object') return '';
    const rev = state.__taifDisplayRevision ?? state.__taifDomainRevision ?? state.revision;
    const hash = state.__taifDisplayPayloadHash ?? state.payloadHash ?? state.payload_hash;
    const updated = state.__taifDisplayUpdatedAt ?? state.updatedAt ?? state.updated_at ?? state.logicalUpdatedAt ?? state.logical_updated_at;
    if(rev != null || hash || updated) return `${rev ?? ''}:${hash || ''}:${updated || ''}`;
    return stableStringify(state);
  }

  function buildApiUrl(baseOverride = ''){
    const base = normalizeUrl(baseOverride || config.CLOUDFLARE_API_BASE_URL || root.location?.origin || '');
    const prefix = `/${String(config.API_PREFIX || '/api').replace(/^\/+|\/+$/g, '')}`;
    const url = new URL(`${base}${prefix}/currency/state`);
    url.searchParams.set('display', '1');
    url.searchParams.set('workspaceId', getWorkspaceId());
    url.searchParams.set('v', String(config.BUILD_VERSION || 'cloudflare-d1-public'));
    url.searchParams.set('_', String(Date.now()));
    return url.toString();
  }

  function getDirectApiBaseUrl(){
    return normalizeUrl(config.DIRECT_CLOUDFLARE_API_BASE_URL || config.FALLBACK_CLOUDFLARE_API_BASE_URL || 'https://taif-cloudflare-api.mhmadsayfzaim.workers.dev');
  }

  function isSameOriginApiBase(value){
    try{
      const currentOrigin = String(root.location?.origin || '').trim();
      if(!currentOrigin) return false;
      return new URL(value || currentOrigin, currentOrigin).origin === currentOrigin;
    }catch{}
    return false;
  }

  function canRetryDirectApi(base){
    const direct = getDirectApiBaseUrl();
    return !!direct && normalizeUrl(base) !== direct && isSameOriginApiBase(base);
  }

  function parseJsonPayload(text){
    try{ return JSON.parse(text || 'null'); }catch{ return null; }
  }

  function looksLikeBrokenSameOriginApi(response, text){
    const contentType = String(response?.headers?.get?.('Content-Type') || response?.headers?.get?.('content-type') || '').toLowerCase();
    const bodyStart = String(text || '').trim().slice(0, 160).toLowerCase();
    if(contentType.includes('text/html')) return true;
    if(bodyStart.startsWith('<!doctype') || bodyStart.startsWith('<html') || bodyStart.includes('<body')) return true;
    const status = Number(response?.status) || 0;
    return status === 404 || status === 405 || status === 501;
  }

  async function fetchStatePayload(apiBase, signal){
    const response = await fetch(buildApiUrl(apiBase), {
      method:'GET',
      headers:{ 'Accept':'application/json' },
      cache:'no-store',
      credentials:'omit',
      keepalive:false,
      signal
    });
    const text = await response.text();
    if(canRetryDirectApi(apiBase) && looksLikeBrokenSameOriginApi(response, text)){
      const retry = new Error('Cloudflare Pages /api proxy did not return JSON; retrying direct Worker.');
      retry.taifRetryDirectApi = true;
      throw retry;
    }
    if(!response.ok){
      const error = new Error(`Cloudflare public display failed: ${response.status} ${text}`);
      error.status = response.status;
      throw error;
    }
    const payload = parseJsonPayload(text);
    if(!payload){
      const error = new Error('Cloudflare public display returned non-JSON response.');
      error.status = 0;
      throw error;
    }
    return payload?.state || payload?.payload || payload;
  }

  async function callRpc(){
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutMs = Math.max(2500, Number(config.REQUEST_TIMEOUT_MS || 7000));
    const timeoutId = controller ? root.setTimeout(() => controller.abort(), timeoutMs) : 0;

    try{
      if(!canAttemptNetworkRefresh()){
        const offlineError = new Error('لا يوجد اتصال إنترنت حاليًا، سيتم استخدام آخر أسعار محفوظة.');
        offlineError.status = 0;
        offlineError.offline = true;
        throw offlineError;
      }
      const primaryBase = normalizeUrl(config.CLOUDFLARE_API_BASE_URL || root.location?.origin || '');
      try{
        const payload = await fetchStatePayload(primaryBase, controller ? controller.signal : undefined);
        clearRefreshBackoff();
        return payload;
      }catch(error){
        if(error?.taifRetryDirectApi){
          const payload = await fetchStatePayload(getDirectApiBaseUrl(), controller ? controller.signal : undefined);
          clearRefreshBackoff();
          return payload;
        }
        throw error;
      }
    }catch(error){
      if(error?.name === 'AbortError'){
        const timeoutError = new Error('انتهت مهلة قراءة أسعار شاشة العرض من Cloudflare.');
        timeoutError.status = 408;
        throw timeoutError;
      }
      throw error;
    }finally{
      if(timeoutId) root.clearTimeout(timeoutId);
    }
  }

  function attachDisplayMeta(payload, metaSource = {}){
    const state = clonePlain(payload);
    if(!state || typeof state !== 'object' || Array.isArray(state)) return null;
    const workspace = metaSource.workspaceId || metaSource.workspace_id || state.__taifDisplayWorkspace || getWorkspaceId();
    const stateKey = metaSource.stateKey || metaSource.state_key || state.__taifDisplayStateKey || getWatchedStateKey();
    const revision = metaSource.revision ?? metaSource.__taifDisplayRevision ?? state.__taifDisplayRevision;
    const payloadHash = metaSource.payloadHash || metaSource.payload_hash || metaSource.__taifDisplayPayloadHash || state.__taifDisplayPayloadHash;
    const updatedAt = metaSource.updatedAt || metaSource.updated_at || metaSource.__taifDisplayUpdatedAt || state.__taifDisplayUpdatedAt || Date.now();
    state.__taifDisplaySource = metaSource.__taifDisplaySource || state.__taifDisplaySource || 'cloudflare_domain_state';
    state.__taifDisplayWorkspace = workspace;
    state.__taifDisplayStateKey = stateKey;
    if(revision != null) state.__taifDisplayRevision = revision;
    if(payloadHash) state.__taifDisplayPayloadHash = payloadHash;
    state.__taifDisplayUpdatedAt = typeof updatedAt === 'number' ? updatedAt : Date.parse(updatedAt) || Date.now();
    return state;
  }

  function unwrapState(value, metaSource = {}){
    if(value == null) return null;
    if(Array.isArray(value)){
      for(const item of value){
        const unwrapped = unwrapState(item, metaSource);
        if(unwrapped) return unwrapped;
      }
      return null;
    }
    if(typeof value !== 'object') return null;
    if(value.ok === false) return null;

    if(Array.isArray(value.currencies)) return attachDisplayMeta(value, metaSource);

    if(value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)){
      const sourceMeta = { ...value, ...metaSource };
      if(Array.isArray(value.payload.currencies)) return attachDisplayMeta(value.payload, sourceMeta);
      const nestedPayload = unwrapState(value.payload, sourceMeta);
      if(nestedPayload) return nestedPayload;
    }

    if(value.state && typeof value.state === 'object') return unwrapState(value.state, { ...value, ...metaSource });
    if(value.data && typeof value.data === 'object') return unwrapState(value.data, { ...value, ...metaSource });
    return null;
  }

  function sanitizeFetchedState(value, metaSource = {}){
    const state = unwrapState(value, metaSource);
    if(!state || typeof state !== 'object' || Array.isArray(state)) return null;
    if(!Array.isArray(state.currencies)) return null;
    if(!Array.isArray(state.rateBooks)) state.rateBooks = [];
    if(!Array.isArray(state.pairRegistry)) state.pairRegistry = [];
    if(!Array.isArray(state.rateRecords)) state.rateRecords = [];
    return state;
  }

  async function fetchState(){
    try{
      return await callRpc(config.RPC_NAME || 'taif_public_price_display_state');
    }catch(primaryError){
      if(config.FALLBACK_RPC_NAME){
        try{ return await callRpc(config.FALLBACK_RPC_NAME); }catch{}
      }
      throw primaryError;
    }
  }

  function renderPriceScreen(){
    if(!panel || !TAIF.__viewRenderers || typeof TAIF.__viewRenderers['price-screen'] !== 'function') return;
    try{
      TAIF.__viewRenderers['price-screen']({ panel, force:true });
      initialized = true;
    }catch(error){
      debugError('[TAIF public display] render failed', error);
      showStatus('تعذر عرض شاشة الأسعار', true);
    }
  }

  function applyState(rawState, reason = 'refresh', { force = false } = {}){
    const nextState = sanitizeFetchedState(rawState);
    if(!nextState) return false;
    writeCachedPriceState(nextState);

    const signature = stateSignature(nextState);
    if(!force && signature && signature === lastStateSignature && initialized){
      consecutiveFailures = 0;
      showStatus('');
      return true;
    }

    lastStateSignature = signature || stableStringify(nextState);
    lastAppliedAt = Date.now();
    root.__TAIF_PUBLIC_STATE__ = nextState;
    consecutiveFailures = 0;
    showStatus('');
    renderPriceScreen();

    try{
      TAIF.core?.events?.emit?.('taif:currency-domain-updated', { state:nextState, source:'public-display', reason });
    }catch{}

    return true;
  }

  async function refresh(reason = 'poll'){
    if(stopped) return;
    if(refreshInFlight){
      refreshQueued = true;
      return;
    }
    refreshInFlight = true;
    lastRefreshAt = Date.now();

    try{
      const rawState = await fetchState();
      if(applyState(rawState, reason, { force:reason === 'manual' || reason === 'first' })) return;
      if(!initialized) showStatus('لا توجد بيانات أسعار منشورة بعد من المشروع الأساسي', true);
    }catch(error){
      consecutiveFailures += 1;
      rememberRefreshFailure(error);
      logRefreshFailure(error);
      if(consecutiveFailures >= 2){
        const isMissingState = error?.status === 404;
        const isOffline = error?.offline || Number(error?.status) === 0;
        showStatus(isMissingState ? 'لم يتم نشر حالة الأسعار بعد على Cloudflare' : (isOffline ? 'لا يوجد اتصال إنترنت، يتم عرض آخر أسعار محفوظة' : 'تعذر تحديث الأسعار من Cloudflare'), true);
      }
    }finally{
      refreshInFlight = false;
      if(refreshQueued){
        refreshQueued = false;
        root.setTimeout(() => refresh('queued'), 40);
      }
    }
  }

  function startPolling(){
    if(pollTimer) root.clearInterval(pollTimer);
    const interval = Math.max(60000, Number(config.POLL_INTERVAL_MS || 60000));
    pollTimer = root.setInterval(() => refresh('poll'), interval);
  }

  function bindLifecycleRefresh(){
    root.addEventListener('online', () => { clearRefreshBackoff(); refresh('online'); });
    root.addEventListener('offline', () => { retryBackoffUntil = Date.now() + PRICE_DISPLAY_BACKOFF_MAX_MS; persistRefreshBackoff(); showStatus('لا يوجد اتصال إنترنت، يتم عرض آخر أسعار محفوظة', true); });
    root.addEventListener('focus', () => refresh('focus'));
    root.addEventListener('pageshow', () => refresh('pageshow'));
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState === 'visible') refresh('visible');
    });
    root.addEventListener('beforeunload', () => {
      stopped = true;
      if(pollTimer) root.clearInterval(pollTimer);
      const cleanup = TAIF.__viewCleanups && TAIF.__viewCleanups['price-screen'];
      if(typeof cleanup === 'function'){
        try{ cleanup(); }catch{}
      }
    });
  }

  function start(){
    const cachedState = readCachedPriceState();
    if(cachedState){
      applyState(cachedState, 'cache', { force:true });
    }else{
      showStatus('جاري تحميل أسعار طيف...', Boolean(config.SHOW_STATUS));
    }
    restoreRefreshBackoff();
    const firstDelay = cachedState ? 4500 : 1000;
    root.setTimeout(() => refresh('first'), firstDelay);
    startPolling();
    bindLifecycleRefresh();
  }

  TAIF.publicPriceDisplay = Object.assign(TAIF.publicPriceDisplay || {}, {
    version:'cloudflare-d1-public-price-display-v1',
    refresh:() => refresh('manual'),
    diagnostics:() => ({
      initialized,
      consecutiveFailures,
      workspaceId:getWorkspaceId(),
      stateKey:getWatchedStateKey(),
      stateSignature:lastStateSignature,
      lastAppliedAt,
      lastRefreshAt,
      retryBackoffUntil,
      pollIntervalMs:Math.max(60000, Number(config.POLL_INTERVAL_MS || 60000)),
      cloudflareApiBaseUrl:normalizeUrl(config.CLOUDFLARE_API_BASE_URL || '')
    })
  });

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', start, { once:true });
  }else{
    start();
  }
})();
