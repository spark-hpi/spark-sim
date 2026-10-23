# SPARK runtime for robot programs in the simulator. Imported before main.py. It replaces the hardware modules
# (time, machine, rp2, micropython) with versions that run on the simulated clock. CPU time is counted per
# executed bytecode by the VM (custom MicroPython build); sleeping, sensors and motors go through the world.
import sys
import _spark
import _spark_irq  # the simulator's timer interrupt (custom MicroPython build)
import micropython as _cmp  # the real C module: its scheduler runs callbacks between bytecodes, like on the robot

OP_SYNC = 1
OP_SLEEP = 2
OP_MOTORS = 3
OP_LINE = 4
OP_PROX = 5
OP_IMU = 6
OP_ENC = 7
OP_BAT = 8

# Timers: [due_us, period_us (0 = one shot), callback, timer_object]
timers = []
_in_irq = [False]
_NEVER = 1e18


def _arm():
    """Tell the clock when the next timer is due: the VM then schedules _irq like a hardware interrupt."""
    _spark.irq_at(min(t[0] for t in timers) if timers else _NEVER)


def flush():
    """At every contact with the clock or the world: run due timer callbacks (like interrupts)."""
    if timers and not _in_irq[0]:
        fire_due()


def rpc(op, *args):
    flush()
    return _spark.rpc(op, *args)


def now_us():
    flush()
    return _spark.now()


def charge(us):
    _spark.charge(us)


def _report(e):
    # like MicroPython's scheduler: print the error, the main program goes on
    try:
        print("Uncaught exception in timer callback")
        print(_clean_traceback(e))
    except BaseException:
        pass


def call_timed(f, arg):
    """Run a callback as robot code: it costs robot time even when it fires inside the library."""
    depth = _spark.untimed_save()
    try:
        f(arg)
    except Exception as e:
        _report(e)
    finally:
        _spark.untimed_restore(depth)


def call_scheduled(pair):
    call_timed(pair[0], pair[1])


def fire_due():
    """Run the timer callbacks that are due now."""
    if _in_irq[0]:
        return
    _in_irq[0] = True
    try:
        now = _spark.now()
        while timers:
            t = min(timers, key=lambda x: x[0])
            if t[0] > now:
                break
            if t[1] > 0:
                t[0] += t[1]
            else:
                timers.remove(t)
            call_timed(t[2], t[3])
            now = _spark.now()
    finally:
        _in_irq[0] = False
        _arm()


def _irq(_):
    fire_due()


_spark_irq.set(_irq)


def sleep_until(end):
    """Sleep until `end` (µs), running timer callbacks at their due times. On the robot sleeping is C code: the
    bookkeeping here costs no robot time; timer callbacks (user code) do."""
    while True:
        if timers:
            flush()
        _spark.untimed(1)
        try:
            now = _spark.now()
            if now >= end:
                return
            due = end
            if timers and not _in_irq[0]:
                due = min(due, min(t[0] for t in timers))
            if due > now:
                _spark.rpc(OP_SLEEP, due - now)
        finally:
            _spark.untimed(0)


import _spark_time  # noqa: E402
import _spark_machine  # noqa: E402
import _spark_rp2  # noqa: E402
import _spark_micropython  # noqa: E402

sys.modules["time"] = _spark_time
sys.modules["utime"] = _spark_time
sys.modules["machine"] = _spark_machine
sys.modules["rp2"] = _spark_rp2
sys.modules["micropython"] = _spark_micropython
# Browser modules do not exist on the robot
for _name in ("js", "pyscript", "jsffi"):
    sys.modules[_name] = None


def _clean_traceback(e):
    """MicroPython traceback without the simulator's own frames."""
    import io

    buf = io.StringIO()
    sys.print_exception(e, buf)
    lines = [ln for ln in buf.getvalue().split("\n") if ln and "/lib/" not in ln]
    return "\n".join(lines)


def _error(e):
    """Show an error like the Pololu firmware (console and display). Must not raise, even without memory."""
    try:
        print(_clean_traceback(e))
    except BaseException:
        try:
            print(type(e).__name__)
        except BaseException:
            pass
    try:
        from zumo_2040_robot.robot import Display

        Display.show_exception(e)
    except BaseException:
        pass
    try:
        return "%s: %s" % (type(e).__name__, e)
    except BaseException:
        return "error"


def run(src, seed):
    import zumo_2040_robot.robot  # noqa: F401 - keeps its own reference to _spark
    import random
    import gc

    random.seed(seed)
    sys.modules.pop("_spark", None)  # user code should not see the simulator interface
    g = {"__name__": "__main__"}
    err = None
    try:
        try:
            exec(compile(src, "main.py", "exec"), g)
        except SystemExit:
            pass
        except MemoryError as e:
            g.clear()  # free the program's data first, so the error can be reported
            gc.collect()
            err = _error(e)
        except BaseException as e:  # like the Pololu firmware: show the error
            err = _error(e)
        timers.clear()
        _arm()
    except BaseException:  # nothing may escape into JavaScript
        err = err or "error"
    return err
