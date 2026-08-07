'use strict';
(()=>{
  if(document.querySelector('script[data-btc-features]')) return;
  const loadBackground=()=>{
    if(document.querySelector('script[data-btc-background]')) return;
    const b=document.createElement('script');
    b.src='/btc-background.js';
    b.defer=true;
    b.dataset.btcBackground='1';
    document.head.appendChild(b);
  };
  const loadExtended=()=>{
    if(document.querySelector('script[data-btc-features-extended]')) return loadBackground();
    const x=document.createElement('script');
    x.src='/btc-features-8-12.js';
    x.defer=true;
    x.dataset.btcFeaturesExtended='1';
    x.addEventListener('load',loadBackground,{once:true});
    x.addEventListener('error',loadBackground,{once:true});
    document.head.appendChild(x);
  };
  const loadFeatures=()=>{
    const s=document.createElement('script');
    s.src='/btc-features.js';
    s.defer=true;
    s.dataset.btcFeatures='1';
    s.addEventListener('load',loadExtended,{once:true});
    document.head.appendChild(s);
  };
  const auth=document.createElement('script');
  auth.src='/btc-session-auth.js';
  auth.defer=true;
  auth.dataset.btcSessionAuth='1';
  auth.addEventListener('load',loadFeatures,{once:true});
  auth.addEventListener('error',loadFeatures,{once:true});
  document.head.appendChild(auth);
})();
