/* Export/upload always snapshots the current editor scene, including unsaved edits. */
export function createFpgaControls({getScene,defaultEngine='scene'}){
  const button=document.getElementById('fpga-program');
  const status=document.getElementById('fpga-status');
  const download=document.getElementById('fpga-download');
  const engine=document.createElement('select');
  engine.id='fpga-engine';engine.setAttribute('aria-label','FPGA engine');
  for(const [value,label] of [['baked','Baked X programs'],['scene','Dynamic RECT + TEXT']]){
    const option=document.createElement('option');option.value=value;option.textContent=label;engine.append(option);
  }
  engine.value=defaultEngine;button.before(engine);
  let busy=false,revision=0;
  function update(){
    const scene=getScene();
    const supported=scene.width===1920&&scene.height===1080&&(engine.value==='scene'||!scene.paletteEvents?.length);
    button.disabled=busy||!supported;
    engine.disabled=busy;
    engine.title='Choose the engine installed on the board. Dynamic RECT + TEXT uses square corners and the initial palette.';
    button.title=supported?(engine.value==='scene'?'Compile TEXT/RECT Y programs and upload them to the Basys 3':'Save a baked .bin and upload it to the Basys 3'):
      (engine.value==='scene'?'Dynamic RECT + TEXT requires a 1920 × 1080 scene':
        'FPGA ROM v1 requires a 1920 × 1080 scene with a constant palette');
  }
  engine.addEventListener('change',()=>{revision++;update();});
  button.addEventListener('click',async()=>{
    if(busy||button.disabled)return;
    busy=true;update();
    const snapshotRevision=revision;
    const snapshot=JSON.stringify({scene:getScene(),engine:engine.value});
    button.textContent='Uploading…';
    status.textContent=engine.value==='scene'?'Compiling TEXT/RECT Y programs and programming the FPGA…':'Baking X programs and programming the FPGA…';
    download.hidden=true;
    try{
      const response=await fetch('/api/fpga/program',{
        method:'POST',headers:{'Content-Type':'application/json'},body:snapshot
      });
      const data=await response.json();
      if(data.downloadUrl){download.href=data.downloadUrl;download.hidden=false;}
      const changed=snapshotRevision!==revision?' · Scene changed; upload again to include new edits.':'';
      if(!response.ok||!data.ok){
        status.textContent=`Upload failed: ${data.error||`HTTP ${response.status}`}`+
          (data.filename?' · The .bin file was saved.':'')+changed;
        status.title=data.log||'';
      }else{
        const content=data.engine==='scene'?`${data.primitives.toLocaleString()} RECT/glyph records · ${data.glyphs.toLocaleString()} glyphs`:
          `${data.runs.toLocaleString()} runs`;
        status.textContent=`Uploaded ${content} · ${data.bytes.toLocaleString()} bytes`+changed;
        status.title=data.log||'';
      }
    }catch(error){status.textContent='Upload failed: '+error.message;}
    finally{busy=false;button.textContent='Export .bin & upload FPGA';update();}
  });
  update();
  return {markDirty(){revision++;update();}};
}
