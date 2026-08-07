'use strict';
(()=>{
  const $=s=>document.querySelector(s),list=$('#notif-list'),status=$('#notif-status');
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const req=async(opt={})=>{const r=await fetch('/api/notifications',{credentials:'same-origin',...opt,headers:{'Content-Type':'application/json',...(opt.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||`Request failed (${r.status})`);return d};
  const icon=k=>({success:'✓',warning:'!',error:'×',activity:'◆',info:'i'})[k]||'•';
  function render(rows){list.innerHTML=rows.length?rows.map(n=>`<article class="panel" style="margin:0;padding:16px;${n.read_at?'opacity:.68':''}"><div style="display:flex;gap:12px;align-items:flex-start"><div class="crypto-menu-icon">${icon(n.kind)}</div><div style="flex:1;min-width:0"><div style="display:flex;gap:10px;justify-content:space-between;align-items:flex-start"><div><strong>${esc(n.title)}</strong><p class="field-help" style="margin:.35rem 0 0">${esc(n.message)}</p></div><small class="field-help">${new Date(n.created_at).toLocaleString()}</small></div><div class="actions" style="margin-top:10px">${n.read_at?'':'<button class="secondary small-button" data-read="'+n.id+'">Mark read</button>'}<button class="secondary small-button" data-del="${n.id}">Delete</button></div></div></div></article>`).join(''):'<div class="empty-history">No notifications yet.</div>'}
  async function load(){try{const d=await req();render(d.notifications||[]);status.textContent=`${d.unread||0} unread · ${(d.notifications||[]).length} total`;}catch(e){status.textContent=e.message}}
  list.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;try{if(b.dataset.read)await req({method:'POST',body:JSON.stringify({action:'read',id:b.dataset.read})});if(b.dataset.del)await req({method:'POST',body:JSON.stringify({action:'delete',id:b.dataset.del})});await load()}catch(err){status.textContent=err.message}});
  $('#notif-refresh').onclick=load;$('#notif-read-all').onclick=async()=>{try{await req({method:'POST',body:JSON.stringify({action:'read_all'})});await load()}catch(e){status.textContent=e.message}};
  load();
})();
