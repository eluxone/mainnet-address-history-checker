import { HDNodeWallet, getBytes, sha256, ripemd160, encodeBase58, wordlists } from 'ethers';

function bytes(hex){return getBytes(hex)}
function join(...parts){const n=parts.reduce((a,p)=>a+p.length,0),out=new Uint8Array(n);let o=0;for(const p of parts){out.set(p,o);o+=p.length}return out}
function hash160(data){return bytes(ripemd160(bytes(sha256(data))))}
function dblSha(data){return bytes(sha256(bytes(sha256(data))))}
function b58(version,payload){const body=join(new Uint8Array([version]),payload);return encodeBase58(join(body,dblSha(body).slice(0,4)))}
function convertBits(data,from,to,pad=true){let acc=0,bits=0;const ret=[],maxv=(1<<to)-1,maxAcc=(1<<(from+to-1))-1;for(const value of data){acc=((acc<<from)|value)&maxAcc;bits+=from;while(bits>=to){bits-=to;ret.push((acc>>bits)&maxv)}}if(pad&&bits)ret.push((acc<<(to-bits))&maxv);return ret}
function polymod(values){const g=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];let chk=1;for(const v of values){const top=chk>>>25;chk=((chk&0x1ffffff)<<5)^v;for(let i=0;i<5;i++)if((top>>>i)&1)chk^=g[i]}return chk>>>0}
function hrp(h){return [...h].map(c=>c.charCodeAt(0)>>5).concat([0],[...h].map(c=>c.charCodeAt(0)&31))}
function bech32(h,program){const set='qpzry9x8gf2tvdw0s3jn54khce6mua7l',data=[0,...convertBits(program,8,5)],pm=polymod([...hrp(h),...data,0,0,0,0,0,0])^1,cs=[];for(let i=0;i<6;i++)cs.push((pm>>>(5*(5-i)))&31);return h+'1'+[...data,...cs].map(v=>set[v]).join('')}
function btc(pub,kind){const h=hash160(bytes(pub));if(kind==='btc44')return b58(0,h);if(kind==='btc49')return b58(5,hash160(join(new Uint8Array([0,20]),h)));return bech32('bc',h)}
function derive(phrase,kind,path){const w=HDNodeWallet.fromPhrase(phrase,'',path,wordlists.en);return kind==='eth'?w.address:btc(w.publicKey,kind)}

const phrase='abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const tests=[
  ['BTC BIP44','btc44',"m/44'/0'/0'/0/0",'1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA'],
  ['BTC BIP49','btc49',"m/49'/0'/0'/0/0",'37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf'],
  ['BTC BIP84','btc84',"m/84'/0'/0'/0/0",'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'],
  ['ETH BIP44','eth',"m/44'/60'/0'/0/0",'0x9858EfFD232B4033E47d90003D41EC34EcaEda94']
];
let failed=0;
for(const [name,kind,path,expected] of tests){const got=derive(phrase,kind,path);const ok=got.toLowerCase()===expected.toLowerCase();console.log(`${ok?'PASS':'FAIL'} ${name}: ${got}`);if(!ok)failed++}
if(failed)process.exitCode=1;
