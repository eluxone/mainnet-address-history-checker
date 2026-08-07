'use strict';
(()=>{
  if(document.querySelector('script[data-btc-features]')) return;
  const loadExtended=()=>{
    if(document.querySelector('script[data-btc-features-extended]')) return;
    const x=document.createElement('script');
    x.src='/btc-features-8-12.js';
    x.defer=true;
    x.dataset.btcFeaturesExtended='1';
    document.head.appendChild(x);
  };
  const s=document.createElement('script');
  s.src='/btc-features.js';
  s.defer=true;
  s.dataset.btcFeatures='1';
  s.addEventListener('load',loadExtended,{once:true});
  document.head.appendChild(s);
})();
