/* Export/upload always snapshots the current editor scene, including unsaved edits. */
export function createFpgaControls({getScene}){
  const button=document.getElementById('fpga-program');
  const status=document.getElementById('fpga-status');
  const download=document.getElementById('fpga-download');
  let busy=false,revision=0;
  function update(){
    const scene=getScene();
    const supported=scene.width===1920&&scene.height===1080&&!scene.paletteEvents?.length;
    button.disabled=busy||!supported;
    button.title=supported?'Save a baked .bin and upload it to the Basys 3':
      'FPGA ROM v1 requires a 1920 × 1080 scene with a constant palette';
  }
  button.addEventListener('click',async()=>{
    if(busy||button.disabled)return;
    busy=true;update();
    const snapshotRevision=revision;
    const snapshot=JSON.stringify({scene:getScene()});
    button.textContent='Uploading…';
    status.textContent='Baking X programs and programming the FPGA…';
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
        status.textContent=`Uploaded ${data.runs.toLocaleString()} runs · ${data.bytes.toLocaleString()} bytes`+changed;
        status.title=data.log||'';
      }
    }catch(error){status.textContent='Upload failed: '+error.message;}
    finally{busy=false;button.textContent='Export .bin & upload FPGA';update();}
  });
  update();
  return {markDirty(){revision++;update();}};
}
