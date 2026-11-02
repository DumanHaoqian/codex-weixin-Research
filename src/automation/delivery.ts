import crypto from 'node:crypto';
import { AutomationStore } from './store.js';
import type { Owner } from './tasks.js';

export type DeliveryOutcome = { state:'api_accepted'|'failed'|'unknown'|'deferred'; code?:string };
export type DeliveryPort = (owner:Owner,text:string)=>Promise<DeliveryOutcome>;

export class NotificationWorker {
  private chain:Promise<unknown>=Promise.resolve();
  private recovered=false;
  constructor(private store:AutomationStore,private authorize:(owner:Owner)=>boolean|Promise<boolean>,
    private send:DeliveryPort,private now=Date.now) {}

  private serialize<T>(fn:()=>Promise<T>):Promise<T>{
    const result=this.chain.then(fn);this.chain=result.catch(()=>{});return result;
  }

  private async aggregate(id:string):Promise<void>{
    await this.store.transaction([{sql:`UPDATE notifications SET state=CASE
      WHEN EXISTS(SELECT 1 FROM notification_parts WHERE notification_id=? AND state='unknown') THEN 'unknown'
      WHEN EXISTS(SELECT 1 FROM notification_parts WHERE notification_id=? AND state='failed') THEN 'failed'
      WHEN NOT EXISTS(SELECT 1 FROM notification_parts WHERE notification_id=? AND state!='api_accepted') THEN 'api_accepted'
      ELSE 'pending' END,updated_at=? WHERE id=? AND state!='cancelled'`,params:[id,id,id,this.now(),id]}]);
  }

  flush(ownerFilter?:Owner):Promise<void>{return this.serialize(async()=>{
    if(!this.recovered){
      await this.store.transaction([
        {sql:"UPDATE notifications SET state='unknown' WHERE id IN (SELECT notification_id FROM notification_parts WHERE state='in_flight') AND state!='cancelled'"},
        {sql:"UPDATE notification_parts SET state='unknown' WHERE state='in_flight'"},
        {sql:"UPDATE notification_attempts SET state='unknown',ended_at=? WHERE state='in_flight'",params:[this.now()]}
      ]);this.recovered=true;
    }
    const rows=await this.store.all(`SELECT n.*,e.task_id FROM notifications n JOIN events e ON e.id=n.event_id
      JOIN tasks t ON t.id=e.task_id WHERE n.state='pending' AND t.state!='deleted'
      ${ownerFilter?'AND n.account_id=? AND n.sender_id=?':''} ORDER BY n.updated_at,n.id LIMIT 100`,
      ownerFilter?[ownerFilter.accountId,ownerFilter.senderId]:[]);
    const owners=new Set<string>();
    for(const n of rows){
      const owner={accountId:String(n.account_id),senderId:String(n.sender_id)};
      const ownerKey=JSON.stringify(owner);
      if(owners.has(ownerKey)||!await this.authorize(owner))continue;
      owners.add(ownerKey); // At most one result per owner per scan; no backlog flood.
      const id=String(n.id);
      let parts=await this.store.all('SELECT * FROM notification_parts WHERE notification_id=? ORDER BY part_index',[id]);
      if(!parts.length){
        const chars=Array.from(`[定时任务 ${n.task_id}]\n${n.content}`);
        const statements=[];
        for(let i=0;i<chars.length;i+=700) statements.push({sql:'INSERT INTO notification_parts VALUES (?,?,?,?,?,?)',
          params:[crypto.randomUUID(),id,i/700,chars.slice(i,i+700).join(''),'pending',null]});
        await this.store.transaction(statements);
        parts=await this.store.all('SELECT * FROM notification_parts WHERE notification_id=? ORDER BY part_index',[id]);
      }
      for(const part of parts){
        if(part.state==='api_accepted')continue;
        if(part.state!=='pending')break;
        if(!await this.authorize(owner))break;
        const attempt=crypto.randomUUID();
        const claimed=await this.store.transaction([
          {sql:`UPDATE notification_parts SET state='in_flight',attempt_id=? WHERE id=? AND state='pending'
            AND EXISTS(SELECT 1 FROM notifications n JOIN events e ON e.id=n.event_id JOIN tasks t ON t.id=e.task_id
            WHERE n.id=notification_parts.notification_id AND n.state='pending' AND t.state!='deleted')`,params:[attempt,part.id]},
          {sql:`INSERT INTO notification_attempts(id,notification_id,state,started_at,part_id)
            SELECT ?,?,'in_flight',?,? WHERE EXISTS(SELECT 1 FROM notification_parts WHERE id=? AND attempt_id=?)`,
            params:[attempt,id,this.now(),part.id,part.id,attempt]}
        ]);
        if(!claimed[0].changes)break;
        let result:DeliveryOutcome;
        try{result=await this.send(owner,String(part.content));}catch{result={state:'unknown',code:'transport_exception'};}
        const state=result.state==='deferred'?'waiting_context':result.state;
        await this.store.transaction([
          {sql:'UPDATE notification_parts SET state=? WHERE id=? AND attempt_id=?',params:[state,part.id,attempt]},
          {sql:'UPDATE notification_attempts SET state=?,ended_at=?,error=? WHERE id=?',params:[result.state,this.now(),result.code??null,attempt]}
        ]);
        if(result.state!=='api_accepted')break;
      }
      await this.aggregate(id);
    }
  });}

  retry(owner:Owner,id:string,options:{includeUnknown?:boolean;resendAccepted?:boolean}={},requestKey?:string):Promise<void>{return this.serialize(async()=>{
    if(!await this.authorize(owner))throw new Error('Access denied');
    if(requestKey!==undefined&&(!requestKey.length||requestKey.length>200))throw new Error('Invalid request key');
    const key=`retry:${id}:${requestKey}`;
    const hash=crypto.createHash('sha256').update(JSON.stringify({id,includeUnknown:Boolean(options.includeUnknown),resendAccepted:Boolean(options.resendAccepted)})).digest('hex');
    if(requestKey!==undefined){
      const old=(await this.store.all('SELECT payload_hash FROM requests WHERE account_id=? AND sender_id=? AND request_key=?',[owner.accountId,owner.senderId,key]))[0];
      if(old){if(old.payload_hash!==hash)throw new Error('Idempotency conflict');return;}
    }
    const n=(await this.store.all('SELECT * FROM notifications WHERE id=? AND account_id=? AND sender_id=?',[id,owner.accountId,owner.senderId]))[0];
    if(!n)throw new Error('Notification not found');
    if(n.state==='cancelled')throw new Error('Notification cancelled');
    if(n.state==='unknown'&&!options.includeUnknown)throw new Error('Unknown delivery may duplicate; explicit includeUnknown required');
    if(n.state==='api_accepted'&&!options.resendAccepted)throw new Error('API already accepted; explicit resendAccepted required for possible duplicate');
    const states=["'failed'","'waiting_context'",...(options.includeUnknown?["'unknown'"]:[]),...(options.resendAccepted?["'api_accepted'"]:[])];
    await this.store.transaction([
      {sql:`UPDATE notification_parts SET state='pending' WHERE notification_id=? AND state IN (${states.join(',')})`,params:[id]},
      {sql:"UPDATE notifications SET state='pending',updated_at=? WHERE id=? AND state!='cancelled'",params:[this.now(),id]},
      ...(requestKey===undefined?[]:[{sql:'INSERT INTO requests VALUES (?,?,?,?,?)',params:[owner.accountId,owner.senderId,key,hash,'{}']}])
    ]);
  });}

  wake(owner:Owner):Promise<void>{return this.serialize(async()=>{
    if(!await this.authorize(owner))return;
    await this.store.transaction([
      {sql:`UPDATE notification_parts SET state='pending' WHERE state IN ('failed','waiting_context') AND notification_id IN
        (SELECT id FROM notifications WHERE account_id=? AND sender_id=? AND state IN ('failed','pending'))`,params:[owner.accountId,owner.senderId]},
      {sql:"UPDATE notifications SET state='pending' WHERE account_id=? AND sender_id=? AND state='failed'",params:[owner.accountId,owner.senderId]}
    ]);
  }).then(()=>this.flush(owner));}

  async drain():Promise<void>{await this.chain;}
}
