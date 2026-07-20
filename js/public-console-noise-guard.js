(()=>{
  'use strict';
  const EXTENSION_ASYNC_MESSAGE = 'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received';
  function messageOf(value){ return String(value?.message || value || ''); }
  function isNoise(value){
    const message = messageOf(value);
    return message.includes(EXTENSION_ASYNC_MESSAGE) || /net::ERR_INTERNET_DISCONNECTED|Failed to fetch|NetworkError|Load failed/i.test(message);
  }
  window.addEventListener('unhandledrejection', (event) => {
    if(isNoise(event?.reason)){ try{ event.preventDefault(); }catch{} return false; }
    return undefined;
  }, true);
  window.addEventListener('error', (event) => {
    if(isNoise(event?.error || event?.message)){ try{ event.preventDefault(); }catch{} return false; }
    return undefined;
  }, true);
})();
