"""Use fpgatool's HDL compiler/monitor with a longer capture deadline.

Its CLI allows 90 seconds for VGA acquisition. The larger scene compositor
can take longer to simulate the several frames needed for auto-detection.
This changes only the host wait; the DUT and VGA monitor remain unchanged.
"""
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import threading
import time


def capture(tool_root, source, screenshot, timeout=600):
    sys.path.insert(0, str(tool_root))
    from simulation.compiled import build, read_stream, stop
    binary = build(source, tool_root/'.fpgatool/cache/PipelineC')
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0))
        port = reserve.getsockname()[1]
    env = dict(os.environ, VGA_MONITOR_STREAM=f'127.0.0.1:{port}', VGA_MONITOR_FORMAT='ppm')
    env.pop('FPGATOOL_SIM_CYCLES', None)
    env.pop('VGA_MONITOR_FRAMES', None)
    frames, cancelled = queue.Queue(maxsize=2), threading.Event()
    connection = process = None
    screenshot = Path(screenshot)
    started = time.monotonic()
    try:
        with screenshot.with_suffix('.receiver.log').open('w') as log:
            process = subprocess.Popen([str(binary)], env=env, stdout=log, stderr=log)
            while connection is None:
                try:
                    connection = socket.create_connection(('127.0.0.1', port), timeout=.2)
                    connection.settimeout(None)
                except OSError:
                    if process.poll() is not None or time.monotonic()-started > 10:
                        raise ValueError('HDL monitor failed to start; see '+str(log.name))
                    time.sleep(.02)
            threading.Thread(target=read_stream, args=(connection, frames, cancelled), daemon=True).start()
            print('Acquiring VGA from compiled scene hardware…', flush=True)
            next_progress = started+30
            while time.monotonic()-started < timeout:
                try:
                    item = frames.get(timeout=.2)
                except queue.Empty:
                    if process.poll() is not None:
                        raise ValueError('HDL simulator exited before capture; see '+str(log.name))
                    if time.monotonic() >= next_progress:
                        print(f'HDL acquisition: {int(time.monotonic()-started)} seconds elapsed', flush=True)
                        next_progress += 30
                    continue
                if isinstance(item, Exception):
                    raise ValueError(str(item)) from item
                frame, _ = item
                frame.save(screenshot)
                print(f'Captured {frame.width} × {frame.height}: {screenshot}', flush=True)
                return
            raise ValueError(f'No HDL VGA frame within {timeout} seconds; see {log.name}')
    finally:
        cancelled.set()
        stop(process)
        if connection:
            connection.close()
