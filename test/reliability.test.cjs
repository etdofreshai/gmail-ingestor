const {test}=require('node:test');
const assert=require('node:assert/strict');
process.env.MEMORY_DATABASE_API_URL='http://memory.test';
process.env.MEMORY_DATABASE_API_TOKEN='test-only';
for(const key of ['IMAP_HOST','IMAP_USER','IMAP_PASSWORD','API_BEARER_TOKEN'])process.env[key]='fixture';
const writer=require('../dist/lib/api-writer');
const imap=require('../dist/imap');
const {syncEmails}=require('../dist/lib/email-sync');
const payload={source:'gmail',sender:'fixture',recipient:'fixture',content:'hello',timestamp:'2026-10-11T00:00:00Z',external_id:'fixture',metadata:{}};
test('unconfirmed and denied writes reject instead of reporting skipped',async t=>{
 for(const [status,body] of [[403,{}],[409,{}],[200,{}]]){
  t.mock.method(global,'fetch',async()=>new Response(JSON.stringify(body),{status}));
  await assert.rejects(writer.writeMessagesViaApi([{payload,attachmentCount:0}]));
  t.mock.restoreAll();
 }
});
test('a confirmed existing record is a successful skip',async t=>{
 t.mock.method(global,'fetch',async()=>new Response(JSON.stringify({record_id:'fixture',action:'skipped'}),{status:200}));
 assert.equal((await writer.writeMessagesViaApi([{payload,attachmentCount:0}])).skipped,1);
});
test('a limited scan reports incomplete and an unlimited scan covers the whole window',async t=>{
 t.mock.method(imap,'createImapClient',async()=>({getMailboxLock:async()=>({release(){}}),search:async()=>[1,2,3],
  fetch:async function*(uids){for(const uid of uids)yield{uid,source:Buffer.from('Subject: Test\r\n\r\nHello'),envelope:{date:new Date('2026-10-11T00:00:00Z')},flags:new Set()}},logout:async()=>{}}));
 t.mock.method(writer,'writeMessagesViaApi',async rows=>({inserted:rows.length,updated:0,skipped:0,attachmentsSeen:0,attachmentsIngested:0}));
 const limited=await syncEmails({limit:2});assert.equal(limited.fetched,2);assert.equal(limited.complete,false);
 const complete=await syncEmails({limit:0});assert.equal(complete.fetched,3);assert.equal(complete.complete,true);
});
