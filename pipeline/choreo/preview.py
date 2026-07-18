"""choreo.preview — bake a single named cycle, looped, to a test motion JSON.

Writes a schema-identical clip UNDER pipeline/work/ (never public/) so a cycle
can be eyeballed in the viewer and numerically sanity-checked. Prints per-cycle
max joint angular velocity and the lowest-foot height estimate (grounded FK), so
anatomical breakage (knees/elbows backward, feet through floor) is caught.

    pipeline/venv/bin/python -m choreo.preview <cycle-name> [--secs N] [--bpm B]
    pipeline/venv/bin/python -m choreo.preview --all
"""
from __future__ import annotations
import os, sys, json, argparse
import numpy as np

from . import core
from .core import (BONES, LIMB_BONES, REST_LOCAL, BeatGrid, Pose)
from .cycles import CYCLES
import qutil as Q

_WORK = os.path.join(core._PIPELINE, "work")
_NODES = core._NODES
_PARENT = core._PARENT

_RESTY = float(_NODES["mixamorig:Hips"]["restWorldPos"][1])
_POSSCALE = float(_NODES["mixamorig:Hips"]["localTranslation"][1] / _RESTY)
_FEET = ["mixamorig:LeftFoot", "mixamorig:LeftToeBase",
         "mixamorig:RightFoot", "mixamorig:RightToeBase"]
_BINDT = {b: np.array(_NODES[b]["localTranslation"], float) for b in _NODES}
_LOCAL_ALL = {b: np.array(_NODES[b]["localRotation"], float) for b in _NODES}
_HIPS_PARENT_Q = np.array(core._SKEL["hipsParentWorldQuat"], float)
_HIPS_LOCAL = np.array(_NODES["mixamorig:Hips"]["localRotation"], float)


def _qmat(q):
    x, y, z, w = q
    n = (x * x + y * y + z * z + w * w) ** 0.5 or 1.0
    x, y, z, w = x / n, y / n, z / n, w / n
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def _M(t, q):
    m = np.eye(4)
    m[:3, :3] = _qmat(q)
    m[:3, 3] = t
    return m


def _lean_quat(rad):
    # forward pitch about world +X (tips torso toward -Z audience)
    return np.array([np.sin(rad / 2.0), 0.0, 0.0, np.cos(rad / 2.0)])


def _pose_local(pose: Pose, bone: str):
    q = pose.rot.get(bone)
    return q if q is not None else REST_LOCAL.get(bone, _LOCAL_ALL[bone])


def _fk_hips_and_feet(pose: Pose):
    """FK with hips at origin (rest orientation); return hips Y and per-foot Y
    in native cm (hips-relative shape). lean applies a spine/hips forward pitch."""
    lean = _lean_quat(pose.lean)
    order = core._FK_ORDER
    root = _M(np.zeros(3), _HIPS_PARENT_Q)
    W = {}
    for b in order:
        if b == "mixamorig:Hips":
            # same convention as retarget.py: root(parentQ) @ hips-local
            W[b] = root @ _M(np.zeros(3), _HIPS_LOCAL)
            continue
        if b in LIMB_BONES:
            lq = _pose_local(pose, b)
        else:
            lq = _LOCAL_ALL[b]
        if b == "mixamorig:Spine":
            lq = Q.qmul(lean, lq)  # fold lean into the torso base
        W[b] = W[_PARENT[b]] @ _M(_BINDT[b], lq)
    hy = W["mixamorig:Hips"][1, 3]
    feet = {b: W[b][1, 3] for b in _FEET if b in W}
    return hy, feet


def bake_cycle(name: str, secs: float, bpm: float, fps: float = 30.0):
    if name not in CYCLES:
        raise SystemExit(f"unknown cycle {name!r}; have: {', '.join(sorted(CYCLES))}")
    cyc = CYCLES[name]
    grid = BeatGrid(bpm=bpm, t0=0.0)
    F = int(round(secs * fps))
    dur_beats = cyc.duration_beats

    # sample poses
    poses = []
    for i in range(F):
        t = i / fps
        beat = grid.beats(t)
        phase = (beat / dur_beats) % 1.0 if getattr(cyc, "WRAP", True) else min(1.0, (beat / dur_beats))
        poses.append(cyc.sample(phase))

    # per-bone local quat arrays
    quats = {b: np.zeros((F, 4), np.float32) for b in LIMB_BONES}
    hips_pos = np.zeros((F, 3), np.float32)
    hips_rot = np.zeros((F, 4), np.float32)
    hips_local_rest = np.array(_NODES["mixamorig:Hips"]["localRotation"], float)

    fRel = np.zeros(F)
    for i, p in enumerate(poses):
        for b in LIMB_BONES:
            quats[b][i] = Q.qnorm(_pose_local(p, b))
        hy, feet = _fk_hips_and_feet(p)
        fmin = min(feet.values()) if feet else hy
        fRel[i] = (fmin - hy) * 0.01  # cm -> m, foot below hips
        hips_rot[i] = hips_local_rest

    # grounding: drop hips so lowest foot touches floor (matches retarget math)
    z_b = -(_RESTY + fRel) / (0.01 * _POSSCALE)
    dy = np.array([p.dy for p in poses])
    z_b = z_b + dy / (0.01 * _POSSCALE)
    hips_pos[:, 0] = 0.0
    hips_pos[:, 1] = _RESTY
    hips_pos[:, 2] = z_b

    def flat(a):
        return [round(float(x), 5) for x in a.reshape(-1)]

    bones_out = {"mixamorig:Hips": {"pos": flat(hips_pos), "rot": flat(hips_rot)}}
    for b in LIMB_BONES:
        bones_out[b] = {"rot": flat(quats[b])}
    motion = {
        "fps": fps, "duration": round(F / fps, 3), "frameCount": F,
        "boneNames": BONES, "bones": bones_out,
        "confidence": [1.0] * F,
    }
    outpath = os.path.join(_WORK, f"preview-{name}.motion.json")
    json.dump(motion, open(outpath, "w"), separators=(",", ":"))

    # ---- numeric checks -----------------------------------------------------
    max_av = 0.0
    worst_bone = None
    dt = 1.0 / fps
    for b in LIMB_BONES:
        arr = quats[b]
        for i in range(1, F):
            d = abs(float(np.dot(arr[i], arr[i - 1])))
            d = min(1.0, d)
            ang = 2.0 * np.arccos(d)
            av = ang / dt
            if av > max_av:
                max_av = av
                worst_bone = b
    # after grounding, lowest-foot world height should sit ~0 (on the floor)
    grounded = _RESTY + 0.01 * _POSSCALE * z_b + fRel
    print(f"[{name}] frames={F} dur={F/fps:.2f}s beats/loop={dur_beats}")
    print(f"  wrote {outpath}")
    print(f"  max joint angular vel = {np.degrees(max_av):.1f} deg/s ({worst_bone})")
    print(f"  raw lowest-foot below hips = {fRel.min()*100:.1f} cm  (hips rest {_RESTY:.3f} m)")
    print(f"  grounded lowest-foot height = {grounded.min()*100:.2f}..{grounded.max()*100:.2f} cm (target ~0)")
    return outpath


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cycle", nargs="?", default=None)
    ap.add_argument("--secs", type=float, default=6.0)
    ap.add_argument("--bpm", type=float, default=117.0)
    ap.add_argument("--all", action="store_true")
    a = ap.parse_args()
    if a.all:
        for name in sorted(CYCLES):
            bake_cycle(name, a.secs, a.bpm)
    elif a.cycle:
        bake_cycle(a.cycle, a.secs, a.bpm)
    else:
        print("usage: python -m choreo.preview <cycle-name> [--secs N] [--bpm B] | --all")
        print("cycles:", ", ".join(sorted(CYCLES)))


if __name__ == "__main__":
    main()
