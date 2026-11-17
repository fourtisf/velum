#!/usr/bin/env python3
"""
Original soundtrack of the "Perps are open" ad, synthesized from scratch (no samples, no third-party audio), so it
carries no licence beyond the repository's own.

120 BPM (one bar = 2 s), F minor, Fm - Db - Ab - Eb, laid out on ad-perps.html's timeline:
  0-2 s      drone and riser;  2.0 s  IMPACT on "PERPS" (sub drop, noise burst, chord hit, reverb tail);
  2-4 s      pulsing low synth, ticking hats;
  4-8 s      hook: hits on "Go long." (4.0), "Go short." (5.0), "Up to 5x" (6.0), a snare roll and riser, a gap at 7.75;
  8-32 s     the drop under the product footage: four-on-the-floor, claps, hats, off-beat bass, chord stabs, a
             whoosh into every cut (11, 14.5, 18, 22, 24, 28.5), the arp joins at 24 s (P&L);
  32-36 s    features: a ping on each tile (32.5, 33, 33.5, 34), a roll into 36;
  36-44 s    outro: final impact, the pad resolves on F minor with a bell, long fade.

Usage: python3 music-perps.py OUT.wav [DURATION_SECONDS]   (default 44, the ad's length)
"""
import sys
import wave

import numpy as np

SR = 44100
BPM = 120.0
BEAT = 60.0 / BPM
BAR = 4 * BEAT
OUT = sys.argv[1] if len(sys.argv) > 1 else 'music-perps.wav'
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 44.0
N = int((DUR + 3) * SR)
rng = np.random.default_rng(11)

L = np.zeros(N)
R = np.zeros(N)
sendL = np.zeros(N)  # reverb send
sendR = np.zeros(N)
duck = np.ones(N)

# Fm - Db - Ab - Eb: pad voicing, bass root, arp tones (MIDI)
CHORDS = [
    ([53, 56, 60, 65], 29, [65, 68, 72, 77]),  # Fm
    ([49, 53, 56, 61], 25, [61, 65, 68, 73]),  # Db
    ([51, 56, 60, 63], 32, [63, 68, 72, 75]),  # Ab/Eb
    ([51, 55, 58, 63], 27, [63, 67, 70, 75]),  # Eb
]
CUTS = [11.0, 14.5, 18.0, 22.0, 24.0, 28.5]


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def add(buf, start, sig, gain=1.0):
    i = int(round(start * SR))
    if i >= N or i + len(sig) <= 0:
        return
    if i < 0:
        sig = sig[-i:]
        i = 0
    j = min(N, i + len(sig))
    buf[i:j] += sig[: j - i] * gain


def addst(start, l, r, send=0.0):
    add(L, start, l)
    add(R, start, r)
    if send:
        add(sendL, start, l, send)
        add(sendR, start, r, send)


def pan(sig, p):
    a = (p + 1) * np.pi / 4
    return sig * np.cos(a), sig * np.sin(a)


def tt(sec):
    return np.arange(int(sec * SR)) / SR


def saw(f, t, harmonics=14, bright=1.0):
    s = np.zeros_like(t)
    for n in range(1, harmonics + 1):
        if f * n > 12000:
            break
        s += np.sin(2 * np.pi * f * n * t) / n * (bright ** (n - 1))
    return s


def onepole(x, cutoff):
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for k in range(len(x)):
        acc = (1 - a) * x[k] + a * acc
        y[k] = acc
    return y


def side(t0, depth=0.55, rel=0.16):
    i = int(t0 * SR)
    span = int(0.4 * SR)
    if i + span < N:
        x = tt(0.4)[:span]
        duck[i:i + span] = np.minimum(duck[i:i + span], 1 - depth * np.exp(-x / rel))


# ---------------- percussion ----------------
def kick(big=False):
    t = tt(0.5 if not big else 0.9)
    f = 44 + (110 if not big else 140) * np.exp(-t / 0.03)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / (0.22 if not big else 0.45))
    click = rng.standard_normal(len(t)) * np.exp(-t / 0.0025) * 0.2
    return np.tanh((body + click) * 1.6) * 0.62


def clap():
    t = tt(0.4)
    n = np.diff(rng.standard_normal(len(t)), prepend=0)
    env = np.zeros_like(t)
    for o in (0.0, 0.010, 0.021):
        env += np.where(t >= o, np.exp(-(t - o) / (0.006 if o < 0.02 else 0.14)), 0)
    return onepole(n * env, 4200) * 0.3


def hat(open_=False, v=1.0):
    d = 0.12 if open_ else 0.03
    t = tt(d * 5)
    n = np.diff(np.diff(rng.standard_normal(len(t)), prepend=0), prepend=0)
    return n * np.exp(-t / d) * 0.028 * v


def snare(v=1.0):
    t = tt(0.25)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.05)
    n = onepole(np.diff(rng.standard_normal(len(t)), prepend=0), 6000) * np.exp(-t / 0.09)
    return (tone * 0.4 + n * 0.9) * 0.22 * v


def boom(at, gain=1.0):
    """Cinematic impact: sub drop, filtered noise burst, chord hit, big reverb send."""
    t = tt(3.0)
    f = 72 * np.exp(-t / 0.9) + 30
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 1.1) * 0.75
    n = rng.standard_normal(len(t))
    burst = onepole(n, 2500) * np.exp(-t / 0.35) * 0.55
    k = kick(big=True)
    sig = sub + burst
    sig[: len(k)] += k
    sig = np.tanh(sig * 1.3) * gain
    addst(at, sig, sig, send=0.35)
    side(at, depth=0.85, rel=0.5)


def riser(end, length, gain=0.06):
    t = tt(length)
    n = np.diff(rng.standard_normal(len(t)), prepend=0)
    sweep = np.sin(2 * np.pi * np.cumsum(200 + 1600 * (t / length) ** 2) / SR) * 0.25
    sig = (n + sweep) * (t / length) ** 2.4 * gain
    l, r = pan(sig, -0.2)
    addst(end - length, l, np.roll(sig, 220), send=0.2)


def whoosh(at, length=0.45, gain=0.05):
    t = tt(length + 0.25)
    n = rng.standard_normal(len(t))
    env = np.where(t < length, (t / length) ** 2, np.exp(-(t - length) / 0.08))
    sig = np.diff(n, prepend=0) * env * gain
    l, r = pan(sig, 0.0)
    addst(at - length, l * 0.8, r, send=0.25)


# ---------------- tonal ----------------
def stab(start, notes, length=0.22, gain=0.05, bright=0.82, send=0.25):
    t = tt(length + 0.3)
    env = np.minimum(1, t / 0.004) * np.exp(-t / (length * 0.45))
    for m in notes:
        for sd, det in ((-1, -0.004), (1, 0.004)):
            s = saw(hz(m) * (1 + det), t, bright=bright) * env * gain
            l, r = pan(s, sd * 0.5)
            addst(start, l, r, send=send)


def pad(start, notes, length, gain=0.022, att=0.6, rel=1.2, bright=0.6):
    t = tt(length + rel)
    env = np.minimum(1, t / att) * np.where(t > length, np.exp(-(t - length) / (rel / 3)), 1.0)
    for m in notes:
        for sd, det in ((-1, -0.005), (1, 0.005)):
            s = saw(hz(m) * (1 + det), t, harmonics=10, bright=bright) * env * gain
            l, r = pan(s, sd * 0.7)
            addst(start, l, r, send=0.3)


def bass_note(start, root, length=0.2, gain=0.2):
    t = tt(length + 0.05)
    f = hz(root + 12)
    env = np.minimum(1, t / 0.004) * np.exp(-t / (length * 0.6))
    s = (np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) + 0.12 * saw(f, t, harmonics=6)) * env * gain
    addst(start, s, s)


def pluck(start, m, gain=0.05, p=0.0, send=0.3):
    t = tt(0.7)
    f = hz(m)
    s = (np.sin(2 * np.pi * f * t) + 0.45 * np.sin(4 * np.pi * f * t) + 0.18 * np.sin(6 * np.pi * f * t)) * np.exp(-t / 0.18) * np.minimum(1, t / 0.002)
    l, r = pan(s * gain, p)
    addst(start, l, r, send=send)


def bell(start, m, gain=0.08):
    t = tt(6)
    s = np.zeros_like(t)
    for ratio, amp, dec in ((1, 1, 2.4), (2.01, 0.45, 1.3), (3.02, 0.2, 0.7), (4.2, 0.1, 0.4)):
        s += np.sin(2 * np.pi * hz(m) * ratio * t) * amp * np.exp(-t / dec)
    s *= gain * np.minimum(1, t / 0.003)
    l, r = pan(s, 0.15)
    addst(start, l, r, send=0.45)


# ================= arrangement =================
# 0-2: drone + riser, impact at 2.0
t = tt(4.2)
drone = (np.sin(2 * np.pi * hz(29) * t) * 0.5 + saw(hz(41), t, harmonics=8, bright=0.5) * 0.08) * np.minimum(1, t / 1.2) * np.exp(-np.maximum(0, t - 2.0) / 1.2)
addst(0, drone * 0.35, drone * 0.35)
riser(2.0, 1.9, gain=0.07)
boom(2.0, 1.0)
stab(2.0, CHORDS[0][0] + [41], length=1.2, gain=0.045, bright=0.75, send=0.5)

# 2-4: 16th pulse on F, filtered and rising; ticking hats
for k in range(16):
    t0 = 2.0 + k * BEAT / 4 + BEAT * 0  # 2.0 .. 4.0
    if t0 >= 4.0:
        break
    bass_note(t0, CHORDS[0][1], length=0.1, gain=0.06 + 0.06 * k / 16)
for k in range(8):
    h = hat(v=0.7 + 0.3 * (k % 2))
    l, r = pan(h, 0.3)
    addst(2.0 + k * BEAT / 2 + BEAT / 2, l, r)

# 4-8: hook hits, then a roll into the drop
for at, ci in ((4.0, 0), (5.0, 1), (6.0, 2)):
    k = kick()
    addst(at, k, k)
    c = clap()
    addst(at, c, c, send=0.3)
    stab(at, CHORDS[ci][0] + [CHORDS[ci][1] + 12], length=0.5, gain=0.05, send=0.45)
    side(at, 0.7, 0.25)
for k in range(32):
    t0 = 4.0 + k * BEAT / 4
    if t0 >= 7.75:
        break
    root = CHORDS[0][1] if t0 < 5.0 else (CHORDS[1][1] if t0 < 6.0 else CHORDS[2][1])
    bass_note(t0, root, length=0.11, gain=0.11)
# snare roll 6.0 -> 7.75: 8ths, 16ths, 32nds, rising
t0 = 6.0
step = BEAT / 2
v = 0.35
while t0 < 7.75:
    s = snare(v)
    addst(t0, s, s, send=0.15)
    t0 += step
    v = min(1.0, v + 0.05)
    if t0 >= 6.75:
        step = BEAT / 4
    if t0 >= 7.25:
        step = BEAT / 8
riser(7.75, 1.75, gain=0.08)

# 8-32: the drop
for bar in range(4, 16):
    b0 = bar * BAR
    pv, root, tones = CHORDS[bar % 4]
    for beat in range(4):
        t0 = b0 + beat * BEAT
        k = kick()
        addst(t0, k, k)
        side(t0)
        if beat in (1, 3):
            c = clap()
            addst(t0, c, c, send=0.2)
        h = hat(open_=True, v=0.8)
        l, r = pan(h, -0.25)
        addst(t0 + BEAT / 2, l, r)
        for q in range(4):
            if q != 2:
                h = hat(v=0.55 if q % 2 else 0.85)
                l, r = pan(h, 0.35)
                addst(t0 + q * BEAT / 4, l, r)
        # off-beat bass: 16ths 2-4 of every beat (the classic bounce)
        for q in (1, 2, 3):
            bass_note(t0 + q * BEAT / 4, root, length=0.1, gain=0.15 if q == 2 else 0.11)
    # stabs: syncopated pattern (8th positions 0, 3, 6 of the bar), on top of a soft pad
    for e in (0, 3, 6):
        stab(b0 + e * BEAT / 2, pv, length=0.18, gain=0.032, send=0.3)
    pad(b0, pv, BAR, gain=0.012)
    # arp from 24 s (P&L): 16ths, ping-pong
    if b0 >= 24.0:
        seq = [0, 1, 2, 3, 2, 1, 2, 3]
        for q in range(16):
            pluck(b0 + q * BEAT / 4, tones[seq[q % 8]], gain=0.035, p=-0.3 if q % 2 else 0.3, send=0.2)
for c in CUTS:
    whoosh(c)

# 32-36: features
for bar in range(16, 18):
    b0 = bar * BAR
    pv, root, tones = CHORDS[bar % 4]
    for beat in range(4):
        t0 = b0 + beat * BEAT
        k = kick()
        addst(t0, k, k, 0.0)
        side(t0, 0.45)
        h = hat(open_=True, v=0.7)
        l, r = pan(h, -0.25)
        addst(t0 + BEAT / 2, l, r)
        for q in (1, 2, 3):
            bass_note(t0 + q * BEAT / 4, root, length=0.1, gain=0.1)
    pad(b0, pv, BAR, gain=0.016)
for i, at in enumerate((32.5, 33.0, 33.5, 34.0)):
    pluck(at, [72, 75, 77, 80][i], gain=0.08, send=0.45)
    c = clap()
    addst(at, c * 0.6, c * 0.6, send=0.3)
t0, step, v = 35.0, BEAT / 4, 0.4
while t0 < 36.0:
    s = snare(v)
    addst(t0, s, s, send=0.15)
    t0 += step
    v = min(1.0, v + 0.06)
    if t0 >= 35.5:
        step = BEAT / 8
riser(36.0, 1.0, gain=0.06)

# 36-44: outro
boom(36.0, 0.95)
stab(36.0, CHORDS[0][0] + [41, 77], length=1.6, gain=0.04, bright=0.75, send=0.55)
pad(36.0, CHORDS[0][0] + [72], 6.5, gain=0.024, att=0.4, rel=2.0, bright=0.62)
bell(36.2, 77)
bell(38.2, 72, gain=0.05)
for k in range(8):  # a soft heartbeat under the logo
    kk = kick() * 0.35
    addst(38.0 + k * BEAT * 2, onepole(kk, 900), onepole(kk, 900))

# ================= mix =================
# reverb: convolution with a decaying stereo noise tail (2.4 s)
irl = tt(2.4)
ir_l = rng.standard_normal(len(irl)) * np.exp(-irl / 0.55)
ir_r = rng.standard_normal(len(irl)) * np.exp(-irl / 0.55)
ir_l[: int(0.012 * SR)] = 0
ir_r[: int(0.017 * SR)] = 0
ir_l /= np.sqrt(np.sum(ir_l ** 2))
ir_r /= np.sqrt(np.sum(ir_r ** 2))


def conv(x, h):
    n = len(x) + len(h)
    size = 1 << (n - 1).bit_length()
    y = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(h, size), size)
    return y[: len(x)]


wetL = conv(onepole(sendL, 7000), ir_l) * 0.55
wetR = conv(onepole(sendR, 7000), ir_r) * 0.55
L = L * duck + wetL
R = R * duck + wetR
n = int(DUR * SR)
mix = np.stack([L[:n], R[:n]], axis=1)
fade_out = int(2.5 * SR)
mix[-fade_out:] *= np.linspace(1, 0, fade_out)[:, None] ** 1.5
mix[: int(0.05 * SR)] *= np.linspace(0, 1, int(0.05 * SR))[:, None]
mix /= np.max(np.abs(mix)) + 1e-9
mix = np.tanh(mix * 1.6) / np.tanh(1.6) * 0.9
pcm = (mix * 32767).astype('<i2')
with wave.open(OUT, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print(f'{OUT}: {DUR:.1f} s, {BPM:.0f} BPM')
