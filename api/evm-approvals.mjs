import { Interface, id } from 'ethers';
import {requireUser,logActivity,json} from './_auth.mjs';

const ADDRESS=/^0x[a-fA-F0-9]{40}$/;
const MAX_LOOKBACK=2_000_000,DEFAULT_LOOKBACK=500_000,CHUNK=100_000,MAX_EVENTS=120;
const APPROVAL=id('Approval(address,address,uint256)');
const APPROVAL_ALL=id('ApprovalForAll(address,address,bool)');
const ZERO='0x0000000000000000000000000000000000000000';
const ERC20=new Interface(['function allowance(address owner,address spender) view returns (uint256)']);
const ERC721=new Interface(['function getApproved(uint256 tokenId) view returns (address)']);
const NFT=new Interface(['function isApprovedForAll(address owner,address operator) view returns (bool)']);

function networks(key){const k=encodeURIComponent(key);return[
  {key:'ethereum',label:'Ethereum Mainnet',endpoint:`https://eth-mainnet.g.alchemy.com/v2/${k}`,explorer:'https://etherscan.io/tx/'},
  {key:'base',label:'Base Mainnet',endpoint:`https://base-mainnet.g.alchemy.com/v2/${k}`,explorer:'https://basescan.org/tx/'},
  {key:'optimism',label:'OP Mainnet',endpoint:`https://opt-mainnet.g.alchemy.com/v2/${k}`,explorer:'https://optimistic.etherscan.io/tx/'}
]}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function rpc(endpoint,method,params){let last;for(let attempt=0;attempt<3;attempt++){const ctl=new AbortController(),tm=setTimeout(()=>ctl.abort(),15000);try{const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:ctl.signal});const d=await r.json().catch(()=>({}));if((r.status===429||r.status>=500||d.error?.code===429)&&attempt<2){await sleep(700*(2**attempt));continue}if(!r.ok||d.error)throw new Error(d.error?.message||`Provider request failed (${r.status}).`);return d.result}catch(e){last=e;if(attempt<2)await sleep(700*(2**attempt));else throw e}finally{clearTimeout(tm)}}throw last}
function ownerTopic(owner){return`0x${owner.toLowerCase().slice(2).padStart(64,'0')}`}
function topicAddress(topic){return`0x${String(topic||'').slice(-40)}`.toLowerCase()}
function hexInt(v){try{return BigInt(v||'0x0')}catch{return 0n}}
async function ethCall(endpoint,to,data){return rpc(endpoint,'eth_call',[{to,data},'latest'])}
async function currentState(net,owner,event){try{
  if(event.kind==='erc20'){
    const data=ERC20.encodeFunctionData('allowance',[owner,event.spender]);const raw=await ethCall(net.endpoint,event.contract,data);const [allowance]=ERC20.decodeFunctionResult('allowance',raw);const n=BigInt(allowance);return{state:n>0n?'active':'revoked',currentValue:n.toString(),risk:n>(1n<<255n)?'very_large_allowance':n>0n?'active_allowance':'revoked'}
  }
  if(event.kind==='erc721_token'){
    const data=ERC721.encodeFunctionData('getApproved',[event.tokenId]);const raw=await ethCall(net.endpoint,event.contract,data);const [approved]=ERC721.decodeFunctionResult('getApproved',raw);const active=String(approved).toLowerCase()===event.spender.toLowerCase()&&event.spender!==ZERO;return{state:active?'active':'revoked',currentValue:String(approved),risk:active?'token_approval':'revoked'}
  }
  const data=NFT.encodeFunctionData('isApprovedForAll',[owner,event.spender]);const raw=await ethCall(net.endpoint,event.contract,data);const [approved]=NFT.decodeFunctionResult('isApprovedForAll',raw);return{state:approved?'active':'revoked',currentValue:Boolean(approved),risk:approved?'operator_access':'revoked'}
}catch(e){return{state:'unknown',currentValue:null,risk:'unknown',validationError:e.message}}
}
function decodeLog(net,log){const sig=String(log.topics?.[0]||'').toLowerCase();const contract=String(log.address||'').toLowerCase();const block=Number.parseInt(log.blockNumber||'0x0',16);const tx=String(log.transactionHash||'');if(sig===APPROVAL.toLowerCase()){
  const spender=topicAddress(log.topics?.[2]);if((log.topics||[]).length>=4){const tokenId=hexInt(log.topics[3]).toString();return{network:net.key,networkLabel:net.label,contract,spender,kind:'erc721_token',label:'ERC-721 token approval',tokenId,eventValue:spender,eventApproved:spender!==ZERO,blockNumber:block,transactionHash:tx,explorer:`${net.explorer}${tx}`}}
  const value=hexInt(log.data).toString();return{network:net.key,networkLabel:net.label,contract,spender,kind:'erc20',label:'ERC-20 allowance event',tokenId:null,eventValue:value,eventApproved:BigInt(value)>0n,blockNumber:block,transactionHash:tx,explorer:`${net.explorer}${tx}`}
}
  if(sig===APPROVAL_ALL.toLowerCase()){const spender=topicAddress(log.topics?.[2]),approved=hexInt(log.data)!==0n;return{network:net.key,networkLabel:net.label,contract,spender,kind:'operator',label:'NFT operator approval',tokenId:null,eventValue:approved,eventApproved:approved,blockNumber:block,transactionHash:tx,explorer:`${net.explorer}${tx}`}}
  return null
}
function keyFor(e){return`${e.network}|${e.contract}|${e.kind}|${e.spender}|${e.tokenId||''}`}
async function scanNetwork(net,owner,lookback){const latestHex=await rpc(net.endpoint,'eth_blockNumber',[]),latest=Number.parseInt(latestHex,16),start=Math.max(0,latest-lookback+1),logs=[];for(let to=latest;to>=start&&logs.length<MAX_EVENTS*5;){const from=Math.max(start,to-CHUNK+1);try{const part=await rpc(net.endpoint,'eth_getLogs',[{fromBlock:`0x${from.toString(16)}`,toBlock:`0x${to.toString(16)}`,topics:[[APPROVAL,APPROVAL_ALL],ownerTopic(owner)]}]);if(Array.isArray(part))logs.push(...part)}catch{}to=from-1;await sleep(80)}const decoded=logs.map(x=>decodeLog(net,x)).filter(Boolean).sort((a,b)=>b.blockNumber-a.blockNumber);const unique=[];const seen=new Set();for(const e of decoded){const k=keyFor(e);if(seen.has(k))continue;seen.add(k);unique.push(e);if(unique.length>=MAX_EVENTS)break}const out=[];for(let i=0;i<unique.length;i+=6){const batch=unique.slice(i,i+6);const checked=await Promise.all(batch.map(async e=>({...e,...await currentState(net,owner,e)})));out.push(...checked)}return{latestBlock:latest,startBlock:start,events:out}}

export default async function handler(req,res){try{if(req.method!=='POST'){res.setHeader('Allow','POST');return json(res,405,{error:'Method not allowed.'})}const user=await requireUser(req);const apiKey=process.env.ALCHEMY_API_KEY;if(!apiKey)return json(res,503,{error:'ALCHEMY_API_KEY is not configured.'});const b=req.body||{},owner=String(b.address||'').trim();if(!ADDRESS.test(owner))return json(res,400,{error:'Enter a valid public EVM address.'});const lookback=Math.max(50_000,Math.min(MAX_LOOKBACK,Number.isSafeInteger(Number(b.lookbackBlocks))?Number(b.lookbackBlocks):DEFAULT_LOOKBACK));const results=await Promise.all(networks(apiKey).map(n=>scanNetwork(n,owner,lookback)));const events=results.flatMap(x=>x.events).sort((a,b)=>b.blockNumber-a.blockNumber);const summary={events:events.length,active:events.filter(x=>x.state==='active').length,revoked:events.filter(x=>x.state==='revoked').length,unknown:events.filter(x=>x.state==='unknown').length,veryLargeAllowances:events.filter(x=>x.risk==='very_large_allowance').length,operatorApprovals:events.filter(x=>x.state==='active'&&x.kind==='operator').length};await logActivity(user.c,user,'evm_approval_research',{tool:'evm_approvals',entityType:'address',entityId:owner,metadata:{lookbackBlocks:lookback,events:events.length,active:summary.active}});return json(res,200,{address:owner,lookbackBlocks:lookback,summary,networks:results.map((x,i)=>({key:networks(apiKey)[i].key,label:networks(apiKey)[i].label,startBlock:x.startBlock,latestBlock:x.latestBlock,eventCount:x.events.length})),events,checkedAt:new Date().toISOString(),disclaimer:'Read-only public-chain approval research. The selected historical block window may not include older approvals; unknown validation results are not treated as active or revoked.'})}catch(e){return json(res,e.status||502,{error:e.message||'Unable to research EVM approvals.'})}}
