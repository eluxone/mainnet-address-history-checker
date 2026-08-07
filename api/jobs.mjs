import {requireUser,sb,json} from './_auth.mjs';

export default async function handler(req,res){
  try{
    if(req.method!=='GET'){res.setHeader('Allow','GET');return json(res,405,{error:'Method not allowed.'})}
    const user=await requireUser(req);const c=user.c;const filter=user.role==='admin'?'':`&user_id=eq.${encodeURIComponent(user.id)}`;
    const [btc,evm,users]=await Promise.all([
      sb(c,`btc_background_jobs?select=*&order=created_at.desc&limit=200${filter}`),
      sb(c,`evm_background_jobs?select=*&order=created_at.desc&limit=200${filter}`),
      user.role==='admin'?sb(c,'app_users?select=id,username,display_name&limit=500'):Promise.resolve([{id:user.id,username:user.username,display_name:user.display_name}])
    ]);
    const owners=new Map((users||[]).map(x=>[x.id,x]));
    const jobs=[...(btc||[]).map(j=>({chain:'BTC',kind:'btc',...j,owner:owners.get(j.user_id)||null,total:Number(j.candidate_count||j.filters?.candidateLimit||0),matches:Number(j.matched_count||0)})),...(evm||[]).map(j=>({chain:'EVM',kind:'evm',...j,owner:owners.get(j.user_id)||null,total:Array.isArray(j.items)?j.items.length:0,matches:Number(j.matched_count||0)}))].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
    return json(res,200,{jobs,user:{id:user.id,username:user.username,role:user.role}});
  }catch(e){return json(res,e.status||500,{error:e.message||'Unable to load background jobs.'})}
}
