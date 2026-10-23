# Sumo starter for the official dohyo (black, white border).
# Press A, wait 5 s (rules art. 8), then: avoid the edge, find the opponent, push it out.
from zumo_2040_robot import robot
import time

motors = robot.Motors()
line = robot.LineSensors()
prox = robot.ProximitySensors()
display = robot.Display()
button_a = robot.ButtonA()
leds = robot.RGBLEDs()
buzzer = robot.Buzzer()

EDGE = 500  # raw line value below this = bright = white border
FULL = 6000
SEARCH = 2600
STEER = 700  # speed reduction per count of left/right difference


def show(*rows):
    display.fill(0)
    for i, r in enumerate(rows):
        display.text(r, 0, i * 12)
    display.show()


def colour(rgb):
    for i in range(6):
        leds.set(i, rgb)
    leds.show()


show("SPARK Sumo", "", "A = start")
while not button_a.check():
    time.sleep_ms(10)

for s in range(5, 0, -1):
    show("Start in", "", "    %d" % s)
    colour([40, 40, 0])
    buzzer.play_in_background("!L32 V12 a")  # short beep every second
    time.sleep_ms(1000)
buzzer.play_in_background("!L16 V15 >a")  # higher beep: go
show("FIGHT!")
colour([0, 0, 0])

side = 1  # where we saw the opponent last: 1 = right, -1 = left
while True:
    v = line.read()
    if v[0] < EDGE or v[1] < EDGE:
        motors.set_speeds(-FULL, -FULL)
        time.sleep_ms(160)
        motors.set_speeds(FULL, -FULL)
        time.sleep_ms(200)
        continue
    if v[2] < EDGE or v[3] < EDGE or v[4] < EDGE:
        motors.set_speeds(-FULL, -FULL)
        time.sleep_ms(160)
        motors.set_speeds(-FULL, FULL)
        time.sleep_ms(200)
        continue

    prox.read()
    fl = prox.front_counts_with_left_leds()
    fr = prox.front_counts_with_right_leds()
    l = prox.left_counts_with_left_leds()
    r = prox.right_counts_with_right_leds()

    if fl + fr >= 4:
        d = fl - fr  # > 0: opponent more to the left
        motors.set_speeds(FULL - STEER * max(0, d), FULL - STEER * max(0, -d))
        colour([255, 0, 0])
    elif l > r:
        motors.set_speeds(-FULL, FULL)
        side = -1
        colour([0, 0, 120])
    elif r > l:
        motors.set_speeds(FULL, -FULL)
        side = 1
        colour([0, 0, 120])
    else:
        motors.set_speeds(SEARCH * side, -SEARCH * side)
        colour([0, 30, 0])
