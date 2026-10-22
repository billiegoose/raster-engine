"""Read FPGA UART diagnostics and compare the failing run with an exported ROM."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import select
import sys
import termios
import time
import tty

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fpga.image import decode

HEADER = b'RXD2'
PACKET_SIZE = 36
REASONS = {0: 'none', 1: 'empty_fifo', 2: 'invalid_run', 3: 'full_fifo'}


def packets(data):
    """Recover complete packets despite an arbitrary UART attachment point."""
    cursor = 0
    while (start := data.find(HEADER, cursor)) >= 0:
        cursor = start+1
        frame = data[start:start+PACKET_SIZE]
        if len(frame) < PACKET_SIZE:
            break
        if frame[34:] != b'\r\n' or frame[4] > 7 or frame[5] not in REASONS:
            continue
        yield dict(ready=bool(frame[4] & 1), load_error=bool(frame[4] & 2),
                   scanout_fault=bool(frame[4] & 4), reason=REASONS[frame[5]],
                   x=int.from_bytes(frame[6:8], 'little'), y=int.from_bytes(frame[8:10], 'little'),
                   row=int.from_bytes(frame[10:12], 'little'), word=int.from_bytes(frame[12:16], 'little'),
                   address=int.from_bytes(frame[16:18], 'little'), previous_end=int.from_bytes(frame[18:20], 'little'),
                   credits=frame[20], palette_writes=int.from_bytes(frame[22:24], 'little'),
                   row_writes=int.from_bytes(frame[24:26], 'little'), run_writes=int.from_bytes(frame[26:30], 'little'),
                   write_checksum=int.from_bytes(frame[30:34], 'little'))
        cursor = start+PACKET_SIZE


def compare(record, image):
    result = dict(record)
    expected_checksum = (sum(image.palette)+sum(image.rows)+sum(image.runs)) & 0xffffffff
    result['expected_write_checksum'] = expected_checksum
    result['write_checksum_matches'] = record['write_checksum'] == expected_checksum
    result['expected_run_writes'] = len(image.runs)
    address = record['address']
    if address < len(image.runs) and record['reason'] in ('invalid_run', 'full_fifo'):
        result['expected_word'] = image.runs[address]
        result['word_matches'] = record['word'] == image.runs[address]
        result['word_xor'] = record['word'] ^ image.runs[address]
        result['decoded_word'] = {'end_x': record['word'] >> 6, 'palette': record['word'] & 63}
        result['expected_decoded_word'] = {'end_x': image.runs[address] >> 6, 'palette': image.runs[address] & 63}
    if record['row'] < len(image.rows):
        result['expected_row_address'] = image.rows[record['row']]
    return result


def read_serial(port, seconds):
    descriptor = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    original = termios.tcgetattr(descriptor)
    try:
        tty.setraw(descriptor)
        attributes = termios.tcgetattr(descriptor)
        attributes[4] = attributes[5] = termios.B115200
        attributes[2] |= termios.CLOCAL | termios.CREAD
        attributes[2] &= ~termios.HUPCL
        termios.tcsetattr(descriptor, termios.TCSANOW, attributes)
        data = bytearray()
        deadline = time.monotonic()+seconds
        while (remaining := deadline-time.monotonic()) > 0:
            if select.select([descriptor], [], [], min(remaining, 0.5))[0]:
                data.extend(os.read(descriptor, 4096))
        return bytes(data)
    finally:
        termios.tcsetattr(descriptor, termios.TCSANOW, original)
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', required=True)
    parser.add_argument('--seconds', type=float, default=3)
    parser.add_argument('--binary', type=Path, default=Path(__file__).with_name('build')/'amber-components.bin')
    parser.add_argument('--output', type=Path, default=Path(__file__).with_name('build')/'uart-diagnostics.json')
    args = parser.parse_args()
    raw = read_serial(args.port, args.seconds)
    records = []
    for record in packets(raw):
        if record not in records:
            records.append(record)
    if not records:
        raise SystemExit(f'No valid diagnostic packets in {len(raw)} UART bytes')
    image = decode(args.binary.read_bytes())
    result = dict(port=args.port, bytes_received=len(raw), records=[compare(record, image) for record in records])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
