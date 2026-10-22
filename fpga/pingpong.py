# pyright: reportInvalidTypeForm=none
"""Two linear X buffers: produce Y=n+1 while displaying X=n.

The producer supplies increasing (exclusive endpoint, layer) records; WIDTH
terminates a job. Only this controller owns RAM addresses and publication.
The last write gets a separate commit clock before the buffer can be claimed.
"""
from pypeline import *
from fpga.format import HEIGHT, WIDTH
from fpga.loader import load_t
from vga.types import vga_timing_signals_t

BUFFER_CAPACITY = 2048
HANDOFF_X = WIDTH + 8


@struct
class y_job_t(NamedTuple):
    start: uint1_t
    cancel: uint1_t
    row: uint11_t
    epoch: uint2_t


@struct
class y_result_t(NamedTuple):
    valid: uint1_t
    end_x: uint11_t
    layer: uint6_t
    row: uint11_t
    epoch: uint2_t
    error: uint1_t


@struct
class buffers_t(NamedTuple):
    job: y_job_t
    load: load_t
    deadline: uint1_t
    invalid: uint1_t
    busy: uint1_t
    front: uint1_t
    count: uint12_t


@hw_func
def schedule(sig: vga_timing_signals_t, enabled: uint1_t,
             produced: y_result_t) -> buffers_t:
    valid_even: Reg[uint1_t] = 0
    valid_odd: Reg[uint1_t] = 0
    row_even: Reg[uint11_t] = 0
    row_odd: Reg[uint11_t] = 0
    epoch: Reg[uint2_t] = 0
    active: Reg[uint1_t] = 0
    committing: Reg[uint1_t] = 0
    job_row: Reg[uint11_t] = 0
    count: Reg[uint12_t] = 0
    previous_end: Reg[uint11_t] = 0
    rendering: Reg[uint1_t] = 0
    armed: Reg[uint1_t] = 0
    failed: Reg[uint1_t] = 0
    deadline: Reg[uint1_t] = 0
    invalid: Reg[uint1_t] = 0
    front: Reg[uint1_t] = 0

    # Capture readiness before any commit in this cycle. A same-cycle final
    # write or publication cannot satisfy a handoff deadline.
    even_ready: uint1_t = valid_even
    odd_ready: uint1_t = valid_odd
    start: uint1_t = 0
    cancel: uint1_t = 0
    write: uint1_t = 0
    address: uint16_t = (uint16_t(job_row[0]) << 11) | uint16_t(count)
    word: uint18_t = (uint18_t(produced.end_x) << 6) | produced.layer
    bootstrap: uint1_t = (sig.pos.x == 0) & (sig.pos.y == HEIGHT)
    handoff: uint1_t = sig.pos.x == HANDOFF_X
    problem: uint1_t = 0

    if not enabled:
        valid_even = 0
        valid_odd = 0
        active = 0
        committing = 0
        rendering = 0
        armed = 0
        failed = 0
        deadline = 0
        invalid = 0
        cancel = 1
    elif bootstrap:
        # Restart in vertical blank, invalidating every previous-frame tag.
        # This also recovers cleanly after a missed deadline.
        valid_even = 0
        valid_odd = 0
        epoch = epoch + 1
        active = 1
        committing = 0
        job_row = 0
        count = 0
        previous_end = 0
        rendering = 0
        armed = 1
        failed = 0
        start = 1
        cancel = 1
    elif armed & (~failed):
        if active:
            if committing:
                # The run RAM accepted the final write on the preceding
                # edge. Publication is deliberately a separate operation.
                if job_row[0]:
                    valid_odd = 1
                    row_odd = job_row
                else:
                    valid_even = 1
                    row_even = job_row
                active = 0
                committing = 0
                if produced.valid | produced.error:
                    problem = 1
            elif produced.error:
                problem = 1
            elif produced.valid:
                if ((produced.row != job_row) | (produced.epoch != epoch) |
                        (produced.end_x <= previous_end) | (produced.end_x > WIDTH) |
                        (count >= BUFFER_CAPACITY)):
                    problem = 1
                else:
                    write = 1
                    count = count + 1
                    previous_end = produced.end_x
                    if produced.end_x == WIDTH:
                        committing = 1

        if handoff:
            wanted: uint11_t = sig.pos.y + 1
            claim: uint1_t = sig.pos.y < (HEIGHT-1)
            if sig.pos.y == 1124:
                wanted = 0
                claim = 1
            elif sig.pos.y == (HEIGHT-1):
                rendering = 0
            if claim:
                available: uint1_t = even_ready & (row_even == wanted)
                if wanted[0]:
                    available = odd_ready & (row_odd == wanted)
                if not available:
                    deadline = 1
                    failed = 1
                else:
                    front = wanted[0]
                    rendering = 1
                    if wanted[0]:
                        valid_odd = 0
                    else:
                        valid_even = 0
                    if wanted < (HEIGHT-1):
                        # Old scanout reads were flushed eight clocks ago.
                        # The opposite buffer is now exclusively writable.
                        job_row = wanted + 1
                        active = 1
                        committing = 0
                        count = 0
                        previous_end = 0
                        start = 1

        if problem:
            invalid = 1
            failed = 1
        if failed:
            # Keep sync running, blank the rest of this frame, and retry at
            # vertical blank. Never reuse stale or partially generated data.
            rendering = 0
            active = 0
            committing = 0
            valid_even = 0
            valid_odd = 0
            write = 0
            start = 0
            cancel = 1

    return buffers_t(job=y_job_t(start=start, cancel=cancel, row=job_row, epoch=epoch),
        load=load_t(request=0, address=0, ready=rendering, error=0,
                    run_count=4096, palette_write=0, row_write=0,
                    run_write=write, index=address, data=word),
        deadline=deadline, invalid=invalid, busy=active, front=front, count=count)
