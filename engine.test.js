import {test,expect} from 'bun:test';
import {WIDTH,HEIGHT,demoScene,rasterize,referenceRow,compileY,runYProgram,circleInsets} from './engine.js';

test('compiled X programs match direct geometric rasterization on every scanline',()=>{
  const scene=demoScene(),r=rasterize(scene);
  expect(r.frames.length).toBe(HEIGHT);
  for(let y=0;y<HEIGHT;y++)expect([...r.frames[y].row]).toEqual([...referenceRow(scene,y)]);
});

test('same-layer overlap retains paint until last STOP',()=>{
  const scene=demoScene();
  scene.shapes=[
    {id:1,x:10,y:10,w:100,h:40,radius:0,layer:3},
    {id:2,x:50,y:10,w:100,h:40,radius:0,layer:3}
  ];
  const r=rasterize(scene);
  expect(r.frames[20].row[110]).toBe(3);
  expect(r.frames[20].row[150]).toBe(0);
});

test('higher palette layer wins regardless of geometric insertion order',()=>{
  const scene=demoScene();
  scene.shapes=[
    {id:1,x:0,y:0,w:200,h:100,radius:0,layer:7},
    {id:2,x:50,y:0,w:200,h:100,radius:0,layer:2}
  ];
  const r=rasterize(scene);
  expect(r.frames[5].row[75]).toBe(7);
  expect(r.frames[5].row[225]).toBe(2);
});

test('palette updates apply at requested scanline',()=>{
  const scene=demoScene();
  scene.paletteEvents=[{y:120,layer:2,color:'#8958ac'}];
  const r=rasterize(scene);
  expect(r.frames[119].palette[2]).toBe('#4b4b4b');
  expect(r.frames[120].palette[2]).toBe('#8958ac');
});

test('Y program is compact and shape-oriented',()=>{
  const program=compileY(demoScene());
  expect(program.some(ins=>ins.op==='ROUND_RECT')).toBe(true);
  expect(program.some(ins=>ins.op==='INSERT'||ins.op==='MOVE'||ins.op==='DELETE')).toBe(false);
  expect(program.length).toBeLessThanOrEqual(2*demoScene().shapes.length+2);
});

test('Y program is executable independently of scene geometry',()=>{
  const scene=demoScene();
  const program=compileY(scene);
  const baseline=runYProgram(scene,program);
  const withoutShapes={...scene,shapes:[]};
  const replay=runYProgram(withoutShapes,program);
  for(let y=0;y<HEIGHT;y++)expect([...replay.frames[y].row]).toEqual([...baseline.frames[y].row]);
});

test('editing Y bytecode changes X list and pixels',()=>{
  const scene={palette:demoScene().palette,shapes:[{id:1,x:10,y:5,w:30,h:10,radius:0,layer:3}],paletteEvents:[]};
  const program=compileY(scene);
  const rect=program.find(i=>i.op==='ROUND_RECT');
  expect(rect).toBeDefined();
  rect.rect.x=20;
  const result=runYProgram({...scene,shapes:[]},program);
  expect(result.frames[5].row[15]).toBe(0);
  expect(result.frames[5].row[25]).toBe(3);
  expect(result.frames[5].edges[0].x).toBe(20);
});

test('Y program waits until scheduled scanline to mutate X list',()=>{
  const scene={palette:demoScene().palette,shapes:[{id:1,x:10,y:5,w:30,h:10,radius:0,layer:3}],paletteEvents:[]};
  const result=runYProgram(scene,compileY(scene));
  expect(result.frames[4].edges).toHaveLength(0);
  expect(result.frames[5].edges).toHaveLength(2);
  expect(result.frames[15].edges).toHaveLength(0);
  expect(result.frames[5].executed.some(e=>e.ins.op==='ROUND_RECT')).toBe(true);
});

test('zero radius yields a sharp rectangle on every occupied row',()=>{
  const scene={...demoScene(),shapes:[{id:1,x:20,y:30,w:80,h:40,radius:0,layer:4}],paletteEvents:[]};
  const result=rasterize(scene);
  for(const y of [30,31,49,68,69])expect(result.frames[y].edges.map(e=>e.x)).toEqual([20,100]);
  expect(result.frames[29].edges).toHaveLength(0);
  expect(result.frames[70].edges).toHaveLength(0);
});

test('rounded rectangle corners follow a circle rather than an ellipse',()=>{
  const scene={...demoScene(),shapes:[{id:1,x:10,y:20,w:100,h:40,radius:10,layer:3}],paletteEvents:[]};
  const result=rasterize(scene);
  const inset=dy=>{
    let blank=10;
    while(blank>0){
      const candidate=blank-1;
      const dx=10-candidate-0.5;
      if(dx*dx + dy*dy <= 100) blank=candidate;
      else break;
    }
    return blank;
  };
  expect(result.frames[20].edges.map(e=>e.x)).toEqual([10+inset(9.5),110-inset(9.5)]);
  expect(result.frames[25].edges.map(e=>e.x)).toEqual([10+inset(4.5),110-inset(4.5)]);
  expect(result.frames[30].edges.map(e=>e.x)).toEqual([10,110]);
  expect(result.frames[59].edges.map(e=>e.x)).toEqual(result.frames[20].edges.map(e=>e.x));
});

test('corner radius is clamped to half the smaller dimension',()=>{
  const make=radius=>({...demoScene(),shapes:[{id:1,x:15,y:25,w:120,h:30,radius,layer:2}],paletteEvents:[]});
  const clamped=rasterize(make(15)),oversized=rasterize(make(500));
  for(let y=25;y<55;y++)expect(oversized.frames[y].edges.map(e=>e.x)).toEqual(clamped.frames[y].edges.map(e=>e.x));
});

test('rounded corners use symmetric coverage',()=>{
  const scene={...demoScene(),shapes:[{id:1,x:35,y:35,w:250,h:38,radius:12,layer:2}],paletteEvents:[]};
  const result=rasterize(scene);
  for(let y=35;y<73;y++){
    const row=result.frames[y].row;
    for(let dx=0;dx<125;dx++)expect(row[35+dx]).toBe(row[284-dx]);
  }
});

test('incremental integer arcs match exact circle coverage for radii 1–128',()=>{
  for(let radius=1;radius<=128;radius++){
    const actual=circleInsets(radius);
    expect(actual).toHaveLength(radius);
    for(let row=0;row<radius;row++){
      let expected=radius;
      const dy=radius-row-.5;
      while(expected>0){
        const dx=radius-(expected-1)-.5;
        if(dx*dx+dy*dy<=radius*radius)expected--;
        else break;
      }
      expect(actual[row]).toBe(expected);
      if(row>0)expect(actual[row]).toBeLessThanOrEqual(actual[row-1]);
    }
  }
});

test('default Paint scene preserves foregrounds, background, and palette',()=>{
  const r=rasterize(demoScene());
  expect(r.frames[15].row[175]).toBe(1); // desktop
  expect(r.frames[117].row[388]).toBe(4); // title bar background to the right of traffic lights
  expect(r.frames[210].row[325]).toBe(8); // sky
  expect(r.frames[405].row[595]).toBe(11); // house in front of grass
  expect(r.frames[360].row[805]).toBe(14); // canopy in front of sky
  expect(r.frames[570].row[379]).toBe(12); // color palette in status strip
});

test('default Paint scene uses macOS traffic lights, menu items, and a two-column sidebar toolbar',()=>{
  const r=rasterize(demoScene());
  expect(r.frames[120].row[250]).toBe(19); // red close button flush left
  expect(r.frames[120].row[298]).toBe(20); // yellow minimize button
  expect(r.frames[120].row[346]).toBe(21); // green maximize button
  expect(r.frames[165].row[250]).toBe(7);  // File menu block
  expect(r.frames[165].row[316]).toBe(7);  // Edit menu block
  expect(r.frames[165].row[445]).toBe(7);  // Image menu block
  expect(r.frames[216].row[241]).toBe(16); // left toolbar button column 1
  expect(r.frames[216].row[274]).toBe(16); // left toolbar button column 2
  expect(r.frames[228].row[259]).toBe(5);  // gap between columns remains sidebar bg
});

test('each corner has an independent circular radius',()=>{
  const scene={...demoScene(),shapes:[{id:1,x:40,y:20,w:100,h:60,radius:[12,4,8,0],layer:3}],paletteEvents:[]};
  const frames=rasterize(scene).frames;
  const first=frames[20].edges.map(e=>e.x);
  const middle=frames[50].edges.map(e=>e.x);
  const last=frames[79].edges.map(e=>e.x);
  expect(first[0]).toBeGreaterThan(40);
  expect(first[1]).toBeLessThan(140);
  expect(first[0]-40).toBeGreaterThan(140-first[1]);
  expect(middle).toEqual([40,140]);
  expect(last[0]).toBe(40);
  expect(last[1]).toBeLessThan(140);
});

test('CSS radius normalization prevents adjacent corners overlapping',()=>{
  const make=radius=>({...demoScene(),shapes:[{id:1,x:40,y:20,w:40,h:20,radius,layer:3}],paletteEvents:[]});
  const oversized=rasterize(make([50,50,50,50]));
  const clamped=rasterize(make(10));
  for(let y=20;y<40;y++)expect(oversized.frames[y].edges.map(e=>e.x)).toEqual(clamped.frames[y].edges.map(e=>e.x));
});

test('the window title has square bottom corners and the status strip fits rounded bottom corners',()=>{
  const frames=rasterize(demoScene()).frames;
  expect(frames[141].row[220]).toBe(4); // title bar remains square at bottom-left
  expect(frames[558].row[220]).toBe(5); // status strip starts square
  expect(frames[591].row[220]).not.toBe(5); // bottom strip no longer spills past window shell
  expect(frames[591].row[295]).toBe(5); // middle of status strip remains filled
});

test('1280x720 demo fills the HD frame and preserves circular scaled geometry',()=>{
  const scene=demoScene();
  expect([WIDTH,HEIGHT]).toEqual([1280,720]);
  const background=scene.shapes.find(s=>s.id===1);
  expect([background.x,background.y,background.w,background.h]).toEqual([0,0,1280,720]);
  const window=scene.shapes.find(s=>s.id===3);
  expect([window.x,window.y,window.w,window.h,window.radius]).toEqual([214,90,828,510,30]);
  const title=scene.shapes.find(s=>s.id===4);
  expect(title.radius).toEqual([24,24,0,0]);
});
