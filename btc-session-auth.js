'use strict';
(()=>{
  const KEY='btc_app_access_token_session';
  const input=document.querySelector('#btc-access-token');
  if(!input)return;
  try{
    const saved=sessionStorage.getItem(KEY)||'';
    if(saved&&!input.value)input.value=saved;
  }catch{}
  const persist=()=>{
    try{
      if(input.value)sessionStorage.setItem(KEY,input.value);
      else sessionStorage.removeItem(KEY);
    }catch{}
  };
  input.addEventListener('input',persist);
  input.addEventListener('change',persist);
  if(!document.querySelector('#btc-session-passcode-help')){
    const wrap=document.createElement('div');
    wrap.id='btc-session-passcode-help';
    wrap.className='inline-actions compact-actions';
    wrap.style.marginTop='8px';
    const note=document.createElement('span');
    note.className='field-help';
    note.style.margin='8px 0 0';
    note.textContent=input.value?'App passcode restored for this browser session.':'Enter the app passcode once; it will be reused only for this browser session.';
    const clear=document.createElement('button');
    clear.type='button';
    clear.className='secondary small-button';
    clear.textContent='Clear session passcode';
    clear.addEventListener('click',()=>{
      input.value='';
      persist();
      note.textContent='Session passcode cleared.';
      input.focus();
    });
    input.insertAdjacentElement('afterend',wrap);
    wrap.append(note,clear);
    input.addEventListener('input',()=>{note.textContent=input.value?'App passcode saved for this browser session.':'Enter the app passcode once; it will be reused only for this browser session.';});
  }
})();
