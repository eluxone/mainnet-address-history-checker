import {requireUser,json} from './_auth.mjs';
export default async function handler(req,res){try{const u=await requireUser(req);return json(res,200,{user:{id:u.id,username:u.username,displayName:u.display_name,role:u.role,lastLoginAt:u.last_login_at}})}catch(e){return json(res,e.status||500,{error:e.message})}}
