import { handleCallback, send as sendQueue } from '@vercel/queue';

const TOPIC='btc-background-scan';
const MAX_PROVIDER_RETRIES=8;

function cfg(){try{const u=new URL(process.env.SUPABASE_URL?.trim());let p=u.pathname.replace(/\/+$/,'');if(!p||p==='/')p='/rest/v1';else if(!p.endsWith('/rest/v1'))p+='/rest/v1';u.pathname=p;u.search='';u.hash='';const key=process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SERVICE_KEY;return key?{url:u.toString().replace(/\/$/,''),key}:null}catch{return null}}
async function sb(c,path,opt={}){const r=await fetch(`${c.url}/${path}`,{...opt,headers:{apikey:c.key,Authorization:`Bearer ${c.key}`,'Content-Type':'application/json',Accept:'application/json',...(opt.headers||{})}});const t=await r.text();let d=null;try{d=t?JSON.parse(t):null}catch{}if(!r.ok)throw new Error(d?.message||d?.hint||d?.code||`Supabase ${r.status}`);return d}
async function notify(c,job,kind,title,message){if(!job?.user_id)return;try{await sb(c,'user_notifications',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({user_id:job.user_id,kind,title,message,entity_type:'btc_background_job',entity_id:job.id})})}catch{}}
function deploymentBase(){const host=process.env.VERCEL_URL||process.env.VERCEL_PROJECT_PRODUCTION_URL;return host?`https://${host.replace(/^https?:\/\//,'')}`:null}
async function discovery(job){const base=deploymentBase();if(!base)throw new Error('Vercel deployment URL is unavailable.');const headers={'Content-Type':'application/json'};if(process.env.APP_ACCESS_TOKEN)headers['X-App-Access-Token']=process.env.APP_ACCESS_TOKEN;const body={...(job.filters||{}),offset:Number(job.next_offset||0)};const r=await fetch(`${base}/api/btc-discovery`,{method:'POST',headers,body:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||`BTC discovery failed (${r.status}).`);return d}
function mergeResults(existing,incoming,target){const map=new Map();for(const row of Array.isArray(existing)?existing:[])if(row?.address)map.set(row.address,row);for(const row of Array.isArray(incoming)?incoming:[])if(row?.address)map.set(row.address,row);return [...map.values()].slice(0,Math.max(1,Number(target||100)))}
async function publishNext(jobId,offset,retryCount=0,delaySeconds=2){const options={retentionSeconds:7*24*60*60,idempotencyKey:`${jobId}:${offset}:${retryCount}`};if(delaySeconds>0)options.delaySeconds=delaySeconds;return sendQueue(TOPIC,{jobId,expectedOffset:offset,retryCount},options)}

export const POST=handleCallback(async(message,metadata)=>{
  const c=cfg();if(!c)throw new Error('Supabase is not configured.');
  const jobId=String(message?.jobId||'');const expectedOffset=Number(message?.expectedOffset||0);if(!jobId)return;
  const job=(await sb(c,`btc_background_jobs?select=*&id=eq.${encodeURIComponent(jobId)}&limit=1`))?.[0];if(!job)return;
  if(!['running','queued','waiting_provider'].includes(job.status))return;
  if(Number(job.next_offset||0)!==expectedOffset)return;

  const heartbeat=new Date().toISOString();
  await sb(c,`btc_background_jobs?id=eq.${encodeURIComponent(jobId)}&next_offset=eq.${expectedOffset}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:'running',last_heartbeat_at:heartbeat,updated_at:heartbeat,last_error:null})});

  let data;
  try{data=await discovery(job)}catch(error){await sb(c,`btc_background_jobs?id=eq.${encodeURIComponent(jobId)}&next_offset=eq.${expectedOffset}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({last_error:String(error?.message||'Background batch failed').slice(0,500),last_heartbeat_at:new Date().toISOString(),updated_at:new Date().toISOString()})});throw error}

  const target=Number(job.filters?.target||25);const merged=mergeResults(job.results,data.results,target);const previousMatches=Number(job.matched_count||0);const nextOffset=Number(data.nextOffset??expectedOffset);const candidateCount=Number(data.candidateCount||job.candidate_count||0);const bigqueryBytes=Number(job.bigquery_bytes||0)+Number(data.bigQueryBytesProcessed||0);const cacheHits=Number(job.address_cache_hits||0)+Number(data.addressCacheHits||0);const providerErrors=Number(data.providerErrors||0);const retryRequired=Boolean(data.retryRequired)||providerErrors>0;const reached=merged.length>=target;const noMore=!Boolean(data.hasMore)&&!retryRequired;let status='running';let retryCount=0;

  if(reached)status='target_reached';else if(noMore)status='complete';else if(retryRequired){retryCount=Number(job.retry_count||0)+1;status=retryCount>=MAX_PROVIDER_RETRIES?'waiting_provider':'running'}
  const now=new Date().toISOString();
  const patch={status,candidate_count:candidateCount,next_offset:nextOffset,checked_count:nextOffset,matched_count:merged.length,results:merged,bigquery_bytes:String(bigqueryBytes),address_cache_hits:cacheHits,provider_errors:providerErrors,retry_count:retryCount,last_error:retryRequired?`${providerErrors} public provider check${providerErrors===1?'':'s'} waiting for retry.`:null,last_heartbeat_at:now,updated_at:now};
  if(['complete','target_reached'].includes(status))patch.completed_at=now;
  const updated=await sb(c,`btc_background_jobs?id=eq.${encodeURIComponent(jobId)}&next_offset=eq.${expectedOffset}&status=in.(running,queued,waiting_provider)`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify(patch)});
  if(!updated?.length)return;

  if(merged.length>previousMatches)await notify(c,job,'activity','BTC activity match found',`${merged.length-previousMatches} new public address match${merged.length-previousMatches===1?'':'es'} found in “${job.name||'BTC scan'}”.`);
  if(status==='target_reached')await notify(c,job,'success','BTC target reached',`“${job.name||'BTC scan'}” reached ${merged.length} matching public addresses after ${nextOffset} checked candidates.`);
  else if(status==='complete')await notify(c,job,'success','BTC background scan complete',`“${job.name||'BTC scan'}” completed with ${merged.length} matching public addresses.`);
  else if(status==='waiting_provider')await notify(c,job,'warning','BTC scan waiting for provider',`“${job.name||'BTC scan'}” paused after repeated public-provider failures. Resume it when providers recover.`);

  if(status==='running'){
    const delay=retryRequired?Math.min(120,10*Math.max(1,retryCount)):2;const q=await publishNext(jobId,nextOffset,retryCount,delay);await sb(c,`btc_background_jobs?id=eq.${encodeURIComponent(jobId)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({queue_message_id:q.messageId||null,updated_at:new Date().toISOString()})});
  }
},{retry:(error,metadata)=>{if(metadata.deliveryCount>10)return{acknowledge:true};return{afterSeconds:Math.min(300,Math.max(10,2**Math.min(metadata.deliveryCount,8)))}}});
