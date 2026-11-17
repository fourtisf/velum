#!/usr/bin/env python3
"""
Original background music for the "How to buy stocks on Velum" video, synthesized from scratch (no samples, no
third-party audio), so it carries no licence beyond the repository's own.

100 BPM (one bar = 2.4 s), F - C - G - Am, laid out on the video's timeline (edit.cjs: intro 5.5 s and steps 6 s with
0.6 s and 0.7 s crossfades, the app footage from 10.2 s, the outro from about 98.6 s):
  bars 0-3   (0-9.6 s)     pad and a soft pluck arpeggio over the title scenes, a short riser into bar 4;
  bars 4-19  (9.6-48 s)    the beat enters with the app footage: kick, off-beat hats, pulsing bass, side-chained pad;
  bars 20-40 (48-98.4 s)   adds claps and a brighter arpeggio (Portfolio, P&L, Sell);
  bar 41-end (98.4 s-)     the outro: drums stop, the pad resolves on F with a bell, then a long fade.

Usage: python3 music-howto.py OUT.wav [DURATION_SECONDS]   (default 105.6, the edited video's length)
"""
import sys
import wave

import numpy as np

SR = 44100
BPM = 100.0
BEAT = 60.0 / BPM
BAR = 4 * BEAT
OUT = sys.argv[1] if len(sys.argv) > 1 else 'music-howto.wav'
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 105.6
N = int(DUR * SR) + SR
rng = np.random.default_rng(7)

L = np.zeros(N)
R = np.zeros(N)
duck = np.ones(N)  # side-chain gain for pad and bass, pulled down by each kick

DRUMS_FROM, CLAPS_FROM, OUTRO_FROM = 4, 20, 41
LAST_BAR = int(DUR / BAR) + 1

# F - C - G - Am: pad voicings, bass roots, arpeggio tones (MIDI note numbers).
CHORDS = [
    ([53, 57, 60, 64], 41, [65, 69, 72, 76]),  # Fmaj7
    ([52, 55, 60, 64], 36, [64, 67, 72, 76]),  # C/E
    ([55, 59, 62, 67], 43, [67, 71, 74, 79]),  # G
    ([57, 60, 64, 69], 45, [69, 72, 76, 81]),  # Am
]


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def add(buf, start, sig):
    i = int(start * SR)
    if i >= N:
        return
    j = min(N, i + len(sig))
    buf[i:j] += sig[: j - i]


def pan(sig, p):
    """p in [-1, 1]; equal-power."""
    a = (p + 1) * np.pi / 4
    return sig * np.cos(a), sig * np.sin(a)


def lowpass(x, cutoff):
    """One-pole low-pass (cheap, smooth)."""
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for k in range(len(x)):  # short signals only
        acc = (1 - a) * x[k] + a * acc
        y[k] = acc
    return y


def saw_like(f, t, harmonics=9, bright=1.0):
    s = np.zeros_like(t)
    for n in range(1, harmonics + 1):
        if f * n > 9000:
            break
        s += np.sin(2 * np.pi * f * n * t) / n * (bright ** (n - 1))
    return s


# ---------------- pad (one chord per bar, overlapping release) ----------------
for bar in range(LAST_BAR):
    pad_notes, _, _ = CHORDS[bar % 4]
    if bar >= OUTRO_FROM:
        pad_notes = CHORDS[0][0] + [72]  # resolve on F, add the octave
    length = BAR + 1.6 if bar < OUTRO_FROM else max(1.0, DUR - bar * BAR + 0.5)
    t = np.arange(int(length * SR)) / SR
    att = 0.45 if bar else 2.2
    env = np.minimum(1, t / att) * np.where(t > BAR, np.exp(-(t - BAR) / 0.5), 1.0)
    if bar >= OUTRO_FROM:
        env = np.minimum(1, t / 0.3) * np.exp(-t / 4.5)
    bright = 0.62 if bar < DRUMS_FROM else (0.7 if bar < CLAPS_FROM else 0.76)
    for k, m in enumerate(pad_notes):
        for side, det in ((-1, -0.0035), (1, 0.0035)):
            s = saw_like(hz(m) * (1 + det), t, bright=bright) * env * 0.034
            l, r = pan(s, side * 0.55)
            add(L, bar * BAR, l)
            add(R, bar * BAR, r)

# ---------------- riser into the drop (bar 3, last 1.8 s) ----------------
rise_len = 1.8
t = np.arange(int(rise_len * SR)) / SR
noise = rng.standard_normal(len(t))
hp = np.diff(noise, prepend=0)
riser = hp * (t / rise_len) ** 2.2 * 0.05
add(L, DRUMS_FROM * BAR - rise_len, riser)
add(R, DRUMS_FROM * BAR - rise_len, riser)

# ---------------- drums ----------------
def kick():
    t = np.arange(int(0.42 * SR)) / SR
    f = 46 + 84 * np.exp(-t / 0.035)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t / 0.2)
    click = rng.standard_normal(len(t)) * np.exp(-t / 0.003) * 0.15
    return (body + click) * 0.55


def hat(open_=False):
    d = 0.11 if open_ else 0.035
    t = np.arange(int((d * 5) * SR)) / SR
    n = rng.standard_normal(len(t))
    n = np.diff(np.diff(n, prepend=0), prepend=0)  # brighter
    return n * np.exp(-t / d) * 0.035


def clap():
    t = np.arange(int(0.35 * SR)) / SR
    n = rng.standard_normal(len(t))
    n = np.diff(n, prepend=0)
    env = np.zeros_like(t)
    for o in (0.0, 0.011, 0.022):
        env += np.where(t >= o, np.exp(-(t - o) / (0.006 if o < 0.02 else 0.13)), 0)
    return lowpass(n * env, 3200) * 0.22


K = kick()
for bar in range(DRUMS_FROM, OUTRO_FROM):
    for beat in range(4):
        t0 = bar * BAR + beat * BEAT
        if beat in (0, 2) or bar >= CLAPS_FROM + 8:  # four on the floor in the last stretch
            add(L, t0, K)
            add(R, t0, K)
            i = int(t0 * SR)
            span = int(0.32 * SR)
            if i + span < N:
                tt = np.arange(span) / SR
                duck[i : i + span] = np.minimum(duck[i : i + span], 1 - 0.45 * np.exp(-tt / 0.12))
        # off-beat hats, an open one at the end of every second bar
        h = hat(open_=(beat == 3 and bar % 2 == 1))
        l, r = pan(h, 0.35)
        add(L, t0 + BEAT / 2, l)
        add(R, t0 + BEAT / 2, r)
        if bar >= CLAPS_FROM and beat in (1, 3):
            c = clap()
            add(L, t0, c)
            add(R, t0, c)

# ---------------- bass (8th-note pulses on the root) ----------------
for bar in range(DRUMS_FROM, OUTRO_FROM):
    _, root, _ = CHORDS[bar % 4]
    f = hz(root)
    for e in range(8):
        t0 = bar * BAR + e * BEAT / 2
        t = np.arange(int(0.32 * SR)) / SR
        env = np.minimum(1, t / 0.006) * np.exp(-t / 0.16)
        s = (np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t) + 0.08 * np.sin(6 * np.pi * f * t)) * env * (0.15 if e % 2 == 0 else 0.11)
        add(L, t0, s)
        add(R, t0, s)

# ---------------- pluck arpeggio with a dotted-8th echo ----------------
ARP = [0, 2, 1, 3, 2, 1, 3, 2]
arpL = np.zeros(N)
arpR = np.zeros(N)
for bar in range(0, OUTRO_FROM):
    _, _, tones = CHORDS[bar % 4]
    for e in range(8):
        if bar < DRUMS_FROM and e % 2 == 1:
            continue  # sparser over the titles
        m = tones[ARP[e]]
        t0 = bar * BAR + e * BEAT / 2
        t = np.arange(int(0.6 * SR)) / SR
        f = hz(m)
        bright = 0.35 if bar < CLAPS_FROM else 0.5
        s = (np.sin(2 * np.pi * f * t) + bright * np.sin(4 * np.pi * f * t) + bright * 0.4 * np.sin(6 * np.pi * f * t)) * np.exp(-t / 0.2) * np.minimum(1, t / 0.003)
        vel = 0.05 if bar < DRUMS_FROM else 0.06
        l, r = pan(s * vel, -0.25 if e % 2 else 0.25)
        add(arpL, t0, l)
        add(arpR, t0, r)
d = int(BEAT * 0.75 * SR)
for _ in range(3):  # three echoes, ping-pong, falling
    arpL[d:] += 0.33 * arpR[:-d]
    arpR[d:] += 0.33 * arpL[:-d]
L += arpL
R += arpR

# ---------------- outro bell ----------------
t = np.arange(int(6 * SR)) / SR
bell = np.zeros_like(t)
for ratio, amp, dec in ((1, 1, 2.2), (2.01, 0.45, 1.2), (3.02, 0.22, 0.7), (4.2, 0.12, 0.4)):
    bell += np.sin(2 * np.pi * hz(77) * ratio * t) * amp * np.exp(-t / dec)
bell *= 0.07 * np.minimum(1, t / 0.004)
l, r = pan(bell, 0.15)
add(L, OUTRO_FROM * BAR + 0.2, l)
add(R, OUTRO_FROM * BAR + 0.2, r)

# ---------------- mix ----------------
L *= duck
R *= duck
n = int(DUR * SR)
mix = np.stack([L[:n], R[:n]], axis=1)
# gentle fades and a soft limiter; loudness is set when muxing (ffmpeg loudnorm)
fade_in = int(0.8 * SR)
fade_out = int(3.0 * SR)
mix[:fade_in] *= np.linspace(0, 1, fade_in)[:, None]
mix[-fade_out:] *= np.linspace(1, 0, fade_out)[:, None] ** 1.6
mix /= np.max(np.abs(mix)) + 1e-9
mix = np.tanh(mix * 1.4) / np.tanh(1.4) * 0.89
pcm = (mix * 32767).astype('<i2')
with wave.open(OUT, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print(f'{OUT}: {DUR:.1f} s, {BPM:.0f} BPM')
