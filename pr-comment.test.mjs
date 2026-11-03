import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {MARKER,text,pullRequestContext,renderComment,upsertComment} from './pr-comment.mjs';
const repository='acme/site',sha='a'.repeat(40),context={repository,sha,number:7};
const repo={full_name:repository};
const event={number:7,pull_request:{head:{sha,repo},base:{repo}}};
const pr={state:'open',head:{sha,repo},base:{repo}};
const report={kind:'report',apiUrl:'https://deploydoctor.example',data:{repoUrl:'https://github.com/acme/site',commitSha:sha,overall:'red',partial:false,url:'https://deploydoctor.example/r/fixture',summary:{red:1,yellow:1,green:4},checks:[{title:'Review',status:'yellow',findings:[{file:'app/checkout.ts',line:9,problem:'Review redirect',fix:'Verify production URL'}]},{title:'Imports',status:'red',findings:[{file:'src/home.ts',line:3,problem:'Wrong case',fix:'Use Home.ts'}]}]}};
const comment={id:42,body:MARKER+'\nprevious',user:{type:'Bot',login:'github-actions[bot]'}};
function mockGithub(existing=[],head=pr){
 const calls=[];const fetcher=async(url,options)=>{calls.push({url,...options});assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,'Bearer comment-only');if(url.endsWith('/pulls/7'))return Response.json(head);if(options.method==='GET')return Response.json(existing);return Response.json({html_url:'https://github.com/acme/site/pull/7#issuecomment-42'});};return {fetcher,calls};
}
test('comment includes real commit, ranked findings, source links, limitations, optional audit and partial status',()=>{
 const body=renderComment(context,report);assert.ok(body.startsWith(MARKER));assert.ok(body.indexOf('Wrong case')<body.indexOf('Review redirect'));assert.match(body,/blob\/a{40}\/src\/home.ts#L3/);assert.match(body,/Analyzed commit/);assert.match(body,/One-repo audit · €149/);assert.match(body,/Static source analysis only/);assert.doesNotMatch(renderComment(context,report,false),/€149/);
 const partial=renderComment(context,{...report,data:{...report.data,partial:true}});assert.match(partial,/Partial scan/);assert.match(partial,/some source was not checked/);
 const green=renderComment(context,{...report,data:{...report.data,overall:'green',checks:[],summary:{red:0,yellow:0,green:5}}});assert.match(green,/Checks passed/);assert.match(green,/not a guarantee/);
 const quota=renderComment(context,{kind:'quota'});assert.match(quota,/Not scanned/);assert.match(quota,/No new scan/);assert.doesNotMatch(quota,/Open full report/);
});
test('source text cannot create mentions, HTML, Markdown links or invalid report destinations',()=>{
 const hostile=structuredClone(report);hostile.data.checks[0].findings[0].problem='@everyone <img src=x> [click](https://evil.test)\n# hello';
 const body=renderComment(context,hostile);assert.doesNotMatch(body,/@everyone|<img|\[click\]\(https:\/\/evil/);assert.match(body,/&#64;everyone/);assert.ok(text('x'.repeat(1000)).length<=350);
 for(const url of ['https://evil.test/r/fixture','http://deploydoctor.example/r/fixture','https://user@deploydoctor.example/r/fixture','https://deploydoctor.example/r/fixture?token=secret'])assert.throws(()=>renderComment(context,{...report,data:{...report.data,url}}));
 assert.throws(()=>renderComment(context,{...report,data:{...report.data,commitSha:'b'.repeat(40)}}));assert.throws(()=>renderComment(context,{...report,data:{...report.data,repoUrl:'https://github.com/acme/other'}}));
});
test('creates once and updates an existing bot comment; ignores marker spoofing by people',async()=>{
 const created=mockGithub([{...comment,id:21,user:{type:'User',login:'attacker'}}]);assert.equal((await upsertComment({context,outcome:report,token:'comment-only',...created})).status,'created');assert.equal(created.calls.at(-1).method,'POST');
 const updated=mockGithub([comment]);assert.deepEqual(await upsertComment({context,outcome:report,token:'comment-only',...updated}),{status:'updated',url:'https://github.com/acme/site/pull/7#issuecomment-42'});assert.equal(updated.calls.at(-1).method,'PATCH');assert.ok(updated.calls.at(-1).url.endsWith('/issues/comments/42'));
});
test('pagination finds the original comment and changed heads or closed PRs never write',async()=>{
 let writes=0;const paged=async(url,opts)=>{if(url.endsWith('/pulls/7'))return Response.json(pr);if(opts.method!=='GET'){writes++;return Response.json({});}return Response.json(new URL(url).searchParams.get('page')==='1'?Array.from({length:100},()=>({user:{type:'User'},body:''})):[comment]);};
 assert.equal((await upsertComment({context,outcome:report,token:'x',fetcher:paged})).status,'updated');assert.equal(writes,1);
 for(const head of [{...pr,state:'closed'},{...pr,head:{...pr.head,sha:'b'.repeat(40)}}]){const m=mockGithub([],head);assert.equal((await upsertComment({context,outcome:report,token:'comment-only',...m})).status,'stale');assert.ok(m.calls.every(c=>c.method==='GET'));}
 let reads=0;const race=async(url,opts)=>url.endsWith('/pulls/7')?Response.json(++reads===1?pr:{...pr,head:{...pr.head,sha:'b'.repeat(40)}}):opts.method==='GET'?Response.json([]):assert.fail('Stale result wrote a comment');assert.equal((await upsertComment({context,outcome:report,token:'x',fetcher:race})).status,'stale');
});
test('only same-repository pull_request events can request comments, including when using a paid scan',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dd-context-'));try{
 const path=join(dir,'event.json');writeFileSync(path,JSON.stringify(event));const env={GITHUB_EVENT_NAME:'pull_request',GITHUB_REPOSITORY:repository,GITHUB_EVENT_PATH:path,GITHUB_ACTOR:'builder'};assert.deepEqual(pullRequestContext(env),context);
 for(const name of ['pull_request_target','push','workflow_run'])assert.equal(pullRequestContext({...env,GITHUB_EVENT_NAME:name}),null);
 assert.equal(pullRequestContext({...env,GITHUB_ACTOR:'dependabot[bot]'}),null);
 writeFileSync(path,JSON.stringify({...event,pull_request:{...event.pull_request,head:{sha,repo:{full_name:'attacker/fork'}}}}));assert.equal(pullRequestContext(env),null);
 writeFileSync(path,'{');assert.equal(pullRequestContext(env),null);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
function runScan({status=201,data=report.data,comments=[],permissionDenied=false,disabled=false,evt=event,ref=sha,paid=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'dd-comment-scan-'));try{
 const eventPath=join(dir,'event.json'),callsPath=join(dir,'calls.jsonl'),output=join(dir,'output'),summary=join(dir,'summary');writeFileSync(eventPath,JSON.stringify(evt));writeFileSync(callsPath,'');
 const mock=`import {appendFileSync} from 'node:fs';globalThis.fetch=async(url,options={})=>{appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({url,method:options.method,headers:options.headers,body:options.body})+'\\n');if(String(url).startsWith('https://oidc.example/'))return Response.json({value:'fixture-oidc'});if(String(url).endsWith('/api/reports'))return Response.json(${JSON.stringify(data)},{status:${status}});if(${permissionDenied})return Response.json({},{status:403});if(String(url).endsWith('/pulls/7'))return Response.json(${JSON.stringify(pr)});if(options.method==='GET')return Response.json(${JSON.stringify(comments)});return Response.json({html_url:'https://github.com/acme/site/pull/7#issuecomment-42'});};`;
 const env={...process.env,DD_TOKEN:paid?'fixture-paid':'',DD_REPOSITORY:repository,DD_REF:ref,DD_GITHUB_TOKEN:'',DD_FAIL_ON:'red',DD_CHECKS:'',DD_API_URL:'https://deploydoctor.example',DD_COMMENT:disabled?'false':'true',DD_COMMENT_TOKEN:'comment-only',DD_AUDIT_LINK:'true',GITHUB_EVENT_NAME:'pull_request',GITHUB_EVENT_PATH:eventPath,GITHUB_REPOSITORY:repository,GITHUB_ACTOR:'builder',GITHUB_OUTPUT:output,GITHUB_STEP_SUMMARY:summary,ACTIONS_ID_TOKEN_REQUEST_URL:'https://oidc.example/?request=fixture',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'oidc-request'};delete env.NODE_TEST_CONTEXT;
 const result=spawnSync(process.execPath,['--import',`data:text/javascript,${encodeURIComponent(mock)}`,fileURLToPath(new URL('./scan.mjs',import.meta.url))],{env,encoding:'utf8',timeout:10_000});return {...result,calls:readFileSync(callsPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),output:readFileSync(output,'utf8'),summary:readFileSync(summary,'utf8')};
 }finally{rmSync(dir,{recursive:true,force:true});}
}
test('red scans publish the comment before failing; comment token never reaches the scanner',()=>{
 const result=runScan();assert.equal(result.status,1,result.stderr);assert.match(result.output,/comment-status=created/);const scan=result.calls.find(c=>c.url.endsWith('/api/reports'));assert.equal(JSON.parse(scan.body).pullRequest,7);assert.equal(JSON.parse(scan.body).ref,sha);assert.doesNotMatch(JSON.stringify(scan),/comment-only/);assert.ok(result.calls.some(c=>c.method==='POST'&&c.url.includes('/issues/7/comments')));
});
test('quota exhaustion updates the comment without failing or presenting a stale green result',()=>{
 const result=runScan({status:429,data:{paywall:true,error:'One free scan used'},comments:[comment]});assert.equal(result.status,0,result.stderr);assert.match(result.summary,/not scanned/);assert.match(result.output,/comment-status=updated/);const written=JSON.parse(result.calls.find(c=>c.method==='PATCH').body).body;assert.match(written,/Not scanned/);assert.doesNotMatch(written,/Checks passed|Open full report/);
});
test('missing permissions cannot change scan success; opt-out, ref overrides and forks never comment',()=>{
 const green={...report.data,overall:'green',checks:[],summary:{red:0,yellow:0,green:5}};const denied=runScan({data:green,permissionDenied:true});assert.equal(denied.status,0,denied.stderr);assert.match(denied.output,/comment-status=failed/);assert.match(denied.stdout,/pull-requests: write/);
 for(const options of [{disabled:true},{ref:'another-branch'},{paid:true,evt:{...event,pull_request:{...event.pull_request,head:{sha,repo:{full_name:'attacker/fork'}}}}}]){const r=runScan({data:green,...options});assert.equal(r.status,0,r.stderr);assert.ok(r.calls.every(c=>!c.url.startsWith('https://api.github.com/')));}
});
test('annotation text cannot inject workflow commands through source-controlled fields',()=>{
 const data=structuredClone(report.data);data.checks=[{status:'red',title:'Imports\n::notice::fake',explanation:'',fix:'Check',findings:[{file:'a.ts,evil=x\n::notice::fake',line:1,problem:'bad\n::notice::fake',fix:'fix'}]}];const result=runScan({data,disabled:true});assert.equal(result.status,1);assert.doesNotMatch(result.stdout,/\n::notice::fake/);assert.match(result.stdout,/%0A/);assert.match(result.stdout,/%2C/);
});

test('PR change review distinguishes new findings from existing ones and preserves full-head gating',()=>{
 const impact={version:1,number:7,headCommitSha:sha,baseCommitSha:'b'.repeat(40),partial:false,introduced:[{file:'app/page.tsx',line:8,problem:'New casing break',fix:'Use Button.tsx',status:'red'}],persisting:[{file:'old.ts',line:1,problem:'Old env risk'}],noLongerDetected:[{}],uncertain:[],notCompared:[]};
 const withImpact={...report,data:{...report.data,pullRequest:impact}};
 const body=renderComment(context,withImpact,false);assert.match(body,/1 newly detected/);assert.match(body,/1 already present/);assert.match(body,/1 no longer detected/);assert.match(body,/New casing break/);assert.doesNotMatch(body,/Old env risk/);assert.match(body,/not a verified fix/);assert.match(body,/b{12}/);assert.match(body,/blob\/a{40}\/app\/page.tsx#L8/);
 const noNew=renderComment(context,{...withImpact,data:{...withImpact.data,pullRequest:{...impact,introduced:[]}}},false);assert.match(noNew,/No newly detected findings/);assert.match(noNew,/does not establish/);assert.match(noNew,/1 red checks/);
 for(const bad of [{...impact,number:8},{...impact,headCommitSha:'c'.repeat(40)},{...impact,baseCommitSha:'main'},{...impact,introduced:null}])assert.throws(()=>renderComment(context,{...report,data:{...report.data,pullRequest:bad}}));
 const partial=renderComment(context,{...report,data:{...report.data,partial:true,pullRequest:{...impact,partial:true,introduced:[],uncertain:[{}]}}});assert.match(partial,/Incomplete comparison/);assert.match(partial,/not a new\/fixed verdict/);
 const escaped=renderComment(context,{...report,data:{...report.data,pullRequest:{...impact,introduced:[{file:'@attacker.ts',line:1,status:'red',problem:'<script> @everyone [click](https://evil.test)',fix:'@attacker'}]}}});assert.doesNotMatch(escaped,/<script>|@everyone|\[click\]\(https:\/\/evil/);
 const run=runScan({data:withImpact.data});assert.equal(run.status,1);assert.match(JSON.parse(run.calls.find(c=>c.method==='POST'&&c.url.includes('/issues/7/comments')).body).body,/What changed in this PR/);
 const override=runScan({ref:'main',data:report.data});assert.equal(JSON.parse(override.calls.find(c=>c.url.endsWith('/api/reports')).body).pullRequest,undefined);
});
