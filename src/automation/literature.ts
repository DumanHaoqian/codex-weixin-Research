import crypto from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import { hash, type literatureSchema } from './research-contracts.js';
import type { AutomationStore, Row, Statement } from './store.js';
import type { Owner } from './tasks.js';
import type { RunOutput } from './run-service.js';
import { researchFetch } from './network.js';

export type Paper={identity:string;version:string;title:string;authors:string[];source:'crossref'|'arxiv';url:string;date:string;dateType:string;
  published?:string;abstract?:string;readingLevel:'metadata'|'abstract';status:string};
export type LiteraturePage={items:Paper[];nextCursor:string|null};
export type LiteratureFetcher=(source:Paper['source'],query:string,start:number,end:number,cursor:string|null,limit:number,signal:AbortSignal)=>Promise<LiteraturePage>;
function doi(value:unknown):string|undefined{const s=typeof value==='string'?value.replace(/^https?:\/\/(?:dx\.)?doi.org\//i,'').trim().toLowerCase():'';return /^10\.\d{4,9}\/\S+$/.test(s)?s:undefined;}
function version(title:string,revision?:number,status='active'){return hash({title:title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,''),revision:revision&&revision>1?revision:null,status});}
export async function boundedResponse(response:Response,maxBytes=2*1024*1024):Promise<string>{
  if(!response.ok)throw new Error(`Source HTTP ${response.status}`);
  const reader=response.body?.getReader();if(!reader)throw new Error('Empty response');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw new Error('Source exceeds byte budget');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks).toString('utf8');
}
export function parseCrossref(text:string,limit:number):LiteraturePage{
  const body=JSON.parse(text);const message=body.message;
  if(!message||!Array.isArray(message.items)||message.items.length>limit)throw new Error('Invalid Crossref page');
  const items:Paper[]=message.items.map((item:any)=>{
    const identity=doi(item.DOI);if(!identity||!item.title?.[0]||!item.indexed?.['date-time'])throw new Error('Crossref identity/date unavailable');
    const title=String(item.title[0]).slice(0,1000),status=item['update-to']?.some((v:any)=>/retract|withdraw/i.test(v.type))?'updated_or_retracted':'active';
    return {identity:'doi:'+identity,version:version(title,undefined,status),title,source:'crossref',url:'https://doi.org/'+encodeURI(identity),
      authors:(item.author??[]).slice(0,100).map((a:any)=>[a.given,a.family].filter(Boolean).join(' ')),date:item.indexed['date-time'],dateType:'indexed',
      published:item.published?.['date-parts']?.[0]?.join('-'),readingLevel:'metadata',status};
  });
  return {items,nextCursor:items.length<limit?null:typeof message['next-cursor']==='string'?message['next-cursor']:null};
}
export function parseArxiv(text:string,start:number,limit:number):LiteraturePage{
  if(/<!DOCTYPE|<!ENTITY/i.test(text)||XMLValidator.validate(text)!==true)throw new Error('Unsafe or invalid Atom XML');
  const parsed=new XMLParser({ignoreAttributes:true,removeNSPrefix:true,parseTagValue:false,isArray:name=>['entry','author'].includes(name)}).parse(text).feed;
  if(!parsed)throw new Error('Invalid arXiv feed');
  const entries=parsed.entry??[];if(entries.length>limit)throw new Error('arXiv page exceeds budget');
  const items:Paper[]=entries.map((e:any)=>{
    const match=/\/abs\/(.+?)(?:v(\d+))?$/.exec(String(e.id));if(!match||!e.title||!e.updated)throw new Error('arXiv identity/date unavailable');
    const publishedDoi=doi(e.doi),title=String(e.title).replace(/\s+/g,' ').trim(),status=/withdrawn/i.test(String(e.comment??''))?'withdrawn':'active';
    return {identity:publishedDoi?'doi:'+publishedDoi:'arxiv:'+match[1],version:version(title,Number(match[2]??1),status),title,source:'arxiv',
      url:'https://arxiv.org/abs/'+encodeURI(match[1])+(match[2]?'v'+match[2]:''),authors:(e.author??[]).map((a:any)=>String(a.name)),
      date:String(e.updated),dateType:'last_updated',published:String(e.published??''),abstract:String(e.summary??'').slice(0,12000),readingLevel:e.summary?'abstract':'metadata',status};
  });
  const total=Number(parsed.totalResults??0);
  return {items,nextCursor:entries.length<limit||start+entries.length>=total?null:String(start+entries.length)};
}
export function publicLiteratureFetcher(fetcher:typeof fetch=researchFetch):LiteratureFetcher{
  let arxivAfter=0;
  return async(source,query,start,end,cursor,limit,signal)=>{
    if(source==='crossref'){
      const url=new URL('https://api.crossref.org/works');url.searchParams.set('query',query);url.searchParams.set('rows',String(limit));url.searchParams.set('cursor',cursor??'*');
      // Crossref's date filters accept second precision without milliseconds/Z.
      url.searchParams.set('filter',`from-index-date:${new Date(start).toISOString().slice(0,19)},until-index-date:${new Date(end).toISOString().slice(0,19)}`);
      const response=await fetcher(url,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),headers:{'User-Agent':'codex-weixin-research/automation (metadata watcher)'}});
      return parseCrossref(await boundedResponse(response),limit);
    }
    const delay=Math.max(0,arxivAfter-Date.now());if(delay)await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(resolve,delay);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});
    });arxivAfter=Date.now()+3100;
    const stamp=(n:number)=>new Date(n).toISOString().replace(/[-:]/g,'').slice(0,13).replace('T','');
    const url=new URL('https://export.arxiv.org/api/query');url.searchParams.set('search_query',`(${query}) AND lastUpdatedDate:[${stamp(start)} TO ${stamp(end)}]`);
    url.searchParams.set('sortBy','lastUpdatedDate');url.searchParams.set('sortOrder','ascending');url.searchParams.set('start',cursor??'0');url.searchParams.set('max_results',String(limit));
    const response=await fetcher(url,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
    return parseArxiv(await boundedResponse(response),Number(cursor??0),limit);
  };
}

export class LiteratureService{
  constructor(private store:AutomationStore,private fetchPage:LiteratureFetcher=publicLiteratureFetcher(),private now=Date.now){}
  async run(run:Row,owner:Owner,spec:z.infer<typeof literatureSchema>,signal:AbortSignal,guard:()=>Promise<void>):Promise<RunOutput>{
    const coverage:Array<{source:string;state:string;newItems:number}>=[];
    for(const source of [...new Set(spec.sources)]){
      let row=(await this.store.all('SELECT * FROM literature_cursors WHERE task_id=? AND revision=? AND source=?',[run.task_id,run.revision,source]))[0];
      const start=row?.complete?Number(row.window_end)-86400_000:row?Number(row.window_start):this.now()-spec.lookbackDays*86400_000;
      const end=row&&!row.complete?Number(row.window_end):this.now();let cursor=row&&!row.complete?row.cursor as string|null:null,newItems=0,complete=false;
      // Crossref cursors are short-lived. Reopen the same bounded window when
      // stale; durable item/version matches prevent duplicate discoveries.
      if(source==='crossref'&&cursor&&this.now()-Number(row?.updated_at??0)>240000)cursor=null;
      try{
        await guard();
        if(!row||row.complete)await this.store.transaction([{sql:'INSERT INTO literature_cursors VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(task_id,revision,source) DO UPDATE SET window_start=excluded.window_start,window_end=excluded.window_end,cursor=NULL,complete=0,updated_at=excluded.updated_at',params:[run.task_id,run.revision,source,start,end,null,0,this.now()]}]);
        for(let page=0;page<spec.pageBudget;page++){
          await guard();signal.throwIfAborted();
          const response=await this.fetchPage(source,spec.query,start,end,cursor,spec.itemsPerPage,signal);
          await guard();signal.throwIfAborted();
          const statements:Statement[]=[],fresh:Paper[]=[];const seen=new Set<string>(),identities=new Map<string,string>();
          for(const paper of response.items){
            const key=paper.identity+':'+paper.version;if(seen.has(key))continue;seen.add(key);
            const existing=(await this.store.all('SELECT id FROM literature_items WHERE identity=?',[paper.identity]))[0];
            const id=identities.get(paper.identity)??(existing?String(existing.id):crypto.randomUUID());identities.set(paper.identity,id);
            const match=await this.store.all('SELECT item_id FROM literature_matches WHERE task_id=? AND item_id=? AND version=?',[run.task_id,id,paper.version]);
            if(match.length)continue;
            fresh.push(paper);
            statements.push({sql:'INSERT INTO literature_items VALUES (?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET version=excluded.version,metadata=excluded.metadata,updated_at=excluded.updated_at',params:[id,paper.identity,paper.version,JSON.stringify(paper),this.now()]},
              {sql:'INSERT OR IGNORE INTO literature_versions VALUES (?,?,?)',params:[id,paper.version,JSON.stringify(paper)]});
            const event=crypto.randomUUID(),content=`文献追踪 · ${paper.title}\n${paper.authors.join(', ')}\n${paper.url}\n${paper.dateType}: ${paper.date}\n阅读层级：${paper.readingLevel}\n匹配依据：来源返回保存的检索式；未声称阅读全文。`;
            statements.push({sql:'INSERT INTO events VALUES (?,?,?,?,?,?)',params:[event,run.task_id,`literature:${run.task_id}:${id}:${paper.version}`,'literature_found',JSON.stringify({run:run.id,content}),this.now()]},
              {sql:'INSERT INTO literature_matches VALUES (?,?,?,?,?,?)',params:[run.task_id,id,paper.version,run.id,event,this.now()]});
            if(JSON.parse(String(run.snapshot)).notification!=='muted')statements.push({sql:'INSERT INTO notifications VALUES (?,?,?,?,?,?,?)',params:[crypto.randomUUID(),event,owner.accountId,owner.senderId,'pending',content,this.now()]});
          }
          cursor=response.nextCursor;complete=cursor===null;
          statements.push({sql:'INSERT INTO literature_cursors VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(task_id,revision,source) DO UPDATE SET window_start=excluded.window_start,window_end=excluded.window_end,cursor=excluded.cursor,complete=excluded.complete,updated_at=excluded.updated_at',params:[run.task_id,run.revision,source,start,end,cursor,complete?1:0,this.now()]});
          await this.store.transaction(statements);newItems+=fresh.length;
          if(complete)break;
        }
        coverage.push({source,state:complete?'complete':'partial_budget',newItems});
      }catch(error){if(signal.aborted)throw error;coverage.push({source,state:'unavailable_cursor_preserved',newItems});}
    }
    return {state:coverage.every(c=>c.state==='complete')?'succeeded':'partial',text:`文献追踪：${coverage.map(c=>`${c.source}: ${c.state}，新增/更新 ${c.newItems}`).join('；')}。覆盖范围限于配置来源与检索窗口。`,data:{coverage},findings:coverage.some(c=>c.newItems>0)};
  }
}
