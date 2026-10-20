import {handleApiRequest} from './api.js';
import {watch} from 'node:fs';
const root = import.meta.dir;
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
// Compile browser modules into one cached response, rather than making Chrome
// discover and fetch the ESM dependency graph one module at a time.
let sourceVersion = 0;
let compiled: {version:number; body:ArrayBuffer}|null = null;
let compiling: Promise<ArrayBuffer>|null = null;
watch(root, {persistent:false}, (_event,filename) => {
  if(filename && /\.(?:js|ts|json)$/.test(String(filename))) sourceVersion++;
});
async function browserBundle():Promise<ArrayBuffer> {
  if(compiled?.version === sourceVersion)return compiled.body;
  if(compiling)return compiling;
  const version=sourceVersion;
  compiling=(async()=>{
    const result=await Bun.build({entrypoints:[root+'/app.js'],target:'browser'});
    if(!result.success)throw new Error('Browser bundle failed: '+result.logs.map(String).join('; '));
    const body=await result.outputs[0].arrayBuffer();
    if(sourceVersion===version)compiled={version,body};
    return body;
  })().finally(()=>{compiling=null;});
  return compiling;
}

export function createServer(port=Number(process.env.PORT||3000)){
  return Bun.serve({
    port,
  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    if(pathname === '/app.bundle.js'){
      try{return new Response(await browserBundle(),{headers:{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-cache'}});}
      catch(error){console.error('Browser bundle:',error);return new Response('Browser bundle failed',{status:500});}
    }
    const apiResponse = await handleApiRequest(request, pathname);
    if (apiResponse) return apiResponse;
    if (!['/index.html', '/app.js', '/scene-url.js', '/scene.js', '/scene-model.js', '/scene-editor.js', '/scene-history.js', '/raster-simulator.js', '/palette-view.js', '/style.css', '/fonts/red2-font.css', '/fonts/RED2-Regular.woff2', '/fonts/RED2-Regular.ttf'].includes(pathname)) return new Response('Not found', { status: 404 });
    const file = Bun.file(root + pathname);
    if (!(await file.exists())) return new Response('Not found', { status: 404 });
    return new Response(file, { headers: { 'Content-Type': types[pathname.slice(pathname.lastIndexOf('.'))] || 'application/octet-stream' } });
  }
  });
}
if(import.meta.main){
  const server=createServer();
  console.log(`Raster engine: http://localhost:${server.port}`);
}
