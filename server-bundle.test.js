import {test,expect} from 'bun:test';
import {createServer} from './server.ts';
import {createServer as createTcpServer} from 'node:net';

async function freePort(){
  const socket=createTcpServer();
  await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve);});
  const port=socket.address().port;
  await new Promise((resolve,reject)=>socket.close(error=>error?reject(error):resolve()));
  return port;
}

test('browser receives one self-contained Bun bundle with the correct MIME type',async()=>{
  const server=createServer(await freePort());
  try{
    const base=`http://127.0.0.1:${server.port}`;
    const page=await fetch(base+'/');
    expect(page.status).toBe(200);
    const html=await page.text();
    expect(html).toContain('src="/app.bundle.js"');
    expect(html).not.toContain('src="/app.js"');
    const response=await fetch(base+'/app.bundle.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    const source=await response.text();
    expect(source).toContain('requestedSceneName');
    expect(source).toContain('createSceneEditor');
    expect(source).toContain('createRasterSimulator');
    expect(source).not.toMatch(/\bfrom\s+["']\.\//);
    const again=await fetch(base+'/app.bundle.js');
    expect(again.status).toBe(200);
    expect(await again.text()).toBe(source);
  }finally{server.stop(true);}
});
