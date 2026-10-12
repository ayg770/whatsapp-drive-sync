import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberContactNames, resolveSenderName } from '../src/senderName.js';
import { uploadImages } from '../src/sync.js';

test('original group sender resolves through anonymous LID and device-suffixed JID', () => {
  const names = new Map();
  rememberContactNames(names, [{id:'123@s.whatsapp.net',lid:'456@lid',name:'שרה לוי'}]);
  assert.equal(resolveSenderName({key:{participant:'456@lid'}},names,'Syncing visitor'),'שרה לוי');
  assert.equal(resolveSenderName({key:{participant:'123:7@s.whatsapp.net'}},names,'Syncing visitor'),'שרה לוי');
});
test('message pushName is used when contact is unavailable, and group is never sender fallback', () => {
  const names = new Map([['school@g.us','School group']]);
  assert.equal(resolveSenderName({key:{remoteJid:'school@g.us'},pushName:'שרה'},names,'Visitor'),'שרה');
  assert.equal(resolveSenderName({key:{remoteJid:'school@g.us'}},names,'Visitor'),'שולח לא מזוהה');
  assert.equal(resolveSenderName({key:{participant:'123:7@s.whatsapp.net'}},names,'Visitor'),'שולח 123');
  assert.equal(resolveSenderName({key:{fromMe:true}},names,'Visitor'),'Visitor');
});
test('Drive receives original sender filenames and distinct same-second photos', async t => {
  const old=process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;
  process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID='test-folder';
  t.after(()=>{if(old===undefined)delete process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;else process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID=old;});
  const names=[];
  const item={senderName:'שרה לוי',timestamp:new Date(2026,9,12,10,35,14).getTime(),groupId:'school@g.us',buffer:Buffer.from('test'),ext:'jpg',mimeType:'image/jpeg'};
  const summary=await uploadImages([item,item],{'school@g.us':'School group'},['school@g.us'],{
    getFolder:async()=>'date-folder',upload:async(buffer,name)=>{names.push(name);}
  });
  assert.deepEqual(names,['שרה לוי_10-35-14.jpg','שרה לוי_10-35-14-2.jpg']);
  assert.equal(summary.bySender['שרה לוי'],2);assert.equal(summary.byGroup['School group'],2);
});
