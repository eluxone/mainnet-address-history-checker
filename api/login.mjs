import { createSessionCookie,clearSessionCookie,hashPassword,verifyPassword,normalizeSecret,supabaseConfig,sb,logActivity,json,decodeSession } from './_auth.mjs';

const BUILD='2026-08-07.phase1';
function bootstrapPassword(){return normalizeSecret(process.env.SITE_PASSWORD)||normalizeSecret(process.env.WALLET_TOOL_PASSWORD)}

export default async function handler(req,res){
  const method=req.method||'GET';
  const c=supabaseConfig();
  if(!c)return json(res,503,{error:'Supabase is not configured.',build:BUILD});
  try{
    if(method==='GET'){
      const session=decodeSession(req);
      return json(res,200,{ok:true,configured:Boolean(bootstrapPassword()),authenticated:Boolean(session),build:BUILD,environment:process.env.VERCEL_ENV||'unknown'});
    }
    if(method==='DELETE')return json(res,200,{ok:true,build:BUILD},{'Set-Cookie':clearSessionCookie()});
    if(method!=='POST'){res.setHeader('Allow','GET, POST, DELETE');return json(res,405,{error:'Method not allowed.',build:BUILD})}
    const body=req.body&&typeof req.body==='object'?req.body:await new Promise((resolve,reject)=>{let d='';req.on('data',x=>d+=x);req.on('end',()=>{try{resolve(JSON.parse(d||'{}'))}catch(e){reject(e)}})});
    const username=String(body?.username||'admin').trim().toLowerCase();const password=String(body?.password||'');
    if(!/^[a-z0-9._-]{2,50}$/.test(username)||!password)return json(res,400,{error:'Enter a valid username and password.',build:BUILD});
    let user=(await sb(c,`app_users?select=*&username=ilike.${encodeURIComponent(username)}&limit=1`))?.[0];
    if(!user&&username==='admin'){
      const master=bootstrapPassword();if(!master||password!==master)return json(res,401,{error:'Incorrect administrator credentials.',build:BUILD});
      const hp=hashPassword(master);const rows=await sb(c,'app_users',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({username:'admin',display_name:'Administrator',password_salt:hp.salt,password_hash:hp.hash,role:'admin',active:true})});user=rows?.[0];
    }
    if(!user||!user.active||!verifyPassword(password,user.password_salt,user.password_hash))return json(res,401,{error:'Incorrect username or password.',build:BUILD});
    await sb(c,`app_users?id=eq.${encodeURIComponent(user.id)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({last_login_at:new Date().toISOString(),updated_at:new Date().toISOString()})});
    await logActivity(c,user,'login',{tool:'auth'});
    return json(res,200,{ok:true,user:{id:user.id,username:user.username,displayName:user.display_name,role:user.role},build:BUILD},{'Set-Cookie':createSessionCookie(user)});
  }catch(e){return json(res,e?.status||502,{error:e?.message||'Login failed.',build:BUILD})}
}
