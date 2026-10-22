"""Python-backend entry point for exporting and programming fixed-address assets."""
from __future__ import annotations

import argparse
import json
import os
import signal
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from fpga.format import FLASH_BASE
from fpga.image import bake

OUTPUT = Path(__file__).resolve().parent/'build'


def run_programmer(command):
    # fpgatool starts openFPGALoader as a child. A timeout must stop both before
    # the API permits another upload to use the same cable/flash.
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, start_new_session=True)
    try:
        stdout, stderr = child.communicate(timeout=180)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.communicate()
        raise
    return subprocess.CompletedProcess(command, child.returncode, stdout, stderr)


def export(scene, directory=OUTPUT, *, engine='baked'):
    if engine == 'scene':
        from fpga.scene_compile import compile_scene
        image = compile_scene(scene)
    elif engine == 'baked':
        image = bake(scene)
    else:
        raise ValueError('Unknown FPGA engine')
    data = image.to_bytes()
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    # Unique exports also make simultaneous requests and retained failure files safe.
    fd, filename = tempfile.mkstemp(prefix='y-programs-' if engine == 'scene' else 'x-programs-', suffix='.bin', dir=directory)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
    result = dict(path=filename, filename=Path(filename).name, bytes=len(data), flashAddress=FLASH_BASE)
    if engine == 'scene':
        result.update(engine=engine, **image.metrics)
    else:
        result['runs'] = len(image.runs)
    return result


def program(scene, directory=OUTPUT, *, engine='baked'):
    result = export(scene, directory, engine=engine)
    command = ['fpgatool', 'program-data', result['path'], '--board', 'basys3',
               '--offset', hex(FLASH_BASE)]
    try:
        completed = run_programmer(command)
    except FileNotFoundError:
        return dict(**result, ok=False, error='fpgatool is not available on the server PATH')
    except subprocess.TimeoutExpired:
        return dict(**result, ok=False, error='FPGA upload timed out after 180 seconds')
    log = (completed.stdout+'\n'+completed.stderr).strip()
    return dict(**result, ok=completed.returncode == 0, log=log[-12000:],
                error=None if completed.returncode == 0 else
                f'fpgatool program-data exited with status {completed.returncode}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('export', 'program'))
    parser.add_argument('--scene', type=Path, help='Compiled scene JSON; stdin if omitted')
    parser.add_argument('--engine', choices=('baked', 'scene'), default='baked')
    args = parser.parse_args()
    try:
        scene = json.loads(args.scene.read_text()) if args.scene else json.load(sys.stdin)['scene']
        result = program(scene, engine=args.engine) if args.action == 'program' else dict(**export(scene, engine=args.engine), ok=True)
        print(json.dumps(result))
    except (ValueError, KeyError, TypeError) as error:
        print(json.dumps(dict(ok=False, error=str(error))))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
