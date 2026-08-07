import {requireUser,sb,json,logActivity} from './_auth.mjs';

export default async function handler(req,res){
  try{
    const user=await requireUser(req);
    const c=user.c;
    if(req.method==='GET'){
      const rows=await sb(c,`user_notifications?select=*&user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc&limit=200`);
      const unread=(rows||[]).filter(x=>!x.read_at).length;
      return json(res,200,{notifications:rows||[],unread});
    }
    if(req.method==='POST'){
      const b=req.body||{};const action=String(b.action||'');
      if(action==='read_all'){
        await sb(c,`user_notifications?user_id=eq.${encodeURIComponent(user.id)}&read_at=is.null`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({read_at:new Date().toISOString()})});
        await logActivity(c,user,'notifications_read_all',{tool:'notifications'});
        return json(res,200,{ok:true});
      }
      const id=String(b.id||'').trim();if(!id)return json(res,400,{error:'Missing notification id.'});
      if(action==='read'){
        const rows=await sb(c,`user_notifications?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(user.id)}`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({read_at:new Date().toISOString()})});
        if(!rows?.length)return json(res,404,{error:'Notification not found.'});
        return json(res,200,{ok:true,notification:rows[0]});
      }
      if(action==='delete'){
        await sb(c,`user_notifications?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(user.id)}`,{method:'DELETE',headers:{Prefer:'return=minimal'}});
        return json(res,200,{ok:true});
      }
      return json(res,400,{error:'Unknown notification action.'});
    }
    res.setHeader('Allow','GET, POST');return json(res,405,{error:'Method not allowed.'});
  }catch(e){return json(res,e.status||500,{error:e.message||'Notification request failed.'})}
}
