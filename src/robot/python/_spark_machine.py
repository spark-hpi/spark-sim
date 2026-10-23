# Simulated `machine` module. Pins and buses exist so that code imports and runs; only what the Zumo library
# needs is backed by the simulation. Shop parts on I2C are not simulated yet (they answer ENODEV).
import _spark_rt as _rt


class Pin:
    IN = 0
    OUT = 1
    OPEN_DRAIN = 2
    ALT = 3
    PULL_UP = 1
    PULL_DOWN = 2
    IRQ_FALLING = 4
    IRQ_RISING = 8

    def __init__(self, id=None, mode=-1, pull=-1, *, value=None, alt=-1):
        self._id = id
        # nothing is connected in the simulator: an input with a pull-up reads 1, otherwise 0
        self._v = (1 if value else 0) if value is not None else (1 if pull == Pin.PULL_UP else 0)

    def init(self, mode=-1, pull=-1, *, value=None, alt=-1):
        if value is not None:
            self._v = 1 if value else 0
        elif pull == Pin.PULL_UP:
            self._v = 1
        elif pull == Pin.PULL_DOWN:
            self._v = 0

    def value(self, v=None):
        if v is None:
            return self._v
        self._v = 1 if v else 0

    def __call__(self, v=None):
        return self.value(v)

    def on(self):
        self._v = 1

    def off(self):
        self._v = 0

    high = on
    low = off

    def toggle(self):
        self._v ^= 1

    def irq(self, handler=None, trigger=0, hard=False):
        return None


class PWM:
    def __init__(self, pin, *, freq=1000, duty_u16=0, duty_ns=0, invert=False):
        self._f = freq
        self._d = duty_u16

    def init(self, *, freq=None, duty_u16=None, duty_ns=None):
        if freq is not None:
            self._f = freq
        if duty_u16 is not None:
            self._d = duty_u16

    def freq(self, f=None):
        if f is None:
            return self._f
        self._f = f

    def duty_u16(self, d=None):
        if d is None:
            return self._d
        self._d = d

    def duty_ns(self, d=None):
        return 0 if d is None else None

    def deinit(self):
        pass


class ADC:
    CORE_TEMP = 4

    def __init__(self, pin):
        self._pin = pin

    def read_u16(self):
        # GP26 = battery / 11 (only meaningful pin on the Zumo)
        if getattr(self._pin, "_id", self._pin) == 26:
            mv = _rt.rpc(_rt.OP_BAT)[1]
            return min(65535, int(mv / 11 / 3300 * 65536))
        return 0


class I2C:
    def __init__(self, id=0, *, scl=None, sda=None, freq=400000, timeout=50000):
        pass

    def init(self, *a, **k):
        pass

    def deinit(self):
        pass

    def scan(self):
        return [0x1E, 0x6B]  # LIS3MDL and LSM6DSO on the Zumo main board

    def _nodev(self, *a, **k):
        _rt.charge(100)
        raise OSError(19)  # ENODEV: I2C devices are not simulated at register level yet

    readfrom = readfrom_into = writeto = writevto = readfrom_mem = readfrom_mem_into = writeto_mem = _nodev
    start = stop = readinto = write = _nodev


SoftI2C = I2C


class SPI:
    MSB = 0
    LSB = 1

    def __init__(self, *a, **k):
        pass

    def init(self, *a, **k):
        pass

    def deinit(self):
        pass

    def write(self, buf):
        _rt.charge(len(buf) // 2 + 5)

    def read(self, n, write=0):
        return bytes(n)

    def readinto(self, buf, write=0):
        pass

    def write_readinto(self, wbuf, rbuf):
        pass


SoftSPI = SPI


class UART:
    def __init__(self, *a, **k):
        pass

    def init(self, *a, **k):
        pass

    def deinit(self):
        pass

    def any(self):
        return 0

    def read(self, n=-1):
        return None

    def readline(self):
        return None

    def readinto(self, buf, n=-1):
        return None

    def write(self, buf):
        return len(buf)


class Timer:
    ONE_SHOT = 0
    PERIODIC = 1

    def __init__(self, id=-1, **kwargs):
        self._t = None
        if kwargs:
            self.init(**kwargs)

    def init(self, *, mode=PERIODIC, freq=-1, period=-1, tick_hz=1000, callback=None):
        self.deinit()
        if freq > 0:
            period_us = 1000000 / freq
        else:
            period_us = max(1, period) * 1000000 / tick_hz
        self._t = [_rt.now_us() + period_us, period_us if mode == self.PERIODIC else 0, callback, self]
        _rt.timers.append(self._t)
        _rt._arm()

    def deinit(self):
        if self._t in _rt.timers:
            _rt.timers.remove(self._t)
            _rt._arm()
        self._t = None


class RTC:
    def __init__(self, *a):
        pass

    def datetime(self, dt=None):
        import time

        t = time.localtime()
        return (t[0], t[1], t[2], t[6], t[3], t[4], t[5], 0)


class WDT:
    def __init__(self, id=0, timeout=5000):
        pass

    def feed(self):
        pass


class _Mem:
    def __getitem__(self, a):
        return 0

    def __setitem__(self, a, v):
        pass


mem8 = mem16 = mem32 = _Mem()


def freq(hz=None):
    return 125000000


def unique_id():
    return b"SPARKSIM"


def reset():
    raise SystemExit


soft_reset = reset


def bootloader():
    raise SystemExit


def idle():
    _rt.charge(10)
    _rt.fire_due()


def lightsleep(ms=None):
    import time

    time.sleep_ms(ms or 0)


deepsleep = lightsleep


def disable_irq():
    _rt._in_irq[0] = True
    return 0


def enable_irq(state=0):
    _rt._in_irq[0] = False


def time_pulse_us(pin, level, timeout_us=1000000):
    return -1
