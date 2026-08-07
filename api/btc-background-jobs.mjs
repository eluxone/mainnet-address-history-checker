import crypto from 'node:crypto';
import { send as sendQueue } from '@vercel/queue';

const TOPIC = 'btc-background-scan';
const MAX_RESULTS = 100;
const MAX_CANDIDATES = 10000;

function send(res,status,payload){res.setHeader('Cache-Control','no-store,max-age=0');res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('X-Content-Type-Options','nosniff');return res.status(status).json(payload)}
function eq(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y)}
function cfg(){try{const u=new URL(process.env.SUPABASE_URL?.trim());let p=u.pathname.replace(/\/+$/,'');if(!p||p==='/')p='/rest/v1';else if(!p.endsWith('/rest/v1'))p+='/rest/v1';u.pathname=p;u.search='';u.hash='';const key=process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SERVICE_KEY;return key?{url:u.toString().replace(/\/$/,''),key}:null}catch{return null}}
async function sb(c,path,opt={}){const r=await fetch(`${c.url}/${path}`,{...opt,headers:{apikey:c.key,Authorization:`Bearer ${c.key}`,'Content-Type':'application/json',Accept:'application/json',...(opt.headers||{})}});const t=await r.text();let d=null;try{d=t?JSON.parse(t):null}catch{}if(!r.ok)throw new Error(d?.message||d?.hint||d?.code||`Supabase ${r.status}`);return d}
function n(v,min,max,label){const x=Number(v);if(!Number.isFinite(x)||x<min||x>max)throw new Error(`${label} must be between ${min} and ${max}.`);return x}
function i(v,min,max,label){const x=n(v,min,max,label);if(!Number.isSafeInteger(x))throw new Error(`${label} must be a whole number.`);return x}
function cleanText(v,max=160){return String(v??'').trim().slice(0,max)}
function normalizeFilters(body){const startDate=String(body.startDate||'');const endDate=String(body.endDate||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(startDate)||!/^\d{4}-\d{2}-\d{2}$/.test(endDate))throw new Error('Enter a valid start and end date.');if(startDate>endDate)throw new Error('Start date must be on or before end date.');if(startDate<'2009-01-03')throw new Error('Start date cannot precede the Bitcoin genesis block.');const minBalanceBtc=n(body.minBalanceBtc,0,21000000,'Minimum BTC');const maxBalanceBtc=n(body.maxBalanceBtc,0,21000000,'Maximum BTC');if(minBalanceBtc>maxBalanceBtc)throw new Error('Minimum BTC cannot exceed maximum BTC.');return{startDate,endDate,minBalanceBtc,maxBalanceBtc,minInactiveDays:i(body.minInactiveDays,0,10000,'Minimum inactive days'),target:i(body.target,1,MAX_RESULTS,'Target results'),candidateLimit:i(body.candidateLimit,10,MAX_CANDIDATES,'Candidate limit'),sort:['inactive_desc','balance_desc','oldest_first'].includes(body.sort)?body.sort:'inactive_desc'}}
async function enqueue(jobId,expectedOffset=0,attemptKey='0',delaySeconds=0){const options={retentionSeconds:7*24*60*60,idempotencyKey:`${jobId}:${expectedOffset}:${attemptKey}`};if(delaySeconds>0)options.delaySeconds=delaySeconds;return sendQueue(TOPIC,{jobId,expectedOffset},options)}

export default async function handler(req,res){
  const expected=process.env.APP_ACCESS_TOKEN;if(expected&&!eq(req.headers['x-app-access-token'],expected))return send(res,401,{error:'Incorrect or missing app passcode.'});
  const c=cfg();if(!c)return send(res,503,{error:'Supabase is not configured.'});
  try{
    if(req.method==='GET'){
      const id=String(req.query?.id||'').trim();
      if(id){const rows=await sb(c,`btc_background_jobs?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);return rows?.[0]?send(res,200,{job:rows[0]}):send(res,404,{error:'Background job not found.'})}
      const rows=await sb(c,'btc_background_jobs?select=*&order=created_at.desc&limit=50');return send(res,200,{jobs:rows||[]});
    }
    if(req.method==='POST'){
      const b=req.body||{};const action=String(b.action||'create');
      if(action==='create'){
        const filters=normalizeFilters(b.filters||b);const row={name:cleanText(b.name)||`BTC ${filters.startDate} to ${filters.endDate}`,filters,status:'queued',updated_at:new Date().toISOString()};
        const rows=await sb(c,'btc_background_jobs',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(row)});const job=rows?.[0];if(!job)throw new Error('Unable to create background job.');
        const q=await enqueue(job.id,0,'initial');await sb(c,`btc_background_jobs?id=eq.${encodeURIComponent(job.id)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({queue_message_id:q.messageId||null,status:'running',started_at:new Date().toISOString(),updated_at:new Date().toISOString()})});
        return send(res,200,{job:{...job,status:'running',queue_message_id:q.messageId||null}});
      }
      const id=String(b.id||'').trim();if(!id)return send(res,400,{error:'Missing background job id.'});
      const current=(await sb(c,`btc_background_jobs?select=*&id=eq.${encodeURIComponent(id)}&limit=1`))?.[0];if(!current)return send(res,404,{error:'Background job not found.'});
      if(action==='pause'){await sb(c,`btc_background_jobs?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:'paused',updated_at:new Date().toISOString()})});return send(res,200,{ok:true,status:'paused'})}
      if(action==='cancel'){await sb(c,`btc_background_jobs?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:'cancelled',completed_at:new Date().toISOString(),updated_at:new Date().toISOString()})});return send(res,200,{ok:true,status:'cancelled'})}
      if(action==='resume'){
        if(['complete','target_reached','cancelled'].includes(current.status))return send(res,400,{error:'This job is already finished.'});
        const q=await enqueue(id,Number(current.next_offset||0),`resume-${Date.now()}`);await sb(c,`btc_background_jobs?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:'running',retry_count:0,last_error:null,queue_message_id:q.messageId||null,updated_at:new Date().toISOString()})});return send(res,200,{ok:true,status:'running'})
      }
      return send(res,400,{error:'Unknown background-job action.'});
    }
    if(req.method==='DELETE'){
      const id=String(req.query?.id||'').trim();if(!id)return send(res,400,{error:'Missing background job id.'});
      await sb(c,`btc_background_jobs?id=eq.${encodeURIComponent(id)}`,{method:'DELETE',headers:{Prefer:'return=minimal'}});return send(res,200,{ok:true});
    }
    res.setHeader('Allow','GET, POST, DELETE');return send(res,405,{error:'Method not allowed.'});
  }catch(e){return send(res,502,{error:e?.message||'Background job request failed.'})}
}
