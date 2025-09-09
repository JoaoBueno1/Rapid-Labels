// Shared camera scanner using @zxing/browser
(function(){
  let reader = null;
  let controls = null;
  let targetInputId = null;
  let afterScanCallback = null;
  let loadingLib = false;
  let retryTimer = null;

  function setError(msg){
    const el = document.getElementById('scanError');
    if (el){ el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none'; }
  }

  function hasZXing(){
    return !!(window.ZXingBrowser && ZXingBrowser.BrowserMultiFormatReader) || !!window.BrowserMultiFormatReader;
  }

  function ensureReader(){
    if (!reader && hasZXing()){
      const Ctor = (window.ZXingBrowser && ZXingBrowser.BrowserMultiFormatReader) || window.BrowserMultiFormatReader;
      try { reader = new Ctor(); } catch(e){ reader = null; }
    }
    return reader;
  }

  function loadZXingScript(cb){
    if (hasZXing()){ cb && cb(); return; }
    if (loadingLib){ return; }
    loadingLib = true;
    setError('Loading camera decoder…');
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/@zxing/browser@0.1.5/umd/index.min.js';
    s.async = true;
    s.onload = () => { loadingLib = false; setTimeout(()=>{ cb && cb(); }, 30); };
  s.onerror = () => { loadingLib = false; setError('Failed to load scanning library.'); };
    document.head.appendChild(s);
  }

  function startDecoding(){
    const videoId = 'scanVideo';
    const readerInstance = ensureReader();
  if (!readerInstance){ setError('Scanner not available (library not loaded).'); return; }

    // Security context check (some browsers block camera on insecure origins)
    if (location.protocol !== 'https:' && location.hostname !== 'localhost'){
  setError('Camera access requires HTTPS or localhost. Use https:// or run on localhost.');
      return;
    }

    try {
      // Prefer rear camera, fallback to user.
      const constraintsPref = { video: { facingMode: { ideal: 'environment' } } };
      const constraintsFallback = { video: { facingMode: 'user' } };
      const handleResult = (result, err, ctrl) => {
        controls = ctrl;
        if (result){
          const text = result.getText ? result.getText() : (result.text || '');
          const input = document.getElementById(targetInputId);
          if (input){ input.value = text; input.placeholder = text; }
          window.closeScanModal();
          if (afterScanCallback){ try { afterScanCallback(); } catch(e){} }
        } else if (err && err.name === 'NotAllowedError'){
          setError('Permission denied to use camera.');
        } else if (err && err.name === 'NotFoundError'){
          setError('No camera device found.');
        }
      };

      if (readerInstance.decodeFromConstraints){
        readerInstance.decodeFromConstraints(constraintsPref, videoId, (res, err, ctrl)=>{
          // If initial attempt fails due to camera not found, retry with front camera
            if (err && (err.name === 'NotFoundError' || err.message?.includes('Overconstrained'))){
              try { controls && controls.stop && controls.stop(); } catch{};
              readerInstance.reset && readerInstance.reset();
              readerInstance.decodeFromConstraints(constraintsFallback, videoId, handleResult);
            } else {
              handleResult(res, err, ctrl);
            }
        });
      } else if (readerInstance.decodeFromVideoDevice){
        // Generic fallback API
        readerInstance.decodeFromVideoDevice(undefined, videoId, handleResult);
      } else {
        setError('API de decodificação indisponível.');
      }
    } catch (e){
      console.warn('[scanner] error starting camera', e);
  setError('Could not access camera. Check permissions.');
    }
  }

  window.openScanModal = function(inputId, callback){
    targetInputId = inputId;
    afterScanCallback = typeof callback === 'function' ? callback : (typeof callback === 'string' ? (window[callback] || null) : null);
    setError('');
    const modal = document.getElementById('scanModal');
    if(!modal){ console.warn('scanModal not found'); return; }
    modal.classList.remove('hidden');

    // If library missing (e.g. service worker served cached old HTML), try dynamic load then start.
    if (!hasZXing()){
      loadZXingScript(()=>{
        ensureReader();
        startDecoding();
      });
      return;
    }
    ensureReader();
    startDecoding();
  };

  window.closeScanModal = function(){
    const modal = document.getElementById('scanModal');
    if(modal){ modal.classList.add('hidden'); }
    setError('');
    if (retryTimer){ clearTimeout(retryTimer); retryTimer=null; }
    if (controls && controls.stop){ try { controls.stop(); } catch(e){} }
    controls = null;
    if (reader && reader.reset){ try { reader.reset(); } catch(e){} }
  };

  // Keyboard wedge (physical barcode scanner) detection
  let scanBuffer = '';
  let lastKeyTime = 0;
  const SCAN_TIMEOUT = 80; // ms gap to keep buffering
  const MIN_SCAN_LEN = 4;
  document.addEventListener('keydown', (e)=>{
    // Ignore if user is typing inside an input
    if (e.target && (e.target.tagName === 'INPUT' || e.target.isContentEditable)) return;
    const now = Date.now();
    if (now - lastKeyTime > SCAN_TIMEOUT){ scanBuffer=''; }
    lastKeyTime = now;
    if (e.key === 'Enter'){
      if (scanBuffer.length >= MIN_SCAN_LEN){
        const val = scanBuffer;
        const searchInput = document.getElementById('collectionsSearch') || document.getElementById('historySearch');
        if (searchInput){
          searchInput.value = val;
          searchInput.placeholder = val;
          if (typeof window.filterCollections === 'function') { window.filterCollections(); }
          if (typeof window.filterHistory === 'function') { window.filterHistory(); }
        }
      }
      scanBuffer='';
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey){
      scanBuffer += e.key;
    }
  });
})();
