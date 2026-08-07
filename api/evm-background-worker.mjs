import { handleCallback, send as sendQueue } from '@vercel/queue';

const TOPIC='evm-background-audit';
const DEFAULT_CATEGORIES=['external','erc20','erc721','erc1155'];
const NETWORK_PAUSE_MS=500;
function cfg(){try{const u=new URL(process.env.SUPABASE_URL?.trim());let p=u.pathname.replace(/\/+$/,'');if(!p||p==='/')p='/rest/v1';else if(!p.endsWith('/rest/v1'))p+='/rest/v1';u.pathname=p;u.search='';u.hash='';const key=process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SERVICE_KEY;return key?{url:u.toString().replace(/\/$/,''),key}:null}catch{return null}}
async function sb(c,path,opt={}){const r=await fetch(`${c.url}/${path}`,{...opt,headers:{apikey:c.key,Authorization:`Bearer ${c.key}`,'Content-Type':'application/json',Accept:'application/json',...(opt.headers||{})}});const t=await r.text();let d=null;try{d=t?JSON.parse(t):null}catch{}if(!r.ok)throw new Error(d?.message||d?.hint||d?.code||`Supabase ${r.status}`);return d}
async function notify(c,job,kind,title,message){if(!job?.user_id)return;try{await sb(c,'user_notifications',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({user_id:job.user_id,kind,title,message,entity_type:'evm_background_job',entity_id:job.id})})}catch{}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function networks(key){const k=encodeURIComponent(key);return[{key:'ethereum',label:'Ethereum Mainnet',categories:[...DEFAULT_CATEGORIES,'internal'],endpoint:`https://eth-mainnet.g.alchemy.com/v2/${k}`},{key:'base',label:'Base Mainnet',categories:DEFAULT_CATEGORIES,endpoint:`https://base-mainnet.g.alchemy.com/v2/${k}`},{key:'optimism',label:'OP Mainnet',categories:DEFAULT_CATEGORIES,endpoint:`https://opt-mainnet.g.alchemy.com/v2/${k}`}]}
async function rpc(endpoint,payload){let last;for(let a=0;a<3;a++){const ctl=new AbortController(),tm=setTimeout(()=>ctl.abort(),10000);try{const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:ctl.signal});const d=await r.json();if((r.status===429||r.status>=500)&&a<2){await sleep(800*(2**a));continue}if(!r.ok)throw new Error(d?.error?.message||`Provider ${r.status}`);return d}catch(e){last=e;if(a<2)await sleep(800*(2**a));else throw e}finally{clearTimeout(tm)}}throw last}
function batchResult(batch,id){const x=Array.isArray(batch)?batch.find(e=>e?.id===id):null;if(!x||x.error)throw new Error(x?.error?.message||'Blockchain response incomplete.');return x.result}
function weiToNative(hex){const wei=BigInt(hex||'0x0'),base=10n**18n,whole=wei/base,frac=(wei%base).toString().padStart(18,'0').replace(/0+$/,'');return frac?`${whole}.${frac.slice(0,8)}`:whole.toString()}
async function inspectNetwork(n,address){const base={fromBlock:'0x0',toBlock:'latest',category:n.categories,excludeZeroValue:false,withMetadata:false,order:'desc',maxCount:'0x1'};const batch=await rpc(n.endpoint,[{jsonrpc:'2.0',id:1,method:'eth_getBalance',params:[address,'latest']},{jsonrpc:'2.0',id:2,method:'eth_getTransactionCount',params:[address,'latest']},{jsonrpc:'2.0',id:3,method:'eth_getCode',params:[address,'latest']},{jsonrpc:'2.0',id:4,method:'alchemy_getAssetTransfers',params:[{...base,toAddress:address}]},{jsonrpc:'2.0',id:5,method:'alchemy_getAssetTransfers',params:[{...base,fromAddress:address}]}]);const bal=batchResult(batch,1),nonce=batchResult(batch,2),code=batchResult(batch,3),incoming=batchResult(batch,4),outgoing=batchResult(batch,5);const balanceWei=BigInt(bal||'0x0'),nonceN=BigInt(nonce||'0x0'),contract=Boolean(code&&code!=='0x'&&code!=='0x0'),inFound=Array.isArray(incoming?.transfers)&&incoming.transfers.length>0,outFound=Array.isArray(outgoing?.transfers)&&outgoing.transfers.length>0,activity=balanceWei>0n||nonceN>0n||contract||inFound||outFound;const evidence=[];if(balanceWei>0n)evidence.push('Non-zero native balance');if(nonceN>0n)evidence.push('Outgoing transaction count is non-zero');if(contract)evidence.push('Contract code exists at the address');if(inFound)evidence.push('Indexed incoming transfer found');if(outFound)evidence.push('Indexed outgoing transfer found');return{key:n.key,label:n.label,activityFound:activity,evidence,balanceNative:weiToNative(bal),outgoingTransactionCount:nonceN.toString(),hasContractCode:contract,incomingFound:inFound,outgoingFound:outFound}}
async function inspectAddress(apiKey,item){const out=[];for(const n of networks(apiKey)){try{out.push(await inspectNetwork(n,item.address))}catch(e){out.push({key:n.key,label:n.label,activityFound:false,evidence:[],balanceNative:'0',outgoingTransactionCount:'0',hasContractCode:false,incomingFound:false,outgoingFound:false,error:e?.message||'Unable to check network.'})}await sleep(NETWORK_PAUSE_MS)}const active=out.filter(x=>x.activityFound),failed=out.filter(x=>x.error);const result={address:item.address,index:item.index,path:item.path,activityFound:active.length>0,activeNetworks:active.map(x=>x.label),evidence:active.map(x=>`${x.label}: ${x.evidence.join(', ')||'activity found'}`),networkResults:out,networkErrorCount:failed.length,successfulNetworkCount:out.length-failed.length,failedNetworks:failed.map(({key,label,error})=>({key,label,error}))};if(result.successfulNetworkCount===0)result.error='All configured network checks failed.';return result}
async function enqueue(id,offset,delaySeconds=0){const options={retentionSeconds:24*60*60,idempotencyKey:`${id}:${offset}`};if(delaySeconds)options.delaySeconds=delaySeconds;return sendQueue(TOPIC,{jobId:id,expectedOffset:offset},options)}

export const POST=handleCallback(async(message,metadata)=>{
  const c=cfg(),apiKey=process.env.ALCHEMY_API_KEY;if(!c||!apiKey)throw new Error('Supabase or Alchemy is not configured.');
  const {jobId,expectedOffset}=message||{};if(!jobId)return;
  const job=(await sb(c,`evm_background_jobs?select=*&id=eq.${encodeURIComponent(jobId)}&limit=1`))?.[0];if(!job||!['running','queued','waiting_provider'].includes(job.status))return;
  const offset=Number(job.next_offset||0);if(Number(expectedOffset)!==offset)return;

  const heartbeat=new Date().toISOString();
  await sb(c,`evm_background_jobs?id=eq.${encodeURIComponent(jobId)}&next_offset=eq.${offset}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:'running',last_heartbeat_at:heartbeat,updated_at:heartbeat,last_error:null})});

  const items=Array.isArray(job.items)?job.items:[];
  if(offset>=items.length){const done=new Date().toISOString();await sb(c,`evm_background_jobs?id=eq.${encodeURIComponent(jobId)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:'complete',completed_at:done,updated_at:done,last_heartbeat_at:done})});await notify(c,job,'success','EVM background audit complete',`“${job.name||'EVM audit'}” completed with ${Number(job.matched_count||0)} addresses showing activity.`);return}

  const item=items[offset];
  let result;
  try{result=await inspectAddress(apiKey,item)}catch(e){await sb(c,`evm_background_jobs?id=eq.${encodeURIComponent(jobId)}&next_offset=eq.${offset}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:'waiting_provider',last_error:String(e?.message||'Provider error').slice(0,500),last_heartbeat_at:new Date().toISOString(),updated_at:new Date().toISOString()})});await notify(c,job,'warning','EVM audit waiting for provider',`“${job.name||'EVM audit'}” is waiting after a provider error and will retry.`);throw e}

  const results=Array.isArray(job.results)?job.results:[],matches=result.activityFound?[...results,result]:results;
  const checked=Number(job.checked_count||0)+1,errors=Number(job.network_error_count||0)+Number(result.networkErrorCount||0);
  let consecutiveEmpty=Number(job.consecutive_empty||0),totalFailures=Number(job.consecutive_total_failures||0);
  if(result.error){consecutiveEmpty=0;totalFailures+=1}else if(result.activityFound){consecutiveEmpty=0;totalFailures=0}else if(Number(result.successfulNetworkCount||0)>0){consecutiveEmpty+=1;totalFailures=0}else{consecutiveEmpty=0;totalFailures+=1}
  const next=offset+1;
  let status='running',completed=null,lastError=null;
  if(totalFailures>=3){status='waiting_provider';lastError='All configured networks failed for three consecutive public addresses.'}
  else if(job.stop_after_empty&&consecutiveEmpty>=Number(job.stop_after_empty)){status='complete';completed=new Date().toISOString()}
  else if(next>=items.length){status='complete';completed=new Date().toISOString()}

  const now=new Date().toISOString();
  const patch={status,next_offset:next,checked_count:checked,matched_count:matches.length,network_error_count:errors,consecutive_empty:consecutiveEmpty,consecutive_total_failures:totalFailures,retry_count:0,last_error:lastError,results:matches,last_heartbeat_at:now,updated_at:now,completed_at:completed};
  const updated=await sb(c,`evm_background_jobs?id=eq.${encodeURIComponent(jobId)}&next_offset=eq.${offset}&status=in.(running,queued,waiting_provider)`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify(patch)});
  if(!updated?.length)return;

  if(result.activityFound)await notify(c,job,'activity','EVM activity found',`Public address ${result.address.slice(0,10)}… returned activity on ${(result.activeNetworks||[]).join(', ')||'a configured network'}.`);
  if(status==='complete')await notify(c,job,'success','EVM background audit complete',`“${job.name||'EVM audit'}” completed after ${checked} checked addresses with ${matches.length} activity matches.`);
  else if(status==='waiting_provider')await notify(c,job,'warning','EVM audit waiting for provider',`“${job.name||'EVM audit'}” paused after repeated provider failures. Resume it when providers recover.`);

  if(status==='running')await enqueue(jobId,next,1);
},{retry:(error,metadata)=>{if(metadata.deliveryCount>10)return{acknowledge:true};return{afterSeconds:Math.min(300,Math.max(10,2**Math.min(metadata.deliveryCount,8)))}}});
