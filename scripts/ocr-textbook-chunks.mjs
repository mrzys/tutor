// Reuse the legacy configured provider. Secrets stay in memory and never enter output files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const legacyRoot = process.env.TUTOR_LEGACY_KB_ROOT || 'C:/Users/mrzys/OPC/tutor-kb';
const require = createRequire(path.join(legacyRoot, 'package.json'));
const env = require('dotenv').parse(fs.readFileSync(path.join(legacyRoot, '.env')));
const client = new (require('pg').Client)({ connectionString: env.DATABASE_URL });
await client.connect();
await client.query('begin read only');
const config = (await client.query("select base_url,config,api_key_ciphertext from workflow_provider_configs where kind='ocr' and enabled=true")).rows[0];
await client.query('rollback');
await client.end();
if (!config || config.config.mode !== 'paddle_async') throw new Error('Configured Paddle asynchronous OCR is unavailable');
const [version, iv, tag, encrypted] = config.api_key_ciphertext.split(':');
if (version !== 'v1') throw new Error('Unsupported secret encryption version');
const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(env.WORKFLOW_CONFIG_ENCRYPTION_KEY).digest(), Buffer.from(iv, 'base64'));
decipher.setAuthTag(Buffer.from(tag, 'base64'));
const apiKey = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
const headers = { Authorization: `Bearer ${apiKey}` };
const chunks = JSON.parse(fs.readFileSync(process.argv[2] || '.tutor/curriculum/ocr-chunks.json', 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function jsonFetch(url, options = {}) {
 for(let attempt=0;attempt<3;attempt++) {
  try {
   const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
   if (!response.ok) throw new Error(`OCR HTTP status ${response.status}`);
   return await response.json();
  } catch(error) {
   // Retrying an unknown submit outcome could create duplicate remote jobs.
   if(options.method==='POST'||attempt===2)throw error;
   await sleep(3000*(attempt+1));
  }
 }
}
async function processChunk(chunk) {
 const imported=Array.from({length:chunk.endPage-chunk.startPage+1},(_,index)=>{
  const pdfPage=chunk.startPage+index;
  const file=path.join(path.dirname(chunk.path),`ocr-page-${String(pdfPage).padStart(3,'0')}.json`);
  if(!fs.existsSync(file))return false;
  try {const page=JSON.parse(fs.readFileSync(file,'utf8'));return page.bookId===chunk.bookId&&page.pdfPage===pdfPage&&typeof page.text==='string'&&Boolean(page.jobId);}catch{return false;}
 }).every(Boolean);
 if(imported) {
  console.log(JSON.stringify({event:'already_imported',bookId:chunk.bookId,startPage:chunk.startPage,endPage:chunk.endPage}));
  return;
 }
 const stem = chunk.path.replace(/\.pdf$/, '');
 const receiptPath = `${stem}-job.json`;
 const resultPath = `${stem}-result.jsonl`;
 let receipt;
 if (fs.existsSync(receiptPath)) receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
 else {
  const form = new FormData();
  form.append('model', config.config.ocrModel);
  form.append('optionalPayload', JSON.stringify({ useDocOrientationClassify:false,useDocUnwarping:false,useChartRecognition:false }));
  form.append(config.config.fileField || 'file', new Blob([fs.readFileSync(chunk.path)],{type:'application/pdf'}), path.basename(chunk.path));
  const response = await jsonFetch(config.base_url,{method:'POST',headers,body:form});
  if (!response.data?.jobId) throw new Error('OCR submit missing job id');
  receipt={jobId:response.data.jobId,bookId:chunk.bookId,startPage:chunk.startPage,endPage:chunk.endPage,submittedAt:new Date().toISOString()};
  fs.writeFileSync(receiptPath,JSON.stringify(receipt,null,2));
  console.log(JSON.stringify({event:'submitted',...receipt}));
 }
 if (!fs.existsSync(resultPath)) {
  const deadline=Date.now()+1800000;
  while(Date.now()<deadline) {
   const result=await jsonFetch(`${config.base_url}/${encodeURIComponent(receipt.jobId)}`,{headers});
   const state=result.data?.state;
   if(state==='done') {
    const response=await fetch(result.data.resultUrl.jsonUrl,{signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw new Error(`OCR result HTTP ${response.status}`);
    fs.writeFileSync(resultPath,await response.text());break;
   }
   if(state==='failed')throw new Error(`OCR job failed ${receipt.jobId}`);
   if(!['pending','running'].includes(state))throw new Error('Unexpected OCR job state');
   await sleep(10000);
  }
 }
 if(!fs.existsSync(resultPath))throw new Error(`OCR job did not finish ${receipt.jobId}`);
 const layouts=[];
 for(const line of fs.readFileSync(resultPath,'utf8').split(/\r?\n/).filter(Boolean)) {
  const row=JSON.parse(line);
  if(row.errorCode)throw new Error(`OCR result error code ${row.errorCode}`);
  if(!Array.isArray(row.result?.layoutParsingResults))throw new Error('OCR result layout array missing');
  layouts.push(...row.result.layoutParsingResults);
 }
 if(layouts.length!==chunk.endPage-chunk.startPage+1)throw new Error(`OCR page count mismatch ${receipt.jobId}: ${layouts.length}`);
 layouts.forEach((layout,index)=>{
  const pdfPage=chunk.startPage+index;
  const text=layout.markdown?.text || '';
  const out={bookId:chunk.bookId,pdfPage,jobId:receipt.jobId,sourceChunkPath:chunk.path,sourceChunkSha256:crypto.createHash('sha256').update(fs.readFileSync(chunk.path)).digest('hex'),sourceTransform:chunk.sourceTransform||'lossless_pdf_page_subset',reviewStatus:'ocr_unverified',text,blocks:layout.prunedResult?.parsing_res_list||[],width:layout.prunedResult?.width,height:layout.prunedResult?.height,imageRefs:layout.markdown?.images||{},completedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(path.dirname(chunk.path),`ocr-page-${String(pdfPage).padStart(3,'0')}.json`),JSON.stringify(out,null,2));
 });
 console.log(JSON.stringify({event:'completed',bookId:chunk.bookId,startPage:chunk.startPage,endPage:chunk.endPage,jobId:receipt.jobId,pages:layouts.length}));
}
// Small concurrency avoids saturating the shared legacy provider.
let index=0;
const errors=[];
await Promise.all([0,1].map(async()=>{while(index<chunks.length){const chunk=chunks[index++];try{await processChunk(chunk);}catch(error){errors.push({bookId:chunk.bookId,startPage:chunk.startPage,error:error.message});console.error(JSON.stringify(errors.at(-1)));}}}));
if(errors.length)process.exitCode=1;
