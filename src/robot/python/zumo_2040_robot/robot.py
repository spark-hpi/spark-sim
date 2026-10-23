# Simulated Zumo 2040 library. Same API and the same quirks as the original
# (pololu/zumo-2040-robot, MIT licence, Copyright (c) 2023 Pololu Corporation); hardware access goes to the
# simulated world. Logic that does not depend on hardware (button debouncing, calibration, music parser, HSV)
# is taken from the original so that it behaves exactly the same.
import _spark_rt as _rt  # first: replaces time/machine with the simulator versions
import _spark
import framebuf
from array import array
from time import ticks_us, ticks_diff, sleep_ms

MAX_SPEED = 6000


def _untimed(f):
    """Library internals whose duration the world already models (viper code / PIO / bus transfers on the robot)."""

    def wrapper(*args, **kwargs):
        _spark.untimed(1)
        try:
            return f(*args, **kwargs)
        finally:
            _spark.untimed(0)

    return wrapper


# ---------------------------------------------------------------- motors
# Both Motors() instances drive the same PWM slice, like the original register writes.
_speeds = [0, 0]


class Motors:
    MAX_SPEED = MAX_SPEED

    def __init__(self):
        # The original re-initialises the PWM with duty 0: creating Motors() stops the motors.
        self._flip_left_motor = False
        self._flip_right_motor = False
        self.off()

    def flip_left(self, flip):
        self._flip_left_motor = flip

    def flip_right(self, flip):
        self._flip_right_motor = flip

    @staticmethod
    def _dir(speed, flip):
        speed = round(speed)
        if speed < -MAX_SPEED:
            speed = -MAX_SPEED
        elif speed > MAX_SPEED:
            speed = MAX_SPEED
        return -speed if flip else speed

    def set_speeds(self, left, right):
        _speeds[0] = self._dir(left, self._flip_left_motor)
        _speeds[1] = self._dir(right, self._flip_right_motor)
        _rt.rpc(_rt.OP_MOTORS, _speeds[0], _speeds[1])

    def set_left_speed(self, speed):
        _speeds[0] = self._dir(speed, self._flip_left_motor)
        _rt.rpc(_rt.OP_MOTORS, _speeds[0], _speeds[1])

    def set_right_speed(self, speed):
        _speeds[1] = self._dir(speed, self._flip_right_motor)
        _rt.rpc(_rt.OP_MOTORS, _speeds[0], _speeds[1])

    def off(self):
        self.set_speeds(0, 0)


# ---------------------------------------------------------------- line sensors
SENSOR_COUNT = 5
TIMEOUT = 1024
_line_data = array("H", [TIMEOUT] * 5)  # the original returns the same array from every read()


class LineSensors:
    def __init__(self):
        self._emitters = True
        self.reset_calibration()

    def reset_calibration(self):
        self.cal_min = array("H", [1025] * 5)
        self.cal_max = array("H", [0] * 5)

    def calibrate(self):
        tmp_min = array("H", [1025] * 5)
        tmp_max = array("H", [0] * 5)
        for trials in range(10):
            data = self.read()
            for i in range(5):
                tmp_min[i] = min(data[i], tmp_min[i])
                tmp_max[i] = max(data[i], tmp_max[i])
        for i in range(5):
            self.cal_max[i] = max(tmp_min[i], self.cal_max[i])
            self.cal_min[i] = min(tmp_max[i], self.cal_min[i])

    def start_read(self, emitters_on=True):
        self._emitters = emitters_on

    @_untimed
    def read(self):
        # The PIO program always counts the full 1023 µs window: a read takes ~1.06 ms on any surface.
        r = _rt.rpc(_rt.OP_LINE, 1 if self._emitters else 0)
        for i in range(5):
            _line_data[i] = int(r[1 + i])
        self._emitters = True
        return _line_data

    @_untimed
    def read_calibrated(self):
        d = self.read()
        cal_min = self.cal_min
        cal_max = self.cal_max
        for i in range(5):
            if cal_min[i] >= cal_max[i] or d[i] < cal_min[i]:
                d[i] = 0
            elif d[i] > cal_max[i]:
                d[i] = 1000
            else:
                d[i] = (d[i] - cal_min[i]) * 1000 // (cal_max[i] - cal_min[i])
        return d


# ---------------------------------------------------------------- proximity sensors
DEFAULT_FREQ = 56000
DEFAULT_BRIGHTNESS_LEVELS = [313, 1000, 2063, 3500, 5375, 7563]


class ProximitySensors:
    def __init__(self):
        self.brightness_levels = DEFAULT_BRIGHTNESS_LEVELS
        self.counts = [array("B", [0, 0]) for _ in range(3)]
        self.set_frequency(DEFAULT_FREQ)

    def set_frequency(self, freq):
        self._freq = freq
        self.pulse_on_time_us = 14 * 1000000 // freq
        self.pulse_off_time_us = 18 * 1000000 // freq

    @_untimed
    def read(self):
        # Levels and pulse times are sent along, so changing brightness_levels behaves like on the robot
        levels = list(self.brightness_levels)[:8]
        r = _rt.rpc(_rt.OP_PROX, self._freq, self.pulse_on_time_us, self.pulse_off_time_us, len(levels), *levels)
        self.counts = [
            array("B", [int(r[1]), int(r[2])]),
            array("B", [int(r[3]), int(r[4])]),
            array("B", [int(r[5]), int(r[6])]),
        ]

    def counts_with_left_leds(self, sensor_number):
        return self.counts[sensor_number][0]

    def counts_with_right_leds(self, sensor_number):
        return self.counts[sensor_number][1]

    def left_counts_with_left_leds(self):
        return self.counts_with_left_leds(0)

    def left_counts_with_right_leds(self):
        return self.counts_with_right_leds(0)

    def front_counts_with_left_leds(self):
        return self.counts_with_left_leds(1)

    def front_counts_with_right_leds(self):
        return self.counts_with_right_leds(1)

    def right_counts_with_left_leds(self):
        return self.counts_with_left_leds(2)

    def right_counts_with_right_leds(self):
        return self.counts_with_right_leds(2)

    def total_counts(self):
        return sum(self.counts[0]) + sum(self.counts[1]) + sum(self.counts[2])

    def angle_estimate(self):
        l = sum(self.counts[0])
        fl = self.counts[1][0]
        fr = self.counts[1][1]
        r = sum(self.counts[2])
        if l + fl + fr + r == 0:
            return 0
        return (-90 * l - 20 * fl + 20 * fr + 90 * r) // (l + fl + fr + r)


# ---------------------------------------------------------------- encoders, battery
class Encoders:
    def __init__(self):
        self._flip_sign = 1
        self.left_offset = 0
        self.right_offset = 0
        self.get_counts(reset=True)

    def flip(self, flip):
        self._flip_sign = -1 if flip else 1

    @_untimed
    def get_counts(self, reset=False):
        r = _rt.rpc(_rt.OP_ENC)
        left = int(r[1]) - self.left_offset
        right = int(r[2]) - self.right_offset
        if reset:
            self.left_offset += left
            self.right_offset += right
        return left * self._flip_sign, right * self._flip_sign


class Battery:
    @_untimed
    def get_level_millivolts(self):
        return int(_rt.rpc(_rt.OP_BAT)[1])


# ---------------------------------------------------------------- buttons (logic from the original)
class Button:
    _index = 0

    def __init__(self):
        self.last_event = self.is_pressed()
        self.last_event_t = ticks_us()
        self.not_pressed_t = ticks_us()
        self.debounce_ms = 10
        self.long_press_ms = 750

    def is_pressed(self):
        _rt.flush()
        return _spark.button(self._index) == 1

    def is_long_pressed(self):
        if not self.is_pressed():
            self.not_pressed_t = ticks_us()
        elif self.not_pressed_t is not None:
            if ticks_diff(ticks_us(), self.not_pressed_t) > self.long_press_ms * 1000:
                self.not_pressed_t = None
        return self.not_pressed_t is None

    def check(self):
        if self.last_event_t is not None:
            if ticks_diff(ticks_us(), self.last_event_t) > self.debounce_ms * 1000:
                self.last_event_t = None
        if self.last_event_t is None:
            s = self.is_pressed()
            if s != self.last_event:
                self.last_event = s
                self.last_event_t = ticks_us()
                return s


class ButtonA(Button):
    _index = 0


class ButtonB(Button):
    _index = 1


class ButtonC(Button):
    _index = 2


# ---------------------------------------------------------------- OLED 128 x 64 (SH1106)
# The display is mounted rotated by 180°: like the original (rotate=180), flip_en = True is upright.
_display_state = {"on": True, "inverted": False, "flip_en": True}


class Display(framebuf.FrameBuffer):
    def __init__(self):
        self.width = 128
        self.height = 64
        self.bufsize = 1024
        self.buffer = bytearray(1024)
        super().__init__(self.buffer, 128, 64, framebuf.MONO_VLSB)
        # the original's init_display(): reset the controller (on, not inverted, upright), clear and show
        _display_state.update(on=True, inverted=False, flip_en=True)
        self.fill(0)
        self.show()

    def _send(self):
        s = _display_state
        _spark.show(self.buffer.hex() if s["on"] else "", 1 if s["inverted"] else 0, 0 if s["flip_en"] else 1)

    @_untimed
    def show(self, full_update=False):
        _rt.charge(4000)  # SPI transfer of 8 pages (EST)
        self._send()

    def poweroff(self):
        _display_state["on"] = False
        self._send()

    def poweron(self):
        _display_state["on"] = True
        self._send()

    def sleep(self, value):
        _display_state["on"] = not value
        self._send()

    def contrast(self, contrast):
        pass

    def invert(self, invert):
        _display_state["inverted"] = bool(invert)
        self._send()

    def flip(self, flag=None, update=True):
        # flip(True) is the normal orientation, flip(False) upside down, flip() toggles (as in the original)
        if flag is None:
            flag = not _display_state["flip_en"]
        _display_state["flip_en"] = bool(flag)
        if update:
            self.show()

    def load_pbm(self, filename):
        with open(filename, "rb") as f:
            f.readline()
            f.readline()
            f.readline()
            data = bytearray(f.read())
        return framebuf.FrameBuffer(data, 128, 64, framebuf.MONO_HLSB)

    def save_pbm(self, filename):
        buf = bytearray(self.bufsize)
        data = framebuf.FrameBuffer(buf, self.width, self.height, framebuf.MONO_HLSB)
        data.blit(self, 0, 0)
        with open(filename, "wb") as f:
            f.write("P4\n128 64\n")
            f.write(data)

    def exception(self, e):
        self.text(type(e).__name__ + ":", 0, 0, 1)
        msg = str(e)
        for i in range(5):
            self.text(msg[i * 16 : (i + 1) * 16], 0, 12 + i * 10, 1)

    @staticmethod
    def show_exception(e):
        d = Display()
        d.fill(0)
        d.exception(e)
        d.show()


# ---------------------------------------------------------------- LEDs (logic from the original)
class RGBLEDs:
    def __init__(self, led_count=6):
        self._led_count = led_count
        self.data = bytearray(4 + led_count * 4 + (led_count + 14) // 16)
        self.set_brightness(31)
        self.off()

    @_untimed
    def show(self):
        _rt.charge(60)
        _spark.leds(self.data.hex())

    def set_brightness(self, value, led=None):
        if led is not None:
            self.data[4 + led * 4] = 0xE0 | (round(value) & 0x1F)
        else:
            for l in range(self._led_count):
                self.set_brightness(value, led=l)

    def get_brightness(self, led=0):
        return self.data[4 + led * 4] & 0x1F

    def set(self, led, rgb):
        self.data[4 + led * 4 + 1] = round(rgb[2])
        self.data[4 + led * 4 + 2] = round(rgb[1])
        self.data[4 + led * 4 + 3] = round(rgb[0])

    def get(self, led):
        return [self.data[4 + led * 4 + 3], self.data[4 + led * 4 + 2], self.data[4 + led * 4 + 1]]

    def set_hsv(self, led, hsv, h_scale=360):
        self.set(led, self.hsv2rgb(hsv[0], hsv[1], hsv[2], h_scale=h_scale))

    def hsv2rgb(self, h, s, v, h_scale=360):
        sixth = (h_scale + 3) // 6
        if s == 0:
            return [v, v, v]
        h = h % h_scale
        region = h // sixth
        remainder = (h - (region * sixth)) * 6
        p = (v * (255 - s)) // 255
        q = (v * (255 - ((s * remainder) // h_scale))) // 255
        t = (v * (255 - ((s * (h_scale - remainder)) // h_scale))) // 255
        if region == 0:
            return [v, t, p]
        elif region == 1:
            return [q, v, p]
        elif region == 2:
            return [p, v, t]
        elif region == 3:
            return [p, q, v]
        elif region == 4:
            return [t, p, v]
        return [v, p, q]

    def off(self):
        for led in range(self._led_count):
            self.set(led, [0, 0, 0])
        self.show()


class YellowLED:
    def __init__(self):
        self.off()

    def on(self):
        _spark.yellow(1)

    def off(self):
        _spark.yellow(0)

    def value(self, value):
        _spark.yellow(1 if value else 0)

    def __call__(self, value):
        if value:
            self.on()
        else:
            self.off()


# ---------------------------------------------------------------- buzzer (music parser from the original)
volume_levels = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 64, 128]
_play_end = [0]
_melody = [None]  # (start µs, frequencies, durations ms, volumes) of the melody playing in the background


def _send_rest_of_melody():
    """After a beep: the original's melody timer keeps running, so the rest of the melody goes on."""
    m = _melody[0]
    now = _rt.now_us()
    if m is None or now >= _play_end[0]:
        _spark.buzz("")
        return
    start, freqs, durs, vols = m
    t = start
    rest = []
    for i in range(len(durs)):
        end = t + durs[i] * 1000
        if end > now:
            rest.append("%d:%d:%d" % (freqs[i], max(1, round((end - max(t, now)) / 1000)), vols[i]))
        t = end
    _spark.buzz(",".join(rest))


class _BuzzerPWM:
    """machine.PWM on the buzzer pin (GP7), as the original exposes it as Buzzer.pwm."""

    def __init__(self):
        self._f = 440
        self._d = 0

    def _apply(self):
        _play_end[0] = 0
        _melody[0] = None
        if self._d > 0 and self._f > 0:
            _spark.buzz("%d:-1:%d" % (self._f, min(128, max(1, round(self._d / 32767 * 128)))))
        else:
            _spark.buzz("")

    def freq(self, f=None):
        if f is None:
            return self._f
        self._f = int(f)
        self._apply()

    def duty_u16(self, d=None):
        if d is None:
            return self._d
        self._d = max(0, min(65535, int(d)))
        self._apply()

    def deinit(self):
        self._d = 0
        self._apply()


pwm = _BuzzerPWM()


class Buzzer:
    def __init__(self):
        self.pwm = pwm
        self.off()

    def is_playing(self):
        return _rt.now_us() < _play_end[0]

    def set_callback(self, f):
        pass

    def beep(self):
        _spark.buzz("440:100:128")
        sleep_ms(100)
        _send_rest_of_melody()

    def on(self):
        _play_end[0] = 0
        _spark.buzz("200:-1:128")

    def off(self):
        _play_end[0] = 0
        _melody[0] = None
        _spark.buzz("")

    def play(self, notes):
        try:
            self.play_in_background(notes)
            while self.is_playing():
                sleep_ms(1)
        finally:
            self.off()

    def play_in_background(self, music):
        music = music.lower()
        self.volumes = volumes = []
        self.durations = durations = []
        self.frequencies = frequencies = []
        self.notes = notes = []
        self.beats = beats = []  # units of 1/20160 of a measure, like the original
        elapsed_beats = 0
        x = 0
        octave = 4
        octave_boost = 0
        volume = 15
        staccato = False
        tempo = 120
        default_duration = 4
        music_len = len(music)
        while x < music_len:
            c = music[x]
            x += 1
            num_string = ""
            accidentals = 0
            if x < music_len and (music[x] == "+" or music[x] == "#"):
                accidentals += 1
                x += 1
            elif x < music_len and music[x] == "-":
                accidentals -= 1
                x += 1
            while x < music_len and music[x].isdigit():
                num_string += music[x]
                x += 1
            num = int(num_string) if num_string != "" else 0
            note = octave * 12
            if c in "cdefgab":
                note += (0, 2, 4, 5, 7, 9, 11)["cdefgab".index(c)]
            elif c == "r":
                note = 0
            elif c == ">":
                octave_boost += 1
                continue
            elif c == "<":
                octave_boost -= 1
                continue
            elif c == "t":
                tempo = num
                continue
            elif c == "v":
                volume = min(num, 15)
                continue
            elif c == "o":
                octave = num
                continue
            elif c == "l":
                default_duration = min(num, 2000)
                continue
            elif c == "m":
                staccato = x < music_len and music[x] == "s"
                x += 1
                continue
            elif c == "!":
                octave, volume, staccato, tempo, default_duration, octave_boost = 4, 15, False, 120, 4, 0
                continue
            else:
                continue
            note += octave_boost * 12 + accidentals
            duration_type = num if 0 < num <= 2000 else default_duration
            duration = 60000 / tempo / (duration_type / 4)
            duration_beats = 20160 * 4 // duration_type
            if x < music_len and music[x] == ".":
                duration += duration / 2
                duration_beats += duration_beats // 2
                x += 1
            if note == 0:
                frequencies.append(0)
                volumes.append(0)
                notes.append(0)
            else:
                frequencies.append(round(440 * 2 ** ((note - 57) / 12)))
                volumes.append(volume_levels[volume])
                notes.append(note)
            durations.append(round(duration / 2 if staccato else duration))
            beats.append(elapsed_beats)
            elapsed_beats += duration_beats // 2 if staccato else duration_beats
            if staccato:
                frequencies.append(0)
                durations.append(round(duration / 2))
                volumes.append(0)
                notes.append(0)
                beats.append(elapsed_beats)
                elapsed_beats += duration_beats // 2
            octave_boost = 0
        total = sum(durations)
        _spark.buzz(",".join("%d:%d:%d" % (frequencies[i], durations[i], volumes[i]) for i in range(len(durations))))
        now = _rt.now_us()
        _play_end[0] = now + total * 1000
        _melody[0] = (now, frequencies, durations, volumes)


# ---------------------------------------------------------------- IMU (LSM6DSO + LIS3MDL)
# The world returns all 9 values; each sensor takes its part. A new sample exists every 1/ODR seconds, and
# data_ready() is only true until that sample has been read — exactly what gyro integration loops rely on.
_IMU_ACC = 1
_IMU_GYRO = 2
_IMU_MAG = 4


def _imu_fetch(mask):
    r = _rt.rpc(_rt.OP_IMU, mask)
    return [r[1 + i] for i in range(9)]


def _s16(v):
    v = int(round(v))
    return -32768 if v < -32768 else (32767 if v > 32767 else v)


class _Sensor:
    _rates = ()
    _part = 0
    _mask = 0

    def __init__(self):
        self.last_reading_raw = [0, 0, 0]
        self._odr = 0
        self._last_sample = -1

    def _sample(self):
        return int(_rt.now_us() * self._odr // 1000000) if self._odr else -1

    def set_output_data_rate(self, hz):
        if hz not in self._rates:
            raise ValueError("Invalid output data rate: %s" % hz)
        self._odr = hz

    def data_ready(self):
        _rt.charge(100)  # one I2C register read
        return self._odr > 0 and self._sample() > self._last_sample

    def _read_raw(self, values=None):
        v = values or _imu_fetch(self._mask)
        self._last_sample = self._sample()
        if not self._odr:
            return [0, 0, 0]  # powered down: output registers hold 0
        return [v[self._part + i] for i in range(3)]


class _Acc(_Sensor):
    _rates = (0, 12.5, 26, 52, 104, 208, 416, 833, 1666, 3332, 6664)
    _sens_table = {2: 0.061, 4: 0.122, 8: 0.244, 16: 0.488}
    _part = 0
    _mask = _IMU_ACC

    def __init__(self):
        super().__init__()
        self.last_reading_g = [None, None, None]
        self._sensitivity = 0.061

    def set_full_scale(self, g):
        if g not in self._sens_table:
            raise ValueError("Invalid full scale: %s" % g)
        self._sensitivity = self._sens_table[g]

    def enable_default(self):
        self.set_output_data_rate(52)
        self.set_full_scale(2)

    def axis_to_g(self, axis_raw):
        return axis_raw * self._sensitivity / 1000

    def to_g(self, raw):
        return [self.axis_to_g(a) for a in raw]

    @_untimed
    def read(self, values=None):
        g = self._read_raw(values)
        self.last_reading_raw = [_s16(x * 1000 / self._sensitivity) for x in g]
        for i in range(3):
            self.last_reading_g[i] = self.axis_to_g(self.last_reading_raw[i])


class _Gyro(_Sensor):
    _rates = (0, 12.5, 26, 52, 104, 208, 416, 833, 1666, 3332, 6664)
    _sens_table = {125: 4.375, 250: 8.75, 500: 17.5, 1000: 35, 2000: 70}
    _part = 3
    _mask = _IMU_GYRO

    def __init__(self):
        super().__init__()
        self.last_reading_dps = [None, None, None]
        self._sensitivity = 70

    def set_full_scale(self, dps):
        if dps not in self._sens_table:
            raise ValueError("Invalid full scale: %s" % dps)
        self._sensitivity = self._sens_table[dps]

    def enable_default(self):
        self.set_output_data_rate(208)
        self.set_full_scale(2000)

    def axis_to_dps(self, axis_raw):
        return axis_raw * self._sensitivity / 1000

    def to_dps(self, raw):
        return [self.axis_to_dps(a) for a in raw]

    @_untimed
    def read(self, values=None):
        d = self._read_raw(values)
        self.last_reading_raw = [_s16(x * 1000 / self._sensitivity) for x in d]
        for i in range(3):
            self.last_reading_dps[i] = self.axis_to_dps(self.last_reading_raw[i])


class _Mag(_Sensor):
    _rates = (0.625, 1.25, 2.5, 5, 10, 20, 40, 80)
    _sens_table = {4: 6842, 8: 3421, 12: 2281, 16: 1711}
    _part = 6
    _mask = _IMU_MAG

    def __init__(self):
        super().__init__()
        self.last_reading_gauss = [None, None, None]
        self._sensitivity = 6842

    def detect(self):
        return True

    def reset(self):
        self._odr = 0

    def set_full_scale(self, gauss):
        if gauss not in self._sens_table:
            raise ValueError("Invalid full scale: %s" % gauss)
        self._sensitivity = self._sens_table[gauss]

    def enable_default(self):
        self.set_output_data_rate(10)
        self.set_full_scale(4)

    def axis_to_gauss(self, axis_raw):
        return axis_raw / self._sensitivity

    def to_gauss(self, raw):
        return [self.axis_to_gauss(a) for a in raw]

    @_untimed
    def read(self, values=None):
        m = self._read_raw(values)
        self.last_reading_raw = [_s16(x * self._sensitivity) for x in m]
        for i in range(3):
            self.last_reading_gauss[i] = self.axis_to_gauss(self.last_reading_raw[i])


class IMU:
    def __init__(self, i2c=None):
        self.acc = _Acc()
        self.gyro = _Gyro()
        self.mag = _Mag()

    def detect(self):
        return True

    def reset(self):
        self.acc._odr = self.gyro._odr = 0
        self.mag.reset()

    def enable_default(self):
        self.acc.enable_default()
        self.gyro.enable_default()
        self.mag.enable_default()

    @_untimed
    def read(self):
        v = _imu_fetch(_IMU_ACC | _IMU_GYRO | _IMU_MAG)
        self.gyro.read(v)
        self.acc.read(v)
        self.mag.read(v)
