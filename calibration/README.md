# Calibration with real Zumos

Goal: replace the estimated numbers (`EST` in `src/shared/zumo-spec.ts`) with measured ones. One session with
2–5 Zumos takes about an hour. Write everything down per robot (label the robots 1, 2, 3 … with tape).

**Bring:** tape measure (2 m), kitchen scale, feeler gauge (or printer paper: one sheet ≈ 0.1 mm), phone with
slow motion, USB cable, Thonny (or `mpremote`), freshly charged batteries, the arena surface if possible.

## 1. Without a program (15 min)

| # | Measure | How | Sets |
|---|---|---|---|
| 1 | **Blade edge height** — most important | robot on a flat table; gap under the blade's lower edge at the **left** and the **right** end (feeler gauge / paper sheets) | `bladeGapSpread`, `bladeTiltSpread` (they decide most head-on sumo clashes) |
| 2 | **Head-on duel** | two Zumos nose to nose, both full power, film in slow motion; repeat with one at half power; 5× each | does power or the lower blade win? |
| 3 | **Weight** | kitchen scale, with batteries | `mass` |
| 4 | **Centre of mass** | balance the robot across a pencil (front–back), distance from the pencil to the middle of the tracks | `comX` |
| 5 | **Tilt test** | robot switched off, sideways on the arena plate, lift one end slowly; note the angle when it slides (μ = tan angle) | `trackMu` |
| 6 | **Blade angle and length** | protractor / ruler on the blade face | `bladeAngleDeg`, `bladeLength` |

## 2. With `zumo_calibration.py` (30–45 min)

Open `calibration/zumo_calibration.py` in Thonny, run it on the robot (USB stays connected). **C** next test,
**A** start, **B** abort. Copy every `RESULT …` line (and the `LOG` lines of STRAIGHT) from the console into a
text file per robot.

| Test | Setup | Note by hand |
|---|---|---|
| STRAIGHT | 2 m free floor (arena surface if possible), mark the start | distance driven until it stops (tape measure) |
| SPIN | middle of the floor | — |
| PUSH | kitchen scale upright against a wall, robot's nose touching it | the scale's highest value (g) |
| BRAKE | like STRAIGHT | distance from where it was when the motors went off, if you can see it (else the encoder value counts) |
| PROX | second Zumo in front at 5, 10, 15 … 45 cm, then sideways (track facing), then 30° angled; **A** at each spot | the distance and the angle for each logged line |
| LINE | robot on white, on black, half over the edge, on the brown start-line tape, lifted 1 cm; **A** at each | the surface for each logged line |
| IMU | turn left by hand, tilt the nose up, lay it flat; **A** after each | what you did for each line |
| TIMING | anywhere, takes 2 s | — |

The same program runs in the simulator (paste it as your code, Free practice arena, ▶ Run, keys C and A), so every
line can be compared one to one. Between the driving tests, Shift + drag the robot back to the left end of the table.

## 3. Send the results

One text file per robot with the `RESULT` lines and the notes from section 1 — to the SPARK sim team. Then the values go into
`zumo-spec.ts`, the house bots and the bench matrices are re-checked, and the docs are updated.
