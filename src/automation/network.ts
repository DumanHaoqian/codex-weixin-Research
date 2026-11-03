import { EnvHttpProxyAgent } from 'undici';
let dispatcher:EnvHttpProxyAgent|undefined;
// Research HTTP respects the same HTTP(S)_PROXY / NO_PROXY environment as the
// CLI. Local inference firewalls and fixture endpoints always stay on loopback.
export const researchFetch:typeof fetch=(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(['127.0.0.1','localhost','[::1]'].includes(url.hostname))return fetch(input,init);
  dispatcher??=new EnvHttpProxyAgent();
  return fetch(input,{...init,dispatcher} as RequestInit);
};
export async function closeResearchNetwork(){const current=dispatcher;dispatcher=undefined;await current?.close();}
