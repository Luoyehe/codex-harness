import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const [root, output] = process.argv.slice(2);
assert(root && output, 'Usage: node tests/deploy/vision_stdio_probe.mjs PROJECT_ROOT OUTPUT_JSON');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-vision-home-'));
const pkg = fs.realpathSync(path.join(root, 'node_modules/@z_ai/mcp-server/package.json'));
const entry = path.join(path.dirname(pkg), 'build/index.js');
const req = createRequire(pkg);
const versionFor = (entrypoint, name) => { let dir = path.dirname(req.resolve(entrypoint)); for (;;) { const file = path.join(dir, 'package.json'); if (fs.existsSync(file)) { const data = JSON.parse(fs.readFileSync(file)); if (data.name === name) return data.version; } const up = path.dirname(dir); if (up === dir) throw new Error('Package missing: ' + name); dir = up; } };
const guard = path.join(home, 'deny-network.cjs');
const attempts = path.join(home, 'network-attempts.txt');
fs.writeFileSync(guard, `const fs=require('node:fs'); const deny=()=>{fs.appendFileSync(${JSON.stringify(attempts)},'attempt\\n');throw new Error('Network forbidden in no-tool probe');}; const net=require('node:net');net.Socket.prototype.connect=deny;require('node:http').request=deny;require('node:http').get=deny;require('node:https').request=deny;require('node:https').get=deny;global.fetch=deny;`);
const env = Object.fromEntries(['SystemRoot','WINDIR','PATH'].filter(key => process.env[key]).map(key => [key,process.env[key]]));
Object.assign(env,{HOME:home,USERPROFILE:home,TMP:home,TEMP:home,ZAI_MCP_LOG_PATH:path.join(home,'logs'),Z_AI_API_KEY:'fixture-local-only-credential',Z_AI_MODE:'ZHIPU'});
const child = spawn(process.execPath, ['--require',guard,entry], {cwd:home,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
let input='',stderr='',bytes=0;const waiting=new Map();
child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8192);});
child.stdout.on('data', chunk=>{bytes+=chunk.length;assert(bytes<1024*1024);input+=chunk;for(;;){const n=input.indexOf('\n');if(n<0)break;const line=input.slice(0,n);input=input.slice(n+1);if(!line)continue;const value=JSON.parse(line);const pending=waiting.get(value.id);if(pending){waiting.delete(value.id);value.error?pending.reject(new Error(JSON.stringify(value.error))):pending.resolve(value.result);}else assert(!('id' in value && 'method' in value),'Unexpected server request');}});
const call=(id,method,params)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Timeout '+method+' '+stderr)),15000);waiting.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
try {
 const initialized=await call(1,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'harness-offline-compat',version:'1.0.0'}});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const listed=await call(2,'tools/list',{});
 const expected={ui_to_artifact:[['image_source','output_type','prompt'],[]],extract_text_from_screenshot:[['image_source','prompt'],['programming_language']],diagnose_error_screenshot:[['image_source','prompt'],['context']],understand_technical_diagram:[['image_source','prompt'],['diagram_type']],analyze_data_visualization:[['image_source','prompt'],['analysis_focus']],ui_diff_check:[['expected_image_source','actual_image_source','prompt'],[]],analyze_image:[['image_source','prompt'],[]],analyze_video:[['video_source','prompt'],[]]};
 assert.deepEqual(listed.tools.map(t=>t.name).sort(),Object.keys(expected).sort());
 for(const tool of listed.tools){const [required,optional]=expected[tool.name];assert.equal(tool.inputSchema.type,'object');assert.deepEqual([...tool.inputSchema.required].sort(),[...required].sort());assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(),[...required,...optional].sort());for(const [name,value] of Object.entries(tool.inputSchema.properties)){assert.equal(value.type,'string');assert(value.description?.length>0);if(name==='output_type')assert.deepEqual(value.enum,['code','prompt','spec','description']);}}
 child.stdin.end();let timer;const closed=await Promise.race([new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal}))),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('No exit after EOF')),5000);})]).finally(()=>clearTimeout(timer));
 assert.equal(closed.code,0);assert(!fs.existsSync(attempts),'Network attempted');
 // Exercise the actual registered Zod objects without invoking any tool handler.
 // The SDK's v4 input-mode JSON Schema omits additionalProperties:false; confirm
 // that unknown input keys are still stripped by the underlying object parser.
 const schemaProbe = path.join(home,'registered-schemas.mjs');
 fs.writeFileSync(schemaProbe, `import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';const req=createRequire(${JSON.stringify(pkg)});const {z}=await import(pathToFileURL(req.resolve('zod')));const expected=${JSON.stringify(expected)};const checked=[];const server={tool(name,description,shape){const schema=z.object(shape);const [required,optional]=expected[name];const valid=Object.fromEntries(required.map(key=>[key,key==='output_type'?'code':'fixture']));assert(schema.safeParse(valid).success);for(const key of optional)assert(schema.safeParse({...valid,[key]:''}).success);for(const key of required){const missing={...valid};delete missing[key];assert(!schema.safeParse(missing).success);}for(const key of [...required,...optional])assert(!schema.safeParse({...valid,[key]:42}).success);if(shape.output_type){for(const value of ['code','prompt','spec','description'])assert(schema.safeParse({...valid,output_type:value}).success);assert(!schema.safeParse({...valid,output_type:'invalid'}).success);}assert(!('unrecognized' in schema.parse({...valid,unrecognized:'strip me'})));checked.push(name);}};for(const name of ['ui-to-artifact','text-extraction','error-diagnosis','diagram-analysis','data-viz','ui-diff','general-image','video-analysis']){const mod=await import(pathToFileURL(path.join(${JSON.stringify(path.dirname(pkg))},'build/tools',name+'.js')));const register=Object.entries(mod).find(([key])=>key.startsWith('register'))?.[1];assert(register);register(server);}assert.equal(checked.length,8);process.stdout.write(JSON.stringify({checked})+'\\n');`);
 const schemas=spawnSync(process.execPath,['--require',guard,schemaProbe],{cwd:home,env,encoding:'utf8',timeout:15000,maxBuffer:1024*1024,windowsHide:true});
 assert.equal(schemas.status,0,schemas.stderr);assert(!schemas.error);assert(!fs.existsSync(attempts),'Network attempted');
 const registered=JSON.parse(schemas.stdout.trim().split('\n').at(-1));
 fs.writeFileSync(output,JSON.stringify({node:process.version,vision:JSON.parse(fs.readFileSync(pkg)).version,sdk:versionFor('@modelcontextprotocol/sdk/server/mcp.js','@modelcontextprotocol/sdk'),zod:versionFor('zod','zod'),initialized,toolCount:listed.tools.length,tools:listed.tools,registeredSchemas:registered.checked,networkAttempts:0,toolCalls:0,closed,home},null,2)+'\n');
 console.log(JSON.stringify({output,toolCount:listed.tools.length,sdk:versionFor('@modelcontextprotocol/sdk/server/mcp.js','@modelcontextprotocol/sdk'),zod:versionFor('zod','zod'),networkAttempts:0,toolCalls:0,closed}));
} finally {if(child.exitCode===null)child.kill();}
