"""Re-route the unchanged mapped scene design, then optionally pack a passing seed.

Uses fpgatool's pinned container, generated nextpnr command and board database.
This avoids repeating synthesis or HDL captures when exploring placement.
"""
from pathlib import Path
import argparse
import hashlib
import json
import shlex
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from fpga.tool import HARDWARE_SOURCES, read_timing, verify_data_lanes


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('seed', type=int)
    parser.add_argument('--pack', action='store_true', help='pack and record an already routed, passing seed')
    args = parser.parse_args()
    if args.seed < 2:
        parser.error('Use a positive alternate seed (2 or greater)')
    tool_root = Path(shutil.which('fpgatool')).resolve().parent
    sys.path.insert(0, str(tool_root))
    import fpgatool as tool
    directory = tool_root/'build/basys3/raster_scene'
    mapped = directory/'pipelinec/top'
    staged = tool_root/'build/raster-engine-source/build-dynamic/fpga'
    for name in HARDWARE_SOURCES:
        expected = b'STRIPES = False\n' if name == 'dynamic_config.py' else (ROOT/'fpga'/name).read_bytes()
        if expected != (staged/name).read_bytes():
            raise ValueError('Mapped source differs from current hardware: '+name)
    inputs = {'netlist': sha(mapped/'top.json'), 'clocks': sha(mapped.parent/'clocks.py'),
              'pins': sha(tool_root/'boards/basys3/pins.xdc'),
              'hardware': {name: sha(staged/name) for name in sorted(HARDWARE_SOURCES)}}
    prefix = f'top-seed{args.seed}'
    log = mapped/(prefix+'.log')
    manifest = mapped/(prefix+'.json')
    inside = '/workspace/'+mapped.relative_to(tool_root).as_posix()
    command = next(line for line in (mapped/'top.sh').read_text().splitlines() if ' --chipdb ' in line)
    route = shlex.split(command.split('&>>')[0])
    route[route.index('--seed')+1] = str(args.seed)
    route[route.index('--fasm')+1] = prefix+'.fasm'

    def run(script, output):
        path = mapped/(prefix+'-command.sh')
        path.write_text('set -e\ncd '+shlex.quote(inside)+'\n'+script+'\n')
        cmd = tool.podman_base(pipelinec_dir=tool_root/'.fpgatool/cache/PipelineC') + [
            'nix', '--extra-experimental-features', 'nix-command flakes', 'develop',
            'path:/workspace/toolchain', '--command', 'bash', inside+'/'+path.name]
        with output.open('w') as stream:
            subprocess.run(cmd, stdout=stream, stderr=subprocess.STDOUT, check=True)

    if not args.pack:
        manifest.unlink(missing_ok=True)
        run(shlex.join(route), log)
        clocks = read_timing(log)
        manifest.write_text(json.dumps(dict(inputs=inputs, clocks=clocks,
                                           fasm_sha256=sha(mapped/(prefix+'.fasm'))), indent=2)+'\n')
        print(json.dumps(clocks), flush=True)
        return
    saved = json.loads(manifest.read_text())
    if saved['inputs'] != inputs or saved['fasm_sha256'] != sha(mapped/(prefix+'.fasm')):
        raise ValueError('Routing inputs or FASM changed; re-route this seed')
    clocks = read_timing(log)
    memory = verify_data_lanes(mapped/'top.json', all_memories=True)
    fasm = (mapped/(prefix+'.fasm')).read_text()
    feature = 'LIOB33_X0Y47.IOB_Y1.PULLTYPE.'
    fasm = fasm.replace(feature+'NONE', feature+'PULLUP')
    if feature+'PULLUP' not in fasm.splitlines():
        raise ValueError('Required Basys 3 flash SO pull-up feature is missing')
    (mapped/(prefix+'-pack.fasm')).write_text(fasm)
    part = tool.board_config('basys3')['fpga']['part']
    run(f'fasm2frames --part {shlex.quote(part)} --db-root "$PRJXRAY_DB_DIR/artix7" '
        f'{prefix}-pack.fasm > {prefix}.frames\n'
        f'xc7frames2bit --part_file "$PRJXRAY_DB_DIR/artix7/{part}/part.yaml" '
        f'--part_name {shlex.quote(part)} --frm_file {prefix}.frames --output_file {prefix}.bit',
        mapped/(prefix+'-pack.log'))
    destination = ROOT/'fpga/build'
    for target in [directory/'raster_scene.bit', destination/'raster_scene.bit', mapped/'top.bit']:
        shutil.copy2(mapped/(prefix+'.bit'), target)
    original = mapped/'open_tools_final.log'
    shutil.copy2(original, mapped/'open_tools_final_seed1.log')
    shutil.copy2(log, original)
    shutil.copy2(log, destination/'scene-timing.log')
    shutil.copy2(mapped/(prefix+'-pack.fasm'), mapped/'top.fasm')
    shutil.copy2(mapped/(prefix+'.frames'), mapped/'top.frames')
    info = dict(producer='scene', route_seed=args.seed, bitstream_sha256=sha(destination/'raster_scene.bit'),
                clocks=clocks, memory=memory, routing_inputs=inputs)
    for target in [directory/'producer.json', destination/'scene-build.json']:
        target.write_text(json.dumps(info, indent=2)+'\n')
    print(json.dumps(info, indent=2))


if __name__ == '__main__':
    main()
