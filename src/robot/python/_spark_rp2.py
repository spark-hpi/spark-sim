# Simulated `rp2` module: BOOTSEL (button B) works, the PIO is not simulated.
import _spark


def bootsel_button():
    return _spark.button(1)


class _NoPio:
    def __init__(self, *a, **k):
        raise NotImplementedError("rp2 PIO is not simulated (the Zumo library's PIO use is built into the simulator)")


PIO = StateMachine = DMA = _NoPio


def asm_pio(*a, **k):
    def wrap(f):
        return f

    return wrap
