/* Two-stage raster machine.
   A compact Y-program schedules rounded rectangles and palette changes.
   The Y VM executes those instructions, maintains active rounded-rectangle
   generators, and materializes an X linked list for the current scanline. */
export const WIDTH=320, HEIGHT=200, LAYERS=64;
export const initialPalette=()=>Array.from({length:LAYERS},(_,i)=>i===0?'#101827':'#ffffff');
export const demoScene=()=>({
  palette:Object.assign(initialPalette(),{
    1:'#0f6b78',  // desktop teal
    2:'#4b4b4b',  // drop shadow
    3:'#c3c7cb',  // window chrome
    4:'#0a5cc8',  // blue title bar
    5:'#e8e8e8',  // menus and toolbars
    6:'#ffffff',  // drawing paper
    7:'#000000',  // outlines / black swatch / menu text
    8:'#86c9ff',  // sky
    9:'#64b44e',  // grass
    10:'#ffd84a', // sun
    11:'#8c6239', // house walls
    12:'#d84a3a', // red roof
    13:'#73512f', // tree trunk
    14:'#2e8b57', // tree canopy
    15:'#7f7f7f', // door
    16:'#b7b7b7', // UI buttons / icons
    17:'#b9e6ff', // windows
    18:'#ffffff', // clouds
    19:'#ff5f57', // macOS close
    20:'#febc2e', // macOS minimize
    21:'#28c840'  // macOS maximize
  }),
  shapes:[
    // Desktop, shadow, and Paint-style application window.
    {id:1,x:0,y:0,w:320,h:200,radius:0,layer:1},
    {id:2,x:22,y:14,w:276,h:170,radius:0,layer:2},
    {id:3,x:18,y:10,w:276,h:170,radius:0,layer:3},
    {id:4,x:20,y:12,w:272,h:16,radius:0,layer:4},
    {id:5,x:20,y:30,w:272,h:10,radius:0,layer:5},
    // Left sidebar and bottom status / palette strip.
    {id:6,x:20,y:42,w:26,h:122,radius:0,layer:5},
    {id:7,x:20,y:166,w:272,h:12,radius:0,layer:5},
    // Paper, sky, grass, sun and clouds.
    {id:8,x:47,y:42,w:245,h:122,radius:0,layer:7},
    {id:9,x:48,y:43,w:243,h:120,radius:0,layer:6},
    {id:10,x:49,y:44,w:241,h:54,radius:0,layer:8},
    {id:11,x:49,y:98,w:241,h:64,radius:0,layer:9},
    {id:12,x:62,y:52,w:20,h:20,radius:10,layer:10},
    {id:13,x:94,y:59,w:43,h:10,radius:5,layer:18},
    {id:14,x:104,y:54,w:24,h:16,radius:8,layer:18},
    // Little house: walls and roof in front of the grass.
    {id:15,x:132,y:92,w:56,h:34,radius:0,layer:11},
    {id:16,x:126,y:82,w:68,h:12,radius:2,layer:12},
    {id:17,x:153,y:106,w:14,h:20,radius:0,layer:15},
    {id:18,x:140,y:100,w:10,h:10,radius:0,layer:17},
    {id:19,x:171,y:100,w:10,h:10,radius:0,layer:17},
    // Tree: canopy in front of the trunk.
    {id:20,x:214,y:100,w:10,h:24,radius:0,layer:13},
    {id:21,x:198,y:80,w:42,h:28,radius:14,layer:14},
    // macOS-style traffic lights flush left in the title bar.
    {id:22,x:24,y:14,w:12,h:12,radius:6,layer:19},
    {id:23,x:40,y:14,w:12,h:12,radius:6,layer:20},
    {id:24,x:56,y:14,w:12,h:12,radius:6,layer:21},
    // Menu strip: File / Edit / View / Image / Help as tiny dark rectangles.
    {id:25,x:28,y:33,w:12,h:4,radius:0,layer:7},
    {id:26,x:48,y:33,w:12,h:4,radius:0,layer:7},
    {id:27,x:68,y:33,w:12,h:4,radius:0,layer:7},
    {id:28,x:88,y:33,w:16,h:4,radius:0,layer:7},
    {id:29,x:112,y:33,w:12,h:4,radius:0,layer:7},
    // Left sidebar toolbar as a two-column button grid.
    {id:30,x:24,y:48,w:8,h:8,radius:2,layer:16},
    {id:31,x:35,y:48,w:8,h:8,radius:2,layer:16},
    {id:32,x:24,y:61,w:8,h:8,radius:2,layer:16},
    {id:33,x:35,y:61,w:8,h:8,radius:2,layer:16},
    {id:34,x:24,y:74,w:8,h:8,radius:2,layer:16},
    {id:35,x:35,y:74,w:8,h:8,radius:2,layer:16},
    {id:36,x:24,y:87,w:8,h:8,radius:2,layer:16},
    {id:37,x:35,y:87,w:8,h:8,radius:2,layer:16},
    {id:38,x:24,y:100,w:8,h:8,radius:2,layer:16},
    {id:39,x:35,y:100,w:8,h:8,radius:2,layer:16},
    {id:40,x:24,y:113,w:8,h:8,radius:2,layer:16},
    {id:41,x:35,y:113,w:8,h:8,radius:2,layer:16},
    // Color palette in the bottom strip.
    {id:42,x:54,y:167,w:12,h:10,radius:0,layer:7},
    {id:43,x:68,y:167,w:12,h:10,radius:0,layer:12},
    {id:44,x:82,y:167,w:12,h:10,radius:0,layer:8},
    {id:45,x:96,y:167,w:12,h:10,radius:0,layer:9},
    {id:46,x:110,y:167,w:12,h:10,radius:0,layer:10}
  ],
  paletteEvents:[]
});

const clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));
const edgeOrder=(a,b)=>a.x-b.x||a.layer-b.layer||a.delta-b.delta||a.key.localeCompare(b.key);
const insetCache=new Map([[0,[]]]);

function normalizeRect(shape){
  const x=Math.round(Number(shape.x)||0);
  const y=Math.round(Number(shape.y)||0);
  const w=Math.max(0,Math.round(Number(shape.w)||0));
  const h=Math.max(0,Math.round(Number(shape.h)||0));
  const layer=clamp(Math.round(Number(shape.layer)||0),1,LAYERS-1);
  const maxRadius=Math.floor(Math.min(w,h)/2);
  const radius=clamp(Math.round(Number(shape.radius)||0),0,maxRadius);
  return {id:shape.id,x,y,w,h,radius,layer};
}

/* Generate the top quarter-circle using an incremental integer error.
   All positions are measured at pixel centers, doubled to avoid fractions.
   The next candidate pixel is inside when X² + Y² - (2r)² <= 0.
   Moving a pixel right changes the error by 4X+4; moving one row down
   changes it by -4Y+4. No square roots, division, or multiplication. */
export function circleInsets(radius){
  radius=Math.max(0,Math.floor(radius));
  if(insetCache.has(radius))return insetCache.get(radius);
  const insets=[];
  let inset=radius;
  let X=1, Y=2*radius-1;
  let error=2-4*radius;
  for(let row=0;row<radius;row++){
    while(inset>0&&error<=0){
      inset--;
      error+=4*X+4;
      X+=2;
    }
    insets.push(inset);
    error+=-4*Y+4;
    Y-=2;
  }
  insetCache.set(radius,insets);
  return insets;
}

function spanForRect(rect,y){
  if(y<rect.y||y>=rect.y+rect.h||rect.w<=0||rect.h<=0)return null;
  const r=rect.radius;
  if(r===0)return [rect.x,rect.x+rect.w];
  const localY=y-rect.y;
  let inset=0;
  if(localY<r) inset=circleInsets(r)[localY];
  else if(localY>=rect.h-r) inset=circleInsets(r)[rect.h-1-localY];
  return [rect.x+inset,rect.x+rect.w-inset];
}

function createEdge(rect,kind,x){
  return {key:`${rect.id}:${kind}`,x,layer:rect.layer,delta:kind==='start'?1:-1,shape:rect.id,next:null};
}

function listArray(head){
  const result=[];let node=head.next,guard=0;
  while(node){
    if(++guard>100000)throw Error('X linked-list cycle');
    const {next,...edge}=node;result.push(edge);node=next;
  }
  return result;
}

function relink(machine){
  const sorted=[...machine.nodes.values()].sort(edgeOrder);
  let tail=machine.head;
  for(const node of sorted){tail.next=node;tail=node;}
  tail.next=null;
}

function syncRectNode(machine,key,edge,changes){
  const existing=machine.nodes.get(key);
  if(!existing){
    machine.nodes.set(key,{...edge,next:null});
    changes.push({op:'INSERT',key,x:edge.x,layer:edge.layer,shape:edge.shape});
    return;
  }
  if(existing.x!==edge.x||existing.layer!==edge.layer||existing.delta!==edge.delta){
    changes.push({op:'MOVE',key,from:existing.x,to:edge.x,layer:edge.layer,shape:edge.shape});
    existing.x=edge.x;existing.layer=edge.layer;existing.delta=edge.delta;existing.shape=edge.shape;
  }
}

function deleteNode(machine,key,changes){
  const node=machine.nodes.get(key);
  if(!node)return;
  changes.push({op:'DELETE',key,x:node.x,layer:node.layer,shape:node.shape});
  machine.nodes.delete(key);
}

function syncActiveRects(machine,y){
  const changes=[];
  const finished=[];
  for(const rect of machine.activeRects.values()){
    const startKey=`${rect.id}:start`, stopKey=`${rect.id}:stop`;
    if(y<rect.y||y>=rect.y+rect.h){
      deleteNode(machine,startKey,changes);
      deleteNode(machine,stopKey,changes);
      if(y>=rect.y+rect.h)finished.push(rect.id);
      continue;
    }
    const span=spanForRect(rect,y);
    if(!span){
      deleteNode(machine,startKey,changes);
      deleteNode(machine,stopKey,changes);
      continue;
    }
    const [leftRaw,rightRaw]=span;
    const left=clamp(Math.round(leftRaw),0,WIDTH);
    const right=clamp(Math.round(rightRaw),0,WIDTH);
    if(right<=left){
      deleteNode(machine,startKey,changes);
      deleteNode(machine,stopKey,changes);
      continue;
    }
    syncRectNode(machine,startKey,createEdge(rect,'start',left),changes);
    syncRectNode(machine,stopKey,createEdge(rect,'stop',right),changes);
  }
  for(const id of finished)machine.activeRects.delete(id);
  relink(machine);
  return changes;
}

function renderRow(head){
  const counts=new Int32Array(LAYERS),row=new Uint8Array(WIDTH);
  let node=head.next,active=0n,events=0;
  for(let x=0;x<WIDTH;x++){
    while(node&&node.x<=x){
      const l=node.layer;
      if(!Number.isInteger(l)||l<1||l>=LAYERS)throw Error(`Invalid paint layer ${l}`);
      counts[l]+=node.delta;
      if(counts[l]<0)throw Error(`Unbalanced STOP at x=${x} layer=${l}`);
      if(counts[l])active|=1n<<BigInt(l);
      else active&=~(1n<<BigInt(l));
      node=node.next;events++;
    }
    let top=0;
    for(let l=LAYERS-1;l>0;l--)if(active&(1n<<BigInt(l))){top=l;break;}
    row[x]=top;
  }
  while(node&&node.x===WIDTH){counts[node.layer]+=node.delta;node=node.next;events++;}
  if(node)throw Error('X instruction beyond screen');
  for(let l=1;l<LAYERS;l++)if(counts[l]!==0)throw Error(`Unbalanced layer ${l}`);
  return {row,events};
}

export function compileY(scene){
  const buckets=new Map();
  function push(y,instruction){
    if(y<0||y>=HEIGHT)return;
    if(!buckets.has(y))buckets.set(y,[]);
    buckets.get(y).push(instruction);
  }
  for(const shape of scene.shapes||[]){
    const rect=normalizeRect(shape);
    if(rect.w<=0||rect.h<=0)continue;
    push(rect.y,{op:'ROUND_RECT',rect});
  }
  for(const event of scene.paletteEvents||[]){
    const y=Math.round(Number(event.y)||0);
    const layer=Math.round(Number(event.layer)||0);
    if(y<0||y>=HEIGHT||layer<0||layer>=LAYERS)continue;
    push(y,{op:'SET_PALETTE',layer,color:event.color});
  }
  const ys=[...buckets.keys()].sort((a,b)=>a-b);
  const program=[];
  for(const y of ys){
    program.push({op:'WAIT_Y',y});
    const instructions=buckets.get(y).slice().sort((a,b)=>{
      if(a.op!==b.op)return a.op.localeCompare(b.op);
      if(a.op==='ROUND_RECT')return a.rect.id-b.rect.id;
      return a.layer-b.layer;
    });
    program.push(...instructions);
  }
  program.push({op:'WAIT_Y',y:HEIGHT});
  program.push({op:'HALT'});
  return program;
}

function makeMachine(scene,program){
  return {
    head:{key:'HEAD',next:null},
    nodes:new Map(),
    activeRects:new Map(),
    palette:[...scene.palette],
    program,
    pc:0,
    y:0,
    halted:false
  };
}

function execute(machine,ins){
  switch(ins.op){
    case 'ROUND_RECT':{
      const rect=normalizeRect(ins.rect);
      if(machine.activeRects.has(rect.id))throw Error(`Duplicate rounded rectangle ${rect.id}`);
      machine.activeRects.set(rect.id,rect);
      break;
    }
    case 'SET_PALETTE':{
      if(!Number.isInteger(ins.layer)||ins.layer<0||ins.layer>=LAYERS)throw Error(`Invalid palette layer ${ins.layer}`);
      machine.palette[ins.layer]=ins.color;
      break;
    }
    default:
      throw Error(`Unknown Y opcode ${ins.op}`);
  }
}

/* Execute all Y bytecode scheduled for this scanline, then materialize X. */
export function advanceY(machine,y){
  if(y<machine.y)throw Error('Y machine cannot rewind');
  machine.y=y;
  const executed=[];
  while(machine.pc<machine.program.length){
    const ins=machine.program[machine.pc];
    if(ins.op==='WAIT_Y'){
      if(ins.y>y)break;
      executed.push({pc:machine.pc,ins});
      machine.pc++;
      continue;
    }
    if(ins.op==='HALT'){
      machine.halted=true;
      break;
    }
    execute(machine,ins);
    executed.push({pc:machine.pc,ins});
    machine.pc++;
  }
  const changes=syncActiveRects(machine,y);
  return {executed,changes,pc:machine.pc};
}

export function runYProgram(scene,program){
  const machine=makeMachine(scene,program),frames=[],logs=[];
  let totalEdits=0,totalEvents=0;
  for(let y=0;y<HEIGHT;y++){
    const {executed,changes,pc}=advanceY(machine,y);
    const edges=listArray(machine.head);
    const {row,events}=renderRow(machine.head);
    totalEdits+=changes.length;
    totalEvents+=events;
    frames.push({y,row,edges,palette:[...machine.palette],events,edits:changes.length,executed,changes,pc});
    logs.push({y,events,edits:changes.length});
  }
  return {program,frames,logs,totalEvents,totalEdits};
}

export function compile(scene){return runYProgram(scene,compileY(scene));}
export const rasterize=compile;

export function referenceRow(scene,y){
  const row=new Uint8Array(WIDTH);
  for(let x=0;x<WIDTH;x++){
    let layer=0;
    for(const raw of scene.shapes||[]){
      const rect=normalizeRect(raw);
      const span=spanForRect(rect,y);
      if(span&&x>=clamp(Math.round(span[0]),0,WIDTH)&&x<clamp(Math.round(span[1]),0,WIDTH))layer=Math.max(layer,rect.layer);
    }
    row[x]=layer;
  }
  return row;
}
