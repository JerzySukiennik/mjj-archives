"""choreo.timeline — Task 2: 25-segment choreography assembly + authored root.

Consumes Task 1's contract (BeatGrid/FreeGrid, Pose, CYCLES, slerp_pose,
overlay). Produces, as pure functions of absolute time t in [0, 296.796]:

    sample_pose(t) -> Pose        root-relative limb pose (cycles + accents +
                                  holds, with >=0.45s beat-aligned crossfades)
    root_x(t)      -> float       stage lateral position, METRES (+x stage-right)
    root_yaw(t)    -> float       hips heading, RADIANS (0 = facing audience)

Root translation & yaw are 100% AUTHORED here (mocap hip data discarded).
x/yaw are C1 CubicHermiteSpline through hand-placed waypoints with ZERO
velocity at every waypoint (=> smooth eases, no teleports, bounded speed).
Spins are explicit monotone yaw ramps on the unwrapped angle.

Mocap limb overlay is deliberately NOT used: the directive is "authored wins,
when in doubt skip", and blending the rejected-clip limb noise back in risks
reintroducing exactly the artefacts Jurek rejected. Every segment therefore
runs on authored cycles only.
"""
from __future__ import annotations
import numpy as np
from scipy.interpolate import CubicHermiteSpline

from .core import BeatGrid, FreeGrid, Pose, slerp_pose, overlay, rest_pose
from .cycles import CYCLES

GRID = BeatGrid(bpm=117.0, t0=89.37)
FREE = FreeGrid(period=1.0)
T0_SONG = 89.37
DURATION = 296.796
MOONWALK_T0 = 218.15
MOONWALK_T1 = 226.36


def snap(t: float) -> float:
    """Snap a time >=89.37 to the nearest 117BPM beat; pass through below."""
    return GRID.snap(t) if t >= T0_SONG else float(t)


# ---------------------------------------------------------------------------
# SEGMENTS: the choreography timeline verbatim from the planner.
#   t0,t1     : segment span (song-side boundaries beat-snapped below)
#   cyc       : looping cycle name (CYCLES key)
#   accents   : [(t, oneshot-name, weight)] point one-shots
#   holds     : [(t0, t1, oneshot-name, weight)] continuous partial overlays
#   xs        : [(t, x_metres)] lateral waypoints (zero-velocity)
#   yaws      : [(t, yaw_deg)]  heading waypoints on the UNWRAPPED angle
# ---------------------------------------------------------------------------
SEGMENTS = [
    # ---- SPOKEN INTRO (free 1.0s pseudo-grid) ----
    dict(t0=0.0, t1=2.8, cyc="walk-cycle", accents=[], holds=[],
         xs=[(0.0, -1.0), (2.8, 0.0)], yaws=[(0.0, 0.0)]),
    dict(t0=2.8, t1=4.5, cyc="sway-idle",
         accents=[(2.83, "hat-tip", 1.0)], holds=[],
         xs=[(2.8, 0.0)], yaws=[]),
    dict(t0=4.5, t1=20.0, cyc="sway-idle",
         accents=[(6.0, "arm-point", 0.5), (11.0, "head-look-R", 0.7),
                  (16.0, "arm-point", 0.45)],
         holds=[(8.0, 20.0, "mic-hold-R", 1.0)],
         xs=[(4.5, 0.0), (20.0, 0.0)], yaws=[]),
    dict(t0=20.0, t1=45.0, cyc="sway-idle",
         accents=[(27.0, "head-look-L", 0.7), (36.0, "head-look-R", 0.7)],
         holds=[(20.0, 45.0, "mic-hold-R", 1.0), (20.0, 45.0, "pocket-L", 0.8)],
         xs=[(20.0, 0.0), (27.0, -0.5), (36.0, 0.5), (45.0, 0.0)], yaws=[]),
    dict(t0=45.0, t1=58.0, cyc="strut-walk",
         accents=[(49.0, "arm-point", 0.6)],
         holds=[(45.0, 58.0, "mic-hold-R", 1.0)],
         xs=[(45.0, 0.0), (58.0, 1.5)], yaws=[]),
    dict(t0=58.0, t1=70.0, cyc="strut-walk",
         accents=[(63.0, "arm-point", 0.6)], holds=[],
         xs=[(58.0, 1.5), (70.0, -0.5)], yaws=[]),
    dict(t0=70.0, t1=84.0, cyc="strut-walk",
         accents=[(78.0, "mic-down", 1.0)],
         holds=[(70.0, 78.0, "mic-hold-R", 1.0)],
         xs=[(70.0, -0.5), (77.0, -1.0), (84.0, -0.5)], yaws=[]),
    dict(t0=84.0, t1=89.37, cyc="anticipation-stance",
         accents=[(87.5, "hat-tip", 0.8)], holds=[],
         xs=[(84.0, -0.5), (87.5, 0.0), (89.37, 0.0)], yaws=[]),

    # ---- SONG (boundaries beat-snapped) ----
    dict(t0=89.37, t1=105.78, cyc="hat-groove",
         accents=[(89.37, "hip-thrust", 0.8), (91.42, "hip-thrust", 0.8),
                  (93.47, "hip-thrust", 0.8), (95.52, "hat-toss", 1.0),
                  (97.57, "hip-thrust", 0.8), (99.62, "hip-thrust", 0.8),
                  (101.68, "hip-thrust", 0.8), (103.73, "hip-thrust", 0.8)],
         holds=[], xs=[(89.37, 0.0), (105.78, 0.0)], yaws=[(89.37, 0.0)]),
    dict(t0=105.78, t1=138.59, cyc="idle-groove",
         accents=[(112.0, "kick-snap", 1.0), (120.0, "kick-snap", 1.0),
                  (124.6, "crotch-grab", 1.0), (128.5, "kick-snap", 1.0),
                  (136.5, "kick-snap", 1.0)],
         holds=[(105.78, 138.59, "mic-hold-R", 0.6)],
         xs=[(105.78, 0.0), (110.0, 0.0), (118.0, -1.2), (126.0, 0.0),
             (134.0, 0.6), (138.59, 1.0)], yaws=[]),
    dict(t0=138.59, t1=154.99, cyc="step-touch",
         accents=[(140.0, "arm-point", 1.0), (144.0, "arm-point", 1.0),
                  (147.0, "crotch-grab", 1.0), (150.0, "arm-point", 1.0),
                  (153.0, "arm-point", 1.0)],
         holds=[], xs=[(138.59, 1.0), (147.0, -0.2), (154.99, -1.5)], yaws=[]),
    dict(t0=154.99, t1=171.40, cyc="step-touch",
         accents=[(157.0, "hip-thrust", 0.9), (159.0, "hip-thrust", 0.9),
                  (163.2, "kick-snap", 1.0), (165.0, "hip-thrust", 0.9),
                  (169.4, "kick-snap", 1.0)],
         holds=[], xs=[(154.99, -1.5), (160.0, 1.5), (166.0, -0.8),
                       (171.40, 0.5)], yaws=[]),
    dict(t0=171.40, t1=181.77, cyc="idle-groove",
         accents=[(173.0, "arm-point", 0.7), (177.0, "arm-point", 0.7),
                  (180.0, "arm-point", 0.7)],
         holds=[], xs=[(171.40, 0.5), (181.77, 0.5)],
         yaws=[(181.0, 0.0)]),
    # SPIN-1 (+720)
    dict(t0=181.77, t1=183.8, cyc="spin",
         accents=[(183.6, "toe-freeze", 0.8)], holds=[],
         xs=[(181.77, 0.5), (183.8, 0.5)],
         yaws=[(181.77, 0.0), (182.67, 720.0), (183.8, 720.0)]),
    dict(t0=183.8, t1=199.2, cyc="idle-groove",
         accents=[(187.4, "kick-snap", 1.0), (191.5, "crotch-grab", 1.0),
                  (195.6, "kick-snap", 1.0)],
         holds=[(183.8, 199.2, "mic-hold-R", 0.5)],
         xs=[(184.0, 0.5), (191.0, -1.0), (199.2, 0.0)], yaws=[(183.8, 720.0)]),
    dict(t0=199.2, t1=218.15, cyc="step-touch",
         accents=[(202.0, "arm-point", 1.0), (206.0, "arm-point", 1.0),
                  (210.0, "arm-point", 1.0), (214.0, "arm-point", 1.0)],
         holds=[], xs=[(199.2, 0.0), (208.0, 1.6), (214.0, 2.4),
                       (218.15, 2.75)], yaws=[(199.2, 720.0)]),
    # THE MOONWALK: +2.75 -> -2.75 (net 5.5m backward vs facing), LEFT PROFILE
    # (yaw 720->810 = +90deg: nose points +x while gliding -x => backward glide)
    dict(t0=MOONWALK_T0, t1=MOONWALK_T1, cyc="moonwalk-cycle", accents=[],
         holds=[], xs=[(MOONWALK_T0, 2.75), (MOONWALK_T1, -2.75)],
         yaws=[(MOONWALK_T0, 720.0), (218.85, 810.0), (225.66, 810.0),
               (MOONWALK_T1, 720.0)]),
    dict(t0=226.36, t1=230.5, cyc="idle-groove",
         accents=[(228.4, "crouch-freeze", 0.9)], holds=[],
         xs=[(226.36, -2.75), (230.5, -2.75)],
         yaws=[(226.36, 720.0), (226.9, 1080.0), (227.8, 1080.0)]),
    dict(t0=230.5, t1=242.83, cyc="step-touch",
         accents=[(234.0, "hip-thrust", 0.9), (238.0, "hip-thrust", 0.9),
                  (242.3, "hip-thrust", 1.0)],
         holds=[], xs=[(230.5, -2.75), (234.0, 0.0), (242.83, 0.0)],
         yaws=[(230.5, 1080.0)]),
    # TOE-STAND (frame-verified instant filled by build.py; nominal 242.83)
    dict(t0=242.83, t1=245.9, cyc="idle-groove",
         accents=[(242.83, "toe-stand", 1.0)], holds=[],
         xs=[(242.83, 0.0), (245.9, 0.0)], yaws=[]),
    dict(t0=245.9, t1=262.3, cyc="step-touch",
         accents=[(248.0, "arm-point", 1.0), (250.0, "crotch-grab", 1.0),
                  (254.0, "arm-point", 1.0), (258.2, "crotch-grab", 1.0),
                  (261.0, "arm-point", 1.0)],
         holds=[], xs=[(245.9, 0.0), (250.0, -1.2), (254.0, 1.2),
                       (258.0, -1.0), (262.3, 0.0)], yaws=[]),
    dict(t0=262.3, t1=279.2, cyc="strut-walk",
         accents=[(267.0, "hip-thrust", 1.0), (272.0, "hip-thrust", 1.0),
                  (277.0, "hip-thrust", 1.0)],
         holds=[], xs=[(262.3, 0.0), (267.0, -2.0), (272.0, 2.0),
                       (279.2, 0.0)], yaws=[]),
    dict(t0=279.2, t1=289.23, cyc="step-touch",
         accents=[(281.0, "hip-thrust", 0.9), (283.0, "hip-thrust", 0.9),
                  (287.2, "kick-snap", 1.0)],
         holds=[], xs=[(279.2, 0.0), (289.23, 0.0)], yaws=[(279.2, 1080.0)]),
    # SPIN-3 (+360) inside finale build handled via yaw waypoint at 284.1
    dict(t0=289.23, t1=291.3, cyc="idle-groove",
         accents=[(289.23, "finale-pose", 1.0)], holds=[],
         xs=[(289.23, 0.0), (291.3, 0.0)],
         yaws=[(284.1, 1080.0), (285.0, 1440.0), (289.23, 1440.0)]),
    dict(t0=291.3, t1=DURATION, cyc="sway-idle",
         accents=[(291.5, "bow", 1.0), (293.0, "wave", 0.0)],
         holds=[(293.0, 295.5, "mic-hold-R", 0.0)],
         xs=[(291.3, 0.0), (DURATION, 0.0)], yaws=[(291.3, 1440.0)]),
]

# beat-snap all song-side boundaries and accent/hold/waypoint times
for _seg in SEGMENTS:
    _seg["t0"] = snap(_seg["t0"])
    _seg["t1"] = snap(_seg["t1"])
# keep spans contiguous after snapping (t1 of one == t0 of next)
for _i in range(len(SEGMENTS) - 1):
    SEGMENTS[_i + 1]["t0"] = SEGMENTS[_i]["t1"]
SEGMENTS[0]["t0"] = 0.0
SEGMENTS[-1]["t1"] = DURATION


# ---------------------------------------------------------------------------
# Root splines (built once from the aggregated waypoints).
# ---------------------------------------------------------------------------
def _build_spline(pairs):
    """CubicHermiteSpline with zero derivative at every (dedup'd, sorted) knot."""
    d = {}
    for t, v in pairs:
        d[round(float(t), 4)] = float(v)
    ts = np.array(sorted(d), float)
    vs = np.array([d[t] for t in ts], float)
    dv = np.zeros_like(vs)
    return CubicHermiteSpline(ts, vs, dv)


_X_SPLINE = _build_spline([p for seg in SEGMENTS for p in seg["xs"]])
_YAW_SPLINE = _build_spline([p for seg in SEGMENTS for p in seg["yaws"]])


def root_x(t: float) -> float:
    return float(_X_SPLINE(np.clip(t, 0.0, DURATION)))


def root_yaw(t: float) -> float:
    return float(np.radians(_YAW_SPLINE(np.clip(t, 0.0, DURATION))))


# ---------------------------------------------------------------------------
# Pose sampling.
# ---------------------------------------------------------------------------
def _phase_of(cyc, t: float) -> float:
    b = GRID.beats(t) if t >= T0_SONG else FREE.beats(t)
    return b / cyc.duration_beats


def _beat_len_at(t: float) -> float:
    return GRID.beat_len if t >= T0_SONG else FREE.beat_len


def _smoothstep(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return x * x * (3.0 - 2.0 * x)


def _apply_accents(base: Pose, seg, t: float) -> Pose:
    out = base
    for (ta, name, w) in seg["accents"]:
        if w <= 0.0 or name not in CYCLES:
            continue
        os = CYCLES[name]
        sec = os.duration_beats * _beat_len_at(ta)
        if sec <= 0:
            continue
        phase = (t - ta) / sec
        if phase < 0.0 or phase > 1.0:
            continue
        env = os.weight_env(phase)
        if env <= 0.0:
            continue
        out = overlay(out, os.sample(phase), os.mask, w * env)
    return out


def _apply_holds(base: Pose, seg, t: float) -> Pose:
    out = base
    for (h0, h1, name, w) in seg["holds"]:
        if w <= 0.0 or name not in CYCLES:
            continue
        if t < h0 or t > h1:
            continue
        os = CYCLES[name]
        ramp = min(1.0, (t - h0) / 0.3, (h1 - t) / 0.3)
        env = _smoothstep(ramp)
        if env <= 0.0:
            continue
        out = overlay(out, os.sample(0.0), os.mask, w * env)
    return out


def _pose_of_segment(seg, t: float) -> Pose:
    cyc = CYCLES[seg["cyc"]]
    base = cyc.sample(_phase_of(cyc, t))
    base = _apply_accents(base, seg, t)
    base = _apply_holds(base, seg, t)
    return base


_FADE = 0.45
_H = _FADE / 2.0


def _seg_index(t: float) -> int:
    for i, seg in enumerate(SEGMENTS):
        if seg["t0"] <= t < seg["t1"]:
            return i
    return len(SEGMENTS) - 1


def sample_pose(t: float) -> Pose:
    t = float(np.clip(t, 0.0, DURATION))
    i = _seg_index(t)
    seg = SEGMENTS[i]
    base = _pose_of_segment(seg, t)
    # crossfade across the nearer boundary
    if t < seg["t0"] + _H and i > 0:
        B = seg["t0"]
        w = _smoothstep((t - (B - _H)) / _FADE)
        prev = _pose_of_segment(SEGMENTS[i - 1], t)
        return slerp_pose(prev, base, w)
    if t > seg["t1"] - _H and i < len(SEGMENTS) - 1:
        B = seg["t1"]
        w = _smoothstep((t - (B - _H)) / _FADE)
        nxt = _pose_of_segment(SEGMENTS[i + 1], t)
        return slerp_pose(base, nxt, w)
    return base
