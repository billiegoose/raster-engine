"""Stage this folder for current fpgatool's checkout-local build requirement."""
from __future__ import annotations
import argparse
import hashlib
import json
import re
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def read_timing(path):
    clocks={name:{'achieved_mhz':float(rate),'required_mhz':float(required),'status':status}
        for name,rate,status,required in re.findall(
            r"Max frequency for clock\s+'([^']+)': ([0-9.]+) MHz \((PASS|FAIL) at ([0-9.]+) MHz\)",
            Path(path).read_text())}
    # The 100 MHz process only contains the MMCM. It may have no timed
    # register paths; the complete raster datapath must meet 148.5 MHz.
    if 148.5 not in {clock['required_mhz'] for clock in clocks.values()}:
        raise ValueError('Final routing report does not contain the required pixel clock')
    if any(clock['status']!='PASS' for clock in clocks.values()):
        raise ValueError('Final FPGA route failed its clock constraint; see '+str(path))
    return clocks


def verify_data_lanes(path):
    """Reject a mapped run memory that puts payload bits on BRAM parity pins."""
    design = json.loads(Path(path).read_text())
    found = set()
    blocks = 0
    for module in design['modules'].values():
        parity_outputs = set()
        for name, cell in module.get('cells', {}).items():
            bank = next((bank for bank in ('run_low', 'run_mid', 'run_high') if bank+'_' in name), None)
            if cell['type'] != 'RAMB36E1' or bank is None:
                continue
            found.add(bank)
            blocks += 1
            for port in ('DIPADIP', 'DIPBDIP'):
                if any(isinstance(bit, int) for bit in cell['connections'].get(port, ())):
                    raise ValueError('Run memory uses a BRAM parity input: '+name)
            for port in ('CASCADEINA', 'CASCADEINB'):
                if any(isinstance(bit, int) for bit in cell['connections'].get(port, ())):
                    raise ValueError('Run memory uses an unsupported native BRAM cascade: '+name)
            for port in ('DOPADOP', 'DOPBDOP'):
                parity_outputs.update(bit for bit in cell['connections'].get(port, ()) if isinstance(bit, int))
        for name, cell in module.get('cells', {}).items():
            for port, direction in cell.get('port_directions', {}).items():
                if direction == 'input' and parity_outputs.intersection(cell['connections'][port]):
                    raise ValueError('Run memory uses a BRAM parity output: '+name)
    if found != {'run_low', 'run_mid', 'run_high'}:
        raise ValueError('Mapped design does not contain all three data-only run banks')
    return {'run_bram_blocks': blocks, 'parity_payload_bits': 0, 'native_cascades': 0}


def stage(action):
    executable = shutil.which('fpgatool')
    if not executable:
        raise ValueError('fpgatool is not on PATH')
    tool_root = Path(executable).resolve().parent
    if not (tool_root/'fpgatool.py').is_file() or not (tool_root/'examples').is_dir():
        raise ValueError('Cannot locate fpgatool checkout from its PATH executable')
    # Separate simulation and synthesis copies: one command must not replace
    # imported source files while the other compiler is reading them.
    directory = tool_root/'build/raster-engine-source'/action
    package = directory/'fpga'
    package.mkdir(parents=True, exist_ok=True)
    digest=hashlib.sha256()
    hardware={'__init__.py','board.py','capture.py','boot_capture.py','diagnostics.py','format.py','image.py','loader.py','scanout.py','top.py'}
    for source in sorted((ROOT/'fpga').glob('*.py')):
        shutil.copy2(source, package/source.name)
        if source.name in hardware:
            digest.update(source.name.encode()+source.read_bytes())
    setup = ('import sys\nfrom pathlib import Path\n'
             'sys.path.insert(0, str(Path(__file__).resolve().parents[3]/"examples"))\n')
    for filename, module in [('raster_rom.py', 'top'), ('raster_capture.py', 'capture'),
                             ('raster_boot_capture.py', 'boot_capture')]:
        (directory/filename).write_text(setup+f'from fpga.{module} import *\n# source: {digest.hexdigest()}\n')
    return tool_root, directory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('build', 'load', 'program', 'sim', 'export'))
    parser.add_argument('--scene', type=Path, default=ROOT/'scenes/amber-components.json')
    parser.add_argument('--boot', action='store_true', help='simulate loading into empty RAM (sim only)')
    parser.add_argument('--binary', type=Path, help='capture an existing exported binary (sim only)')
    args = parser.parse_args()
    if (args.boot or args.binary) and args.action != 'sim':
        parser.error('--boot and --binary require sim')
    try:
        scene=None
        if args.action in ('sim','export') and not args.binary:
            script = ('import {compileScene} from "./scene-model.js"; '
                      'console.log(JSON.stringify(compileScene(await Bun.file(process.argv[1]).json())));')
            scene = json.loads(subprocess.check_output(['bun', '-e', script, str(args.scene.resolve())],
                                                       cwd=ROOT, text=True))
        if args.action == 'export':
            from fpga.backend import export
            print(json.dumps(export(scene),indent=2))
            return 0
        tool_root, directory = stage('sim-boot' if args.boot else args.action)
        if args.action == 'sim':
            from fpga.image import bake, decode
            image=args.binary.read_bytes() if args.binary else bake(scene).to_bytes()
            decode(image)
            (directory/'fpga/simulation.bin').write_bytes(image)
            entry=directory/('raster_boot_capture.py' if args.boot else 'raster_capture.py')
            entry.write_text(entry.read_text()+f'# image: {hashlib.sha256(image).hexdigest()}\n')
            screenshot=ROOT/'fpga/build'/('boot-simulation.png' if args.boot else 'simulation.png')
            command = ['fpgatool', 'sim', str(entry),
                       '--no-open', '--frames', '1',
                       '--screenshot', str(screenshot)]
        elif args.action == 'build':
            command = ['fpgatool', 'build', str(directory/'raster_rom.py'), '--comb']
        else:
            read_timing(tool_root/'build/basys3/raster_rom/pipelinec/top/open_tools_final.log')
            verify_data_lanes(tool_root/'build/basys3/raster_rom/pipelinec/top/top.json')
            command = ['fpgatool', args.action,
                       str(tool_root/'build/basys3/raster_rom/raster_rom.bit')]
        subprocess.run(command, check=True)
        if args.action == 'sim':
            from fpga.verify_capture import compare
            print(compare(directory/'fpga/simulation.bin', screenshot))
        if args.action == 'build':
            report=tool_root/'build/basys3/raster_rom/pipelinec/top/open_tools_final.log'
            read_timing(report)
            print(verify_data_lanes(report.parent/'top.json'))
            destination = ROOT/'fpga/build'
            destination.mkdir(exist_ok=True)
            shutil.copy2(tool_root/'build/basys3/raster_rom/raster_rom.bit', destination/'raster_rom.bit')
            shutil.copy2(report,destination/'timing.log')
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
