"""choreo.build — Task 2: bake the authored choreography to the motion JSON.

Bakes 8903 frames @30fps (duration 296.796) from timeline.sample_pose /
root_x / root_yaw. Hips pos channels follow the v5 baked convention verbatim:
    X = lateral   = x_metres / (0.01 * posScale)
    Y = depth ref = restY (constant; drives runtime posScale via its median)
    Z = vertical  = grounding drop (+ authored dy), same math as retarget.py
Hips rotation is baked from the authored yaw using retarget.py's proven
frame-align + heading-enforcement (copied verbatim below; no tilt = upright).
Grounding FK is reused from choreo.preview (identical to retarget's pass).

    pipeline/venv/bin/python -m choreo.build
"""
from __future__ import annotations
import os, json
import numpy as np

from . import core
from .core import BONES, LIMB_BONES, REST_LOCAL
from . import timeline as TL
from .preview import _fk_hips_and_feet, _RESTY, _POSSCALE
import qutil as Q

_NODES = core._NODES
_SKEL = core._SKEL
_OUTDIR = os.path.join(os.path.dirname(core._PIPELINE), "public",
                       "concerts", "motown25-billiejean")
_MOTION = os.path.join(_OUTDIR, "billiejean.motion.json")
_MARKERS = os.path.join(_OUTDIR, "markers.json")

FPS = 30.0
FRAME_COUNT = 8903
DURATION = 296.796

# ---- retarget.py yaw/facing helpers (copied verbatim, side-effect-free) ----
_HIPS_PARENT_Q = np.array(_SKEL["hipsParentWorldQuat"], float)
_REST_HIPS_Q = np.array(_NODES["mixamorig:Hips"]["restWorldQuat"], float)
_restPos = {b: np.array(_NODES[b]["restWorldPos"], float) for b in _NODES}
_REST_RIGHT = _restPos["mixamorig:RightUpLeg"] - _restPos["mixamorig:LeftUpLeg"]
_rest_shMid = 0.5 * (_restPos["mixamorig:LeftArm"] + _restPos["mixamorig:RightArm"])
_rest_hipMid = 0.5 * (_restPos["mixamorig:RightUpLeg"] + _restPos["mixamorig:LeftUpLeg"])
_REST_UP = _rest_shMid - _rest_hipMid


def quat_forward_yaw(q):
    x, y, z, w = q
    fx = 2 * (x * z + w * y)
    fz = 1 - 2 * (x * x + y * y)
    return np.arctan2(fx, fz)


def axis_y_quat(angle):
    return np.array([0.0, np.sin(angle / 2.0), 0.0, np.cos(angle / 2.0)])


def _lean_quat(rad):
    return np.array([np.sin(rad / 2.0), 0.0, 0.0, np.cos(rad / 2.0)])


def hips_local_from_yaw(psi: float) -> np.ndarray:
    """Authored heading psi (rad, 0=+Z audience) -> hips LOCAL quat (upright)."""
    fwd_h = np.array([np.sin(psi), 0.0, np.cos(psi)])
    u = np.array([0.0, 1.0, 0.0])
    r = np.cross(u, fwd_h)
    rn = np.linalg.norm(r)
    r = r / rn if rn > 1e-9 else np.array([1.0, 0.0, 0.0])
    Ralign = Q.frame_align(_REST_RIGHT, _REST_UP, r, u)
    G0 = Q.qmul(Ralign, _REST_HIPS_Q)
    psi0 = quat_forward_yaw(G0)
    G = Q.qmul(axis_y_quat(psi - psi0), G0)
    return Q.qmul(Q.qconj(_HIPS_PARENT_Q), G)


# ---------------------------------------------------------------------------
def build():
    F = FRAME_COUNT
    S = 0.01 * _POSSCALE                       # metres -> baked units divisor
    quats = {b: np.zeros((F, 4), np.float32) for b in LIMB_BONES}
    hips_pos = np.zeros((F, 3), np.float32)
    hips_rot = np.zeros((F, 4), np.float32)

    for i in range(F):
        t = i / FPS
        pose = TL.sample_pose(t)
        lean_q = _lean_quat(pose.lean)
        for b in LIMB_BONES:
            q = pose.get(b)
            if b == "mixamorig:Spine":
                q = Q.qmul(lean_q, q)          # make the authored lean visible
            quats[b][i] = Q.qnorm(q)
        # grounding: FK lowest foot below hips (preview pass folds lean in spine)
        hy, feet = _fk_hips_and_feet(pose)
        fmin = min(feet.values()) if feet else hy
        fRel = (fmin - hy) * 0.01              # cm -> m
        z_b = -(_RESTY + fRel) / S + pose.dy / S
        hips_pos[i, 0] = TL.root_x(t) / S      # lateral
        hips_pos[i, 1] = _RESTY                # depth ref (constant)
        hips_pos[i, 2] = z_b                   # grounding vertical
        hips_rot[i] = hips_local_from_yaw(TL.root_yaw(t))

    def flat(a):
        return [round(float(x), 5) for x in a.reshape(-1)]

    bones_out = {"mixamorig:Hips": {"pos": flat(hips_pos), "rot": flat(hips_rot)}}
    for b in LIMB_BONES:
        bones_out[b] = {"rot": flat(quats[b])}
    motion = {
        "fps": FPS, "duration": round(DURATION, 3), "frameCount": F,
        "boneNames": BONES, "bones": bones_out,
        "confidence": [1.0] * F,
    }
    json.dump(motion, open(_MOTION, "w"), separators=(",", ":"))
    sz = os.path.getsize(_MOTION)
    print(f"baked {_MOTION} ({sz/1e6:.2f} MB) frames={F}")
    print(f"  x range   {hips_pos[:,0].min()*S:.2f}..{hips_pos[:,0].max()*S:.2f} m")
    print(f"  z(vert)   {hips_pos[:,2].min():.2f}..{hips_pos[:,2].max():.2f} baked")
    return motion


def update_markers(toe_stand: float = 242.83):
    try:
        m = json.load(open(_MARKERS))
    except Exception:
        m = {"markers": {}, "note": ""}
    m["markers"]["moonwalk"] = round(TL.MOONWALK_T0, 2)
    m["markers"]["toe-stand"] = round(float(toe_stand), 2)
    m["note"] = ("authored choreography rebuild (v6); moonwalk glide start, "
                 "toe-stand frame-verified vs Motown 25 reference")
    json.dump(m, open(_MARKERS, "w"), indent=1)
    print(f"markers updated: moonwalk={m['markers']['moonwalk']} "
          f"toe-stand={m['markers']['toe-stand']}")


if __name__ == "__main__":
    build()
    update_markers()
