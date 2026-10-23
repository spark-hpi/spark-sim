# Line follower with a PD controller for a black line on a light surface (arena "Line track").
# First sweeps over the line to calibrate, then follows it. Prints lap-ish timing every 5 s.
from zumo_2040_robot import robot
import time

motors = robot.Motors()
line = robot.LineSensors()
display = robot.Display()
buzzer = robot.Buzzer()

BASE = 3200  # base speed
KP = 1.6
KD = 10


def show(*rows):
    display.fill(0)
    for i, r in enumerate(rows):
        display.text(r, 0, i * 12)
    display.show()


def calibrate_turn(left, right, ms):
    # every sensor has to pass over the line once: the outer ones sit 3.5 cm to the side, so the sweep
    # must reach about ±55° (a ±30° sweep leaves DN1 and DN5 uncalibrated)
    motors.set_speeds(left, right)
    start = time.ticks_ms()
    while time.ticks_diff(time.ticks_ms(), start) < ms:
        line.calibrate()


show("Calibrating ...")
calibrate_turn(-2000, 2000, 550)
calibrate_turn(2000, -2000, 1100)
calibrate_turn(-2000, 2000, 550)
motors.off()
buzzer.play_in_background("!T240 L16 V12 ceg")  # calibration done
show("Go!")

last = 0
while True:
    v = line.read_calibrated()
    total = v[0] + v[1] + v[2] + v[3] + v[4]
    if total < 300:
        # line lost: turn towards where it was last
        motors.set_speeds(2500 if last > 0 else -2500, -2500 if last > 0 else 2500)
        continue
    position = (1000 * v[1] + 2000 * v[2] + 3000 * v[3] + 4000 * v[4]) // total
    error = position - 2000
    correction = KP * error + KD * (error - last)
    last = error
    motors.set_speeds(BASE + correction, BASE - correction)
