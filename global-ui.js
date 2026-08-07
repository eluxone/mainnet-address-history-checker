'use strict';
(()=>{
  const pages=Array.isArray(window.__SITE_PAGES__)?window.__SITE_PAGES__:[];
  const fallback=[
    {href:'/',label:'EVM Recovery & Address Auditor',file:'index.html'},
    {href:'/recover',label:'Seed-word Recovery Assistant',file:'recovery-assistant.html'},
    {href:'/btc',label:'BTC Discovery Lab',file:'btc-discovery.html'},
    {href:'/btc-research.html',label:'BTC Research Workspace',file:'btc-research.html'}
  ];
  const items=(pages.length?pages:fallback).filter(x=>x&&x.href&&x.label&&!/login/i.test(x.file||''));
  const current=location.pathname.replace(/\/$/,'')||'/';
  const normalize=href=>{try{const p=new URL(href,location.origin).pathname.replace(/\/$/,'')||'/';return p}catch{return href}};
  const active=href=>normalize(href)===current||(current==='/btc-discovery.html'&&normalize(href)==='/btc')||(current==='/recovery-assistant.html'&&normalize(href)==='/recover');
  const iconFor=(label,file)=>{const t=`${label} ${file}`.toLowerCase();if(t.includes('btc')||t.includes('bitcoin'))return'₿';if(t.includes('recover'))return'↺';if(t.includes('approval'))return'✓';if(t.includes('wallet'))return'◇';if(t.includes('address'))return'⌁';if(t.includes('research'))return'◫';return'Ξ'};
  const descFor=(label,file)=>{const t=`${label} ${file}`.toLowerCase();if(t.includes('btc')||t.includes('bitcoin'))return'Bitcoin public-data research';if(t.includes('recover'))return'Owner-authorized recovery tools';if(t.includes('approval'))return'Public token approval research';if(t.includes('wallet'))return'Wallet and address utilities';if(t.includes('address'))return'Public address analysis';return'Crypto research tool'};

  const header=document.createElement('header');
  header.className='crypto-global-nav';
  header.innerHTML=`<div class="crypto-nav-inner">
    <a class="crypto-brand" href="/" aria-label="Crypto research home"><span class="crypto-brand-mark">◈</span><span class="crypto-brand-copy">CHAIN//LAB<small>public crypto intelligence</small></span></a>
    <nav class="crypto-desktop-links" aria-label="Primary navigation"></nav>
    <div class="crypto-nav-actions"><button class="crypto-tools-button" type="button" aria-expanded="false">All tools <span aria-hidden="true">⌄</span></button><button class="crypto-mobile-toggle" type="button" aria-label="Open navigation" aria-expanded="false"><span></span></button></div>
  </div><div class="crypto-tools-menu" role="menu"></div>`;
  document.body.prepend(header);
  const desktop=header.querySelector('.crypto-desktop-links');
  const quick=items.slice(0,Math.min(5,items.length));
  for(const item of quick){const a=document.createElement('a');a.className=`crypto-nav-link${active(item.href)?' active':''}`;a.href=item.href;a.textContent=item.shortLabel||item.label;desktop.append(a)}
  const menu=header.querySelector('.crypto-tools-menu');
  menu.innerHTML=items.map(item=>`<a role="menuitem" class="crypto-menu-item${active(item.href)?' active':''}" href="${item.href}"><span class="crypto-menu-icon">${iconFor(item.label,item.file)}</span><span class="crypto-menu-copy"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(descFor(item.label,item.file))}</small></span></a>`).join('');

  const drawer=document.createElement('div');drawer.className='crypto-mobile-drawer';drawer.innerHTML=`<div class="crypto-mobile-backdrop"></div><aside class="crypto-mobile-sheet" aria-label="Mobile navigation"><div class="crypto-mobile-section-title">All crypto tools</div>${items.map(item=>`<a class="crypto-mobile-link${active(item.href)?' active':''}" href="${item.href}"><span class="crypto-menu-icon">${iconFor(item.label,item.file)}</span><span>${escapeHtml(item.label)}</span></a>`).join('')}</aside>`;document.body.append(drawer);
  const toolsBtn=header.querySelector('.crypto-tools-button'),mobileBtn=header.querySelector('.crypto-mobile-toggle');
  const closeAll=()=>{menu.classList.remove('open');drawer.classList.remove('open');toolsBtn?.setAttribute('aria-expanded','false');mobileBtn?.setAttribute('aria-expanded','false');document.body.style.overflow=''};
  toolsBtn?.addEventListener('click',()=>{const open=!menu.classList.contains('open');closeAll();if(open){menu.classList.add('open');toolsBtn.setAttribute('aria-expanded','true')}});
  mobileBtn?.addEventListener('click',()=>{const open=!drawer.classList.contains('open');closeAll();if(open){drawer.classList.add('open');mobileBtn.setAttribute('aria-expanded','true');document.body.style.overflow='hidden'}});
  drawer.querySelector('.crypto-mobile-backdrop')?.addEventListener('click',closeAll);document.addEventListener('keydown',e=>{if(e.key==='Escape')closeAll()});document.addEventListener('click',e=>{if(menu.classList.contains('open')&&!header.contains(e.target))closeAll()});

  const hero=document.querySelector('.hero');if(hero&&!hero.querySelector('.crypto-page-chip')){const chip=document.createElement('div');chip.className='crypto-page-chip';chip.textContent='Encrypted public-data workspace';const copy=hero.querySelector('div:last-child');copy?.prepend(chip)}

  const introSeen=sessionStorage.getItem('crypto-intro-seen')==='1';
  if(!introSeen){
    const intro=document.createElement('div');intro.className='crypto-intro';intro.setAttribute('role','dialog');intro.setAttribute('aria-label','Welcome');intro.innerHTML=`<div class="crypto-intro-grid"></div><div class="crypto-intro-glow"></div><div class="crypto-intro-content"><div class="crypto-intro-kicker">CHAIN//LAB · 2026</div><h1>Step into the anonymous world</h1><p>Research smarter. Move through crypto with clarity.</p><button type="button" class="crypto-enter">Enter the network</button></div>`;document.body.append(intro);
    const dismiss=()=>{if(intro.classList.contains('hidden'))return;sessionStorage.setItem('crypto-intro-seen','1');intro.classList.add('hidden');setTimeout(()=>intro.remove(),800)};intro.querySelector('.crypto-enter')?.addEventListener('click',dismiss);setTimeout(dismiss,4300);
  }

  function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
})();
