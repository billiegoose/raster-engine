import {test, expect} from 'bun:test';
import {paletteView} from './palette-view.js';

test('palette layers include only participating layers, highest first',()=>{
  const base=Array(64).fill('#ffffff');
  base[0]='#101827';base[2]='#336699';base[8]='#334455';
  const view=paletteView({row:[0,2,2,0],edges:[{layer:2},{layer:8},{layer:8}],palette:[...base]},base);
  expect(view).toHaveLength(3);
  expect(view.map(item=>item.layer)).toEqual([8,2,0]);
  expect(view[0]).toEqual({layer:8,color:'#334455',visible:false,overridden:false});
  expect(view[1]).toEqual({layer:2,color:'#336699',visible:true,overridden:false});
  expect(view[2]).toEqual({layer:0,color:'#101827',visible:true,overridden:false});
  expect(view.find(item=>item.layer===1)).toBeUndefined();
});

test('palette layers track Y-program color changes on the selected scanline',()=>{
  const base=Array(64).fill('#ffffff');
  base[3]='#112233';
  const before=paletteView({row:[3],edges:[{layer:3}],palette:[...base]},base);
  const changed=[...base];changed[3]='#d64e78';
  const after=paletteView({row:[0,3],edges:[{layer:3}],palette:changed},base);
  expect(before[0].overridden).toBe(false);
  expect(after[0]).toEqual({layer:3,color:'#d64e78',visible:true,overridden:true});
  expect(after.map(item=>item.layer)).toEqual([3,0]);
});

test('palette layer stack is empty when there are no pixels or X instructions',()=>{
  const palette=Array(64).fill('#ffffff');
  expect(paletteView({row:[],edges:[],palette},palette)).toEqual([]);
});
