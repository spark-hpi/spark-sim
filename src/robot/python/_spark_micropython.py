# `micropython` module for the simulator. native/viper/asm_thumb decorators are accepted but run as normal
# bytecode (WebAssembly has no native emitter), so such functions run slower than on the robot.
import _spark_rt as _rt


def const(x):
    return x


def native(f):
    return f


viper = native
asm_thumb = native


def schedule(f, arg):
    # MicroPython's own scheduler (queue of 4 like on the rp2, RuntimeError when full): runs f(arg) soon,
    # between two bytecodes of the main program, as robot code
    _rt._cmp.schedule(_rt.call_scheduled, (f, arg))


def opt_level(level=None):
    return 0 if level is None else None


def alloc_emergency_exception_buf(size):
    pass


def mem_info(verbose=False):
    import gc

    print("mem: total %d, current %d" % (gc.mem_alloc() + gc.mem_free(), gc.mem_alloc()))


def qstr_info(verbose=False):
    pass


def stack_use():
    return 0


def heap_lock():
    return 0


def heap_unlock():
    return 0


def kbd_intr(chr):
    pass
