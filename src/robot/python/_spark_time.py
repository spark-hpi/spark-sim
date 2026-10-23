# Simulated `time` module: the same functions as MicroPython's time on the RP2040, on the simulated clock.
# On the robot these are C functions that take about a microsecond; their Python bodies here are therefore
# "untimed" (the call itself is counted in the caller's bytecode). Due timer callbacks are user code and run
# outside the untimed part.
import _spark
import _spark_rt as _rt

_PERIOD = 1 << 30
_MASK = _PERIOD - 1
_HALF = _PERIOD >> 1


def _int(x):
    # like mp_obj_get_int on the robot: ints (and bools) only
    if type(x) is not int and type(x) is not bool:
        raise TypeError("can't convert %s to int" % type(x).__name__)
    return x


def _now():
    # inside an untimed section; due timer callbacks run as robot code (see _spark_rt.call_timed)
    if _rt.timers:
        _rt.flush()
    return _spark.now()


def sleep_us(us):
    _spark.untimed(1)
    try:
        end = _now() + _int(us)
    finally:
        _spark.untimed(0)
    if us > 0:
        _rt.sleep_until(end)


def sleep_ms(ms):
    _spark.untimed(1)
    try:
        end = _now() + _int(ms) * 1000
    finally:
        _spark.untimed(0)
    if ms > 0:
        _rt.sleep_until(end)


def sleep(seconds):
    # time.sleep accepts floats (seconds)
    if type(seconds) is not int and type(seconds) is not float and type(seconds) is not bool:
        raise TypeError("can't convert %s to float" % type(seconds).__name__)
    if seconds > 0:
        _spark.untimed(1)
        try:
            end = _now() + seconds * 1000000
        finally:
            _spark.untimed(0)
        _rt.sleep_until(end)


def ticks_us():
    _spark.untimed(1)
    try:
        return int(_now()) & _MASK
    finally:
        _spark.untimed(0)


def ticks_ms():
    _spark.untimed(1)
    try:
        return int(_now() // 1000) & _MASK
    finally:
        _spark.untimed(0)


def ticks_cpu():
    return ticks_us()


# C functions on the robot: native here, with the robot's argument checks
ticks_add = _spark.ticks_add
ticks_diff = _spark.ticks_diff


def time():
    _spark.untimed(1)
    try:
        return int(_now() // 1000000)
    finally:
        _spark.untimed(0)


def time_ns():
    _spark.untimed(1)
    try:
        return int(_now() * 1000)
    finally:
        _spark.untimed(0)


def localtime(secs=None):
    if secs is None:
        secs = time()
    s = int(secs)
    return (2026, 1, 1 + s // 86400 % 28, s // 3600 % 24, s // 60 % 60, s % 60, 3, 1)


gmtime = localtime


def mktime(t):
    return ((t[2] - 1) * 86400) + t[3] * 3600 + t[4] * 60 + t[5]
