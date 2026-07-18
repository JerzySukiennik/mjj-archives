"""choreo.cycles — authored, beat-locked MJ dance cycle & one-shot library.

All poses are authored in the REST/root frame (performer faces -Z = audience,
performer-RIGHT = +X, UP = +Y) via world-space long-axis targets; core.py's
pose_from_world_dirs() FK-converts them to parent-relative LOCAL quats. Root
yaw + stage translation live in the timeline layer, never here.

Exports CYCLES: dict[str, Cycle|OneShot]. Every LOOPING cycle carries visible
rhythmic motion (weight shift / bounce / head nod / arm sway) — none sample to
a static pose. Moonwalk-cycle & toe-stand were authored against extracted video
frames (t=219-225 left-profile glide; t=240-245 toe rise) — see pipeline/work/
frames/choreo-ref/.
"""
from __future__ import annotations
from math import radians
from typing import Dict, List, Tuple, Optional, Set
import numpy as np

from .core import (Pose, Cycle, OneShot, pose_from_world_dirs, vdir,
                   LIMB_BONES, REST_LOCAL)

# ---- short bone keys -> full mixamo bone names -----------------------------
_SHORT = {
    "LS": "mixamorig:LeftShoulder", "LA": "mixamorig:LeftArm",
    "LF": "mixamorig:LeftForeArm", "LH": "mixamorig:LeftHand",
    "RS": "mixamorig:RightShoulder", "RA": "mixamorig:RightArm",
    "RF": "mixamorig:RightForeArm", "RH": "mixamorig:RightHand",
    "LU": "mixamorig:LeftUpLeg", "LL": "mixamorig:LeftLeg", "LT": "mixamorig:LeftFoot",
    "RU": "mixamorig:RightUpLeg", "RL": "mixamorig:RightLeg", "RT": "mixamorig:RightFoot",
    "SP": "mixamorig:Spine", "NK": "mixamorig:Neck",
}


def P(short_targets: Dict[str, object], dy: float = 0.0, lean: float = 0.0) -> Pose:
    """Author a pose from short-key world-dir targets."""
    tg = {}
    for k, v in short_targets.items():
        tg[_SHORT[k]] = v
    return pose_from_world_dirs(tg, dy=dy, lean=lean)


# ---- reusable limb sub-poses (as short-key dicts, merged per key) -----------
def arms_relaxed(swing: float = 0.0) -> Dict[str, object]:
    """Arms hanging at the sides with a slight forward/out cast. swing in [-1,1]
    counter-swings them front/back (loose)."""
    fz = swing * 0.35
    return {
        "RA": vdir(0.20, -1.0, 0.05 + fz), "RF": vdir(0.16, -1.0, 0.10 + fz),
        "RH": vdir(0.14, -1.0, 0.12 + fz),
        "LA": vdir(-0.20, -1.0, 0.05 - fz), "LF": vdir(-0.16, -1.0, 0.10 - fz),
        "LH": vdir(-0.14, -1.0, 0.12 - fz),
    }


def mic_hold_R() -> Dict[str, object]:
    """Right hand up near the mouth holding the mic; upper arm down-forward."""
    return {
        "RA": vdir(0.10, -0.55, -0.83), "RF": vdir(-0.15, 0.55, -0.82),
        "RH": vdir(-0.10, 0.75, -0.65),
    }


# ============================================================================
#  LOOPING CYCLES
# ============================================================================

def _sway_idle() -> Cycle:
    # subtle weight shift + shoulder pulse + head nod, 2-beat loop
    k0 = P({**arms_relaxed(-0.15), "SP": vdir(-0.06, 1.0, 0.03),
            "NK": vdir(0.0, 1.0, -0.10)}, dy=0.0, lean=0.02)
    k1 = P({**arms_relaxed(0.0), "SP": vdir(0.0, 1.0, 0.0),
            "NK": vdir(0.0, 1.0, 0.02)}, dy=0.02, lean=0.0)
    k2 = P({**arms_relaxed(0.15), "SP": vdir(0.06, 1.0, 0.03),
            "NK": vdir(0.0, 1.0, -0.10)}, dy=0.0, lean=0.02)
    return Cycle("sway-idle", 2.0, [(0.0, k0), (0.5, k1), (1.0, k2)])


def _anticipation_stance() -> Cycle:
    # coiled, weight back, quiet arms, breathing sway — NEVER frozen
    k0 = P({**arms_relaxed(-0.05), "SP": vdir(0.0, 1.0, 0.05), "NK": vdir(0, 1, 0.02)},
           dy=-0.01, lean=0.05)
    k1 = P({**arms_relaxed(0.05), "SP": vdir(0.0, 1.0, 0.08), "NK": vdir(0, 1, 0.06)},
           dy=-0.03, lean=0.09)
    return Cycle("anticipation-stance", 2.0, [(0.0, k0), (0.5, k1), (1.0, k0)])


def _walk_cycle() -> Cycle:
    # travelling walk: opposing thigh swing + arm counter-swing, 2-beat (2 steps)
    step = 0.28
    k0 = P({"RU": vdir(0.05, -1.0, -step), "RL": vdir(0.05, -1.0, -step * 0.4),
            "LU": vdir(-0.05, -1.0, step), "LL": vdir(-0.05, -1.0, 0.0),
            **arms_relaxed(-0.5), "SP": vdir(0, 1, 0.03)}, dy=-0.01)
    km = P({"RU": vdir(0.05, -1.0, 0.0), "LU": vdir(-0.05, -1.0, 0.0),
            **arms_relaxed(0.0), "SP": vdir(0, 1, 0.0)}, dy=0.02)
    k1 = P({"RU": vdir(0.05, -1.0, step), "RL": vdir(0.05, -1.0, 0.0),
            "LU": vdir(-0.05, -1.0, -step), "LL": vdir(-0.05, -1.0, -step * 0.4),
            **arms_relaxed(0.5), "SP": vdir(0, 1, 0.03)}, dy=-0.01)
    return Cycle("walk-cycle", 2.0, [(0.0, k0), (0.25, km), (0.5, k1),
                                     (0.75, km), (1.0, k0)])


def _strut_walk() -> Cycle:
    # showman strut: bigger arm swing, slight shoulder roll, chest up
    step = 0.34
    k0 = P({"RU": vdir(0.05, -1.0, -step), "LU": vdir(-0.05, -1.0, step),
            "LL": vdir(-0.05, -1.0, 0.0), "RL": vdir(0.05, -1.0, -0.12),
            **arms_relaxed(-0.7), "SP": vdir(-0.04, 1, -0.02),
            "NK": vdir(0, 1, -0.05)}, dy=0.0)
    km = P({"RU": vdir(0.05, -1.0, 0.0), "LU": vdir(-0.05, -1.0, 0.0),
            **arms_relaxed(0.0), "SP": vdir(0, 1, -0.02)}, dy=0.03)
    k1 = P({"RU": vdir(0.05, -1.0, step), "LU": vdir(-0.05, -1.0, -step),
            "RL": vdir(0.05, -1.0, 0.0), "LL": vdir(-0.05, -1.0, -0.12),
            **arms_relaxed(0.7), "SP": vdir(0.04, 1, -0.02),
            "NK": vdir(0, 1, -0.05)}, dy=0.0)
    return Cycle("strut-walk", 2.0, [(0.0, k0), (0.25, km), (0.5, k1),
                                     (0.75, km), (1.0, k0)])


def _hat_groove() -> Cycle:
    # hands near hat/lapels, head nod + hip pop on the beat, 2-beat
    hands = {"RA": vdir(0.15, -0.35, -0.92), "RF": vdir(-0.05, 0.55, -0.83),
             "RH": vdir(-0.02, 0.85, -0.52),
             "LA": vdir(-0.15, -0.35, -0.92), "LF": vdir(0.05, 0.55, -0.83),
             "LH": vdir(0.02, 0.85, -0.52)}
    k0 = P({**hands, "SP": vdir(-0.05, 1, 0.02), "NK": vdir(0, 1, -0.14)}, dy=0.0)
    k1 = P({**hands, "SP": vdir(0.05, 1, -0.02), "NK": vdir(0, 1, 0.06)}, dy=0.03)
    k2 = P({**hands, "SP": vdir(0.05, 1, 0.02), "NK": vdir(0, 1, -0.14)}, dy=0.0)
    return Cycle("hat-groove", 2.0, [(0.0, k0), (0.5, k1), (1.0, k2)])


def _idle_groove() -> Cycle:
    # signature bounce groove: weight shift + hip pop + head nod + loose arms
    k0 = P({**arms_relaxed(-0.25), "SP": vdir(-0.07, 1, 0.02),
            "NK": vdir(0, 1, -0.12)}, dy=0.0, lean=0.03)
    k1 = P({**arms_relaxed(0.10), "SP": vdir(0.02, 1, -0.02),
            "NK": vdir(0, 1, 0.05)}, dy=0.05, lean=0.0)
    k2 = P({**arms_relaxed(0.25), "SP": vdir(0.07, 1, 0.02),
            "NK": vdir(0, 1, -0.12)}, dy=0.0, lean=0.03)
    return Cycle("idle-groove", 2.0, [(0.0, k0), (0.5, k1), (1.0, k2)])


def _step_touch() -> Cycle:
    # side step-touch, energetic: thigh out + arm accent, 2-beat (L then R)
    out = 0.30
    kL = P({"LU": vdir(-out, -1.0, 0.0), "LL": vdir(-0.05, -1.0, 0.0),
            "RU": vdir(0.10, -1.0, 0.0),
            "RA": vdir(0.55, -0.55, -0.30), "RF": vdir(0.55, -0.30, -0.30),
            "LA": vdir(-0.25, -1.0, 0.05),
            "SP": vdir(0.05, 1, 0.0), "NK": vdir(0, 1, -0.05)}, dy=0.0)
    kc = P({**arms_relaxed(0.0), "SP": vdir(0, 1, 0.0)}, dy=0.05)
    kR = P({"RU": vdir(out, -1.0, 0.0), "RL": vdir(0.05, -1.0, 0.0),
            "LU": vdir(-0.10, -1.0, 0.0),
            "LA": vdir(-0.55, -0.55, -0.30), "LF": vdir(-0.55, -0.30, -0.30),
            "RA": vdir(0.25, -1.0, 0.05),
            "SP": vdir(-0.05, 1, 0.0), "NK": vdir(0, 1, -0.05)}, dy=0.0)
    return Cycle("step-touch", 2.0, [(0.0, kL), (0.25, kc), (0.5, kR),
                                     (0.75, kc), (1.0, kL)])


def _moonwalk_cycle() -> Cycle:
    # left-profile backward glide (video f220.5): 1 step/beat, back foot on toe
    # sliding, front foot flat, ~8deg forward lean, loose counter-swinging arms,
    # level head. Duration 2 beats = one L/R stride. Body yaw (profile) is the
    # timeline's job; here the legs alternate front(-z)/back(+z) in root frame.
    lean = radians(8.0)
    # A: left foot forward flat, right foot back popped onto toe
    A = P({"LU": vdir(-0.05, -1.0, -0.32), "LL": vdir(-0.05, -1.0, -0.05),
           "LT": vdir(0.0, -0.2, -1.0),                      # flat/forward
           "RU": vdir(0.05, -1.0, 0.30), "RL": vdir(0.05, -1.0, 0.18),
           "RT": vdir(0.0, -0.85, -0.55),                    # up on toe
           "RA": vdir(0.18, -1.0, -0.30), "RF": vdir(0.14, -1.0, -0.30),
           "LA": vdir(-0.18, -1.0, 0.30), "LF": vdir(-0.14, -1.0, 0.30),
           "SP": vdir(0.0, 1.0, -0.02), "NK": vdir(0, 1, -0.02)},
          dy=-0.01, lean=lean)
    # mid: feet passing, subtle rise
    M = P({"LU": vdir(-0.05, -1.0, -0.05), "RU": vdir(0.05, -1.0, 0.05),
           "LT": vdir(0.0, -0.5, -0.85), "RT": vdir(0.0, -0.5, -0.85),
           **arms_relaxed(0.0),
           "SP": vdir(0, 1, -0.02)}, dy=0.02, lean=lean)
    # B: right foot forward flat, left foot back popped onto toe
    B = P({"RU": vdir(0.05, -1.0, -0.32), "RL": vdir(0.05, -1.0, -0.05),
           "RT": vdir(0.0, -0.2, -1.0),
           "LU": vdir(-0.05, -1.0, 0.30), "LL": vdir(-0.05, -1.0, 0.18),
           "LT": vdir(0.0, -0.85, -0.55),
           "LA": vdir(-0.18, -1.0, -0.30), "LF": vdir(-0.14, -1.0, -0.30),
           "RA": vdir(0.18, -1.0, 0.30), "RF": vdir(0.14, -1.0, 0.30),
           "SP": vdir(0.0, 1.0, -0.02), "NK": vdir(0, 1, -0.02)},
          dy=-0.01, lean=lean)
    return Cycle("moonwalk-cycle", 2.0, [(0.0, A), (0.25, M), (0.5, B),
                                         (0.75, M), (1.0, A)])


def _wave() -> Cycle:
    # right-hand raised wave, 2-beat side-to-side
    base = {"RA": vdir(0.35, 0.85, -0.20), "RF": vdir(0.55, 0.75, -0.10),
            "RH": vdir(0.65, 0.72, -0.05),
            "LA": vdir(-0.20, -1.0, 0.05), "LF": vdir(-0.16, -1.0, 0.08),
            "NK": vdir(0, 1, -0.03)}
    k0 = P({**base}, dy=0.0)
    k1 = P({**base, "RF": vdir(0.20, 0.90, -0.10), "RH": vdir(0.10, 0.92, -0.05)}, dy=0.02)
    return Cycle("wave", 2.0, [(0.0, k0), (0.5, k1), (1.0, k0)])


# ============================================================================
#  ONE-SHOTS  (accents / poses; duration_beats fixed, no wrap)
# ============================================================================

def _hat_tip() -> OneShot:
    # hand to hat brim + slight lean/turn
    a = P({"RA": vdir(0.20, -0.20, -0.95), "RF": vdir(-0.05, 0.70, -0.70),
           "RH": vdir(-0.02, 0.95, -0.30), "SP": vdir(-0.06, 1, 0.03),
           "NK": vdir(0.05, 1, -0.06)})
    return OneShot("hat-tip", 2.0, [(0.0, a), (1.0, a)],
                   mask={"mixamorig:RightArm", "mixamorig:RightForeArm",
                         "mixamorig:RightHand", "mixamorig:Spine", "mixamorig:Neck"})


def _hat_toss() -> OneShot:
    # right arm flings up/stage-left releasing the hat
    windup = P({"RA": vdir(0.15, -0.30, -0.90), "RF": vdir(0.0, 0.40, -0.90)})
    fling = P({"RA": vdir(-0.55, 0.75, -0.30), "RF": vdir(-0.70, 0.65, -0.10),
               "RH": vdir(-0.80, 0.55, 0.0), "SP": vdir(-0.05, 1, -0.03)})
    settle = P({"RA": vdir(0.20, -1.0, 0.05), "RF": vdir(0.16, -1.0, 0.08)})
    return OneShot("hat-toss", 2.0, [(0.0, windup), (0.4, fling), (1.0, settle)],
                   mask={"mixamorig:RightArm", "mixamorig:RightForeArm",
                         "mixamorig:RightHand", "mixamorig:Spine"})


def _mic_down() -> OneShot:
    # reach forward/down to place mic on the stand
    reach = P({"RA": vdir(0.15, -0.65, -0.75), "RF": vdir(0.05, -0.55, -0.83),
               "RH": vdir(0.0, -0.50, -0.86), "SP": vdir(0, 1, 0.06)}, lean=0.06)
    back = P({"RA": vdir(0.20, -1.0, 0.05), "RF": vdir(0.16, -1.0, 0.08)})
    return OneShot("mic-down", 2.0, [(0.0, back), (0.5, reach), (1.0, back)],
                   mask={"mixamorig:RightArm", "mixamorig:RightForeArm",
                         "mixamorig:RightHand", "mixamorig:Spine"})


def _hip_thrust() -> OneShot:
    # sharp pelvis accent: quick dip + lean, snap back. Uses dy + lean + spine.
    hit = P({"SP": vdir(0.0, 1.0, -0.10), "NK": vdir(0, 1, 0.05)}, dy=-0.04, lean=-0.05)
    rest = P({"SP": vdir(0, 1, 0.0)}, dy=0.0, lean=0.0)
    return OneShot("hip-thrust", 1.0, [(0.0, rest), (0.35, hit), (1.0, rest)],
                   mask={"mixamorig:Spine", "mixamorig:Neck"})


def _arm_point() -> OneShot:
    # sharp right-arm point out/forward (the "Billie Jean" point)
    pt = P({"RA": vdir(0.55, 0.15, -0.82), "RF": vdir(0.55, 0.10, -0.83),
            "RH": vdir(0.55, 0.08, -0.83), "NK": vdir(0.10, 1, -0.05)})
    rest = P({"RA": vdir(0.20, -1.0, 0.05), "RF": vdir(0.16, -1.0, 0.08)})
    # onset/release widened so the arm's point + return swings stay <45 deg/frame
    return OneShot("arm-point", 1.0, [(0.0, rest), (0.4, pt), (0.6, pt), (1.0, rest)],
                   mask={"mixamorig:RightArm", "mixamorig:RightForeArm",
                         "mixamorig:RightHand", "mixamorig:Neck"})


def _kick_snap() -> OneShot:
    # quick right-leg kick forward + snap back
    kick = P({"RU": vdir(0.05, -0.70, -0.72), "RL": vdir(0.05, -0.80, -0.55),
              "RT": vdir(0.0, -0.4, -0.9)})
    rest = P({"RU": vdir(0.05, -1.0, 0.0), "RL": vdir(0.05, -1.0, 0.0)})
    return OneShot("kick-snap", 1.0, [(0.0, rest), (0.4, kick), (1.0, rest)],
                   mask={"mixamorig:RightUpLeg", "mixamorig:RightLeg", "mixamorig:RightFoot"})


def _crotch_grab() -> OneShot:
    # right hand snaps to center + accent, spine crunch
    grab = P({"RA": vdir(0.10, -0.75, -0.65), "RF": vdir(-0.20, -0.35, -0.92),
              "RH": vdir(-0.30, -0.30, -0.90), "SP": vdir(0, 1, 0.08)}, dy=-0.02, lean=0.05)
    rest = P({"RA": vdir(0.20, -1.0, 0.05), "RF": vdir(0.16, -1.0, 0.08), "SP": vdir(0, 1, 0)})
    return OneShot("crotch-grab", 1.0, [(0.0, rest), (0.3, grab), (0.75, grab), (1.0, rest)],
                   mask={"mixamorig:RightArm", "mixamorig:RightForeArm",
                         "mixamorig:RightHand", "mixamorig:Spine"})


def _spin() -> OneShot:
    # spin body pose: arms tuck in, one leg crossed — yaw itself is the timeline.
    tuck = P({"RA": vdir(0.10, -0.55, -0.83), "RF": vdir(-0.25, -0.10, -0.96),
              "LA": vdir(-0.10, -0.55, -0.83), "LF": vdir(0.25, -0.10, -0.96),
              "RU": vdir(0.10, -1.0, -0.10), "LU": vdir(-0.20, -1.0, 0.05),
              "SP": vdir(0, 1, 0.0)}, dy=0.02)
    return OneShot("spin", 2.0, [(0.0, tuck), (1.0, tuck)],
                   mask={s for s in _SHORT.values()} - {"mixamorig:Neck"})


def _toe_freeze() -> OneShot:
    # up on toes, body held tall for a beat
    rise = P({"RT": vdir(0.0, -0.9, -0.45), "LT": vdir(0.0, -0.9, -0.45),
              "SP": vdir(0, 1, -0.03), "NK": vdir(0, 1, -0.05)}, dy=0.06)
    return OneShot("toe-freeze", 1.0, [(0.0, rise), (1.0, rise)],
                   mask={"mixamorig:LeftFoot", "mixamorig:RightFoot",
                         "mixamorig:Spine", "mixamorig:Neck"})


def _crouch_freeze() -> OneShot:
    # low crouch accent (f222-style): knees bend, weight down, arms drawn in
    cr = P({"RU": vdir(0.12, -1.0, -0.30), "RL": vdir(0.12, -1.0, 0.35),
            "LU": vdir(-0.12, -1.0, -0.30), "LL": vdir(-0.12, -1.0, 0.35),
            "RA": vdir(0.15, -0.60, -0.78), "RF": vdir(-0.10, -0.20, -0.97),
            "LA": vdir(-0.15, -0.60, -0.78), "LF": vdir(0.10, -0.20, -0.97),
            "SP": vdir(0, 1, 0.10)}, dy=-0.12, lean=0.10)
    return OneShot("crouch-freeze", 2.0, [(0.0, cr), (1.0, cr)],
                   mask={s for s in _SHORT.values()})


def _toe_stand() -> OneShot:
    # video t=240-245: quick rise onto toes, arms come up in a V, held with a
    # micro-tremble, then a beat-timed drop with a knee bounce.
    down = P({**arms_relaxed(0.0)}, dy=0.0)
    rise = P({"RT": vdir(0.0, -0.92, -0.40), "LT": vdir(0.0, -0.92, -0.40),
              "RA": vdir(0.45, 0.80, -0.20), "RF": vdir(0.40, 0.85, -0.15),
              "RH": vdir(0.35, 0.90, -0.10),
              "LA": vdir(-0.45, 0.80, -0.20), "LF": vdir(-0.40, 0.85, -0.15),
              "LH": vdir(-0.35, 0.90, -0.10),
              "SP": vdir(0, 1, -0.04), "NK": vdir(0, 1, -0.08)}, dy=0.09)
    trem = P({"RT": vdir(0.0, -0.92, -0.40), "LT": vdir(0.0, -0.92, -0.40),
              "RA": vdir(0.47, 0.79, -0.20), "RF": vdir(0.42, 0.84, -0.15),
              "LA": vdir(-0.47, 0.79, -0.20), "LF": vdir(-0.42, 0.84, -0.15),
              "SP": vdir(0, 1, -0.04), "NK": vdir(0, 1, -0.08)}, dy=0.095)
    bounce = P({"RU": vdir(0.05, -1.0, -0.10), "RL": vdir(0.05, -1.0, 0.20),
                "LU": vdir(-0.05, -1.0, -0.10), "LL": vdir(-0.05, -1.0, 0.20),
                **arms_relaxed(0.0)}, dy=-0.06)
    return OneShot("toe-stand", 4.0,
                   [(0.0, down), (0.12, rise), (0.45, trem), (0.72, rise),
                    (0.85, bounce), (1.0, down)],
                   mask={s for s in _SHORT.values()})


def _finale_pose() -> OneShot:
    # arms thrown wide, chest up, on toes — the hit
    hit = P({"RA": vdir(0.70, 0.55, -0.45), "RF": vdir(0.75, 0.50, -0.40),
             "RH": vdir(0.78, 0.48, -0.38),
             "LA": vdir(-0.70, 0.55, -0.45), "LF": vdir(-0.75, 0.50, -0.40),
             "LH": vdir(-0.78, 0.48, -0.38),
             "RT": vdir(0.0, -0.90, -0.45), "LT": vdir(0.0, -0.90, -0.45),
             "SP": vdir(0, 1, -0.05), "NK": vdir(0, 1, -0.10)}, dy=0.07)
    return OneShot("finale-pose", 2.0, [(0.0, hit), (1.0, hit)],
                   mask={s for s in _SHORT.values()})


def _bow() -> OneShot:
    # deep forward bow at the waist
    bow = P({"SP": vdir(0.0, 0.35, -0.94), "NK": vdir(0, 0.4, -0.9),
             "RA": vdir(0.20, -0.85, -0.45), "RF": vdir(0.16, -0.85, -0.45),
             "LA": vdir(-0.20, -0.85, -0.45), "LF": vdir(-0.16, -0.85, -0.45)},
            lean=0.45)
    up = P({**arms_relaxed(0.0), "SP": vdir(0, 1, 0), "NK": vdir(0, 1, 0)})
    return OneShot("bow", 4.0, [(0.0, up), (0.5, bow), (1.0, up)],
                   mask={s for s in _SHORT.values()})


# ---- partial-body overlay holds -------------------------------------------
def _mic_hold_R() -> OneShot:
    a = P(mic_hold_R())
    return OneShot("mic-hold-R", 1.0, [(0.0, a), (1.0, a)],
                   mask={"mixamorig:RightArm", "mixamorig:RightForeArm",
                         "mixamorig:RightHand"},
                   env=lambda p: 1.0)


def _pocket_L() -> OneShot:
    # left hand tucked toward the hip/pocket
    a = P({"LA": vdir(-0.20, -0.75, -0.10), "LF": vdir(-0.05, -0.55, -0.30),
           "LH": vdir(0.05, -0.50, -0.35)})
    return OneShot("pocket-L", 1.0, [(0.0, a), (1.0, a)],
                   mask={"mixamorig:LeftArm", "mixamorig:LeftForeArm",
                         "mixamorig:LeftHand"}, env=lambda p: 1.0)


def _head_look(side: str) -> OneShot:
    z = -0.30 if side == "L" else -0.30
    x = -0.55 if side == "L" else 0.55
    a = P({"NK": vdir(x, 1.0, z)})
    return OneShot(f"head-look-{side}", 2.0, [(0.0, a), (1.0, a)],
                   mask={"mixamorig:Neck"}, env=lambda p: 1.0)


# ============================================================================
CYCLES: Dict[str, object] = {}
for _c in (_sway_idle(), _anticipation_stance(), _walk_cycle(), _strut_walk(),
           _hat_groove(), _idle_groove(), _step_touch(), _moonwalk_cycle(), _wave(),
           _hat_tip(), _hat_toss(), _mic_down(), _hip_thrust(), _arm_point(),
           _kick_snap(), _crotch_grab(), _spin(), _toe_freeze(), _crouch_freeze(),
           _toe_stand(), _finale_pose(), _bow(),
           _mic_hold_R(), _pocket_L(), _head_look("L"), _head_look("R")):
    CYCLES[_c.name] = _c

__all__ = ["CYCLES"]
