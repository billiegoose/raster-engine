/* Local HTTP bridge to the Python ROM compiler and host fpgatool command. */
import {compileScene} from '../scene-model.js';

const output=new URL('./build/',import.meta.url).pathname;
const json=(data,status=200)=>new Response(JSON.stringify(data),{
  status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}
});
async function python(action,scene,engine='baked'){
  const child=Bun.spawn([process.env.RASTER_PYTHON||'python3','fpga/backend.py',action,'--engine',engine],{
    cwd:new URL('../',import.meta.url).pathname,
    stdin:Buffer.from(JSON.stringify({scene})),stdout:'pipe',stderr:'pipe'
  });
  const [stdout,stderr,code]=await Promise.all([
    new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited
  ]);
  try{return JSON.parse(stdout);}
  catch{throw Error(stderr.trim()||`Python ROM compiler exited with status ${code}`);}
}

export function createFpgaApi({runPython=python}={}){
  let programming=false;
  return async function handle(request,pathname){
    if(!pathname.startsWith('/api/fpga/'))return null;
    if(pathname.startsWith('/api/fpga/files/')){
      if(request.method!=='GET')return json({error:'Method not allowed'},405);
      const name=pathname.slice('/api/fpga/files/'.length);
      if(!/^[xy]-programs-[A-Za-z0-9_-]+\.bin$/.test(name))return json({error:'Invalid program filename'},400);
      const file=Bun.file(output+name);
      if(!await file.exists())return json({error:'ROM file not found'},404);
      return new Response(file,{headers:{'Content-Type':'application/octet-stream',
        'Content-Disposition':`attachment; filename="${name}"`,'Cache-Control':'no-store'}});
    }
    if(!['/api/fpga/export','/api/fpga/program'].includes(pathname))return json({error:'Not found'},404);
    if(request.method!=='POST')return json({error:'Method not allowed'},405);
    const origin=request.headers.get('origin');
    if(origin&&origin!==new URL(request.url).origin)return json({error:'Cross-origin programming is not allowed'},403);
    const action=pathname.endsWith('/program')?'program':'export';
    if(action==='program'&&programming)return json({error:'An FPGA upload is already running'},409);
    let locked=false;
    try{
      if(Number(request.headers.get('content-length'))>1024*1024)return json({error:'Scene too large'},413);
      const body=await request.text();
      if(Buffer.byteLength(body)>1024*1024)return json({error:'Scene too large'},413);
      const {scene,engine='baked'}=JSON.parse(body);
      if(!['baked','scene'].includes(engine))return json({error:'Unknown FPGA engine'},400);
      if(!scene||!Array.isArray(scene.shapes)||(!Array.isArray(scene.layers)&&!Array.isArray(scene.palette)))
        return json({error:'Expected a scene with shapes and palette/layers'},400);
      const compiled=compileScene(scene);
      if(compiled.width!==1920||compiled.height!==1080)return json({error:'FPGA requires a 1920 × 1080 scene'},400);
      if(engine==='baked'&&compiled.paletteEvents?.length)return json({error:'FPGA ROM requires a constant palette'},400);
      // Recheck after reading the body: two uploads may arrive concurrently.
      if(action==='program'){
        if(programming)return json({error:'An FPGA upload is already running'},409);
        programming=true;locked=true;
      }
      const result=await runPython(action,compiled,engine);
      if(result.filename)result.downloadUrl='/api/fpga/files/'+encodeURIComponent(result.filename);
      return json(result,result.ok?200:(result.path?502:400));
    }catch(error){return json({error:error.message},400);}
    finally{if(locked)programming=false;}
  };
}

export const handleFpgaRequest=createFpgaApi();
