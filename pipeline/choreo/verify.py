"""choreo.verify — Task 2: acceptance gates on the baked motion JSON.

    pipeline/venv/bin/python -m choreo.verify

Computes every numeric gate directly from public/.../billiejean.motion.json
and prints a PASS/FAIL report. Pixel checks are run separately in the browser.
"""
from __future__ import annotations
import os, json
import numpy as np

from . import core
from .core import BONES, LIMB_BONES
import qutil as Q

_NODES = core._NODES
_PARENT = core._PARENT
_FK_ORDER = core._FK_ORDER
_RESTY = float(_NODES["mixamorig:Hips"]["restWorldPos"][1])
_POSSCALE = float(_NODES["mixamorig:Hips"]["localTranslation"][1] / _RESTY)
_S = 0.01 * _POSSCALE
_BINDT = {b: np.array(_NODES[b]["localTranslation"], float) for b in _NODES}
_LOCAL_ALL = {b: np.array(_NODES[b]["localRotation"], float) for b in _NODES}
_HIPS_PARENT_Q = np.array(core._SKEL["hipsParentWorldQuat"], float)
_HIPS_LOCAL = np.array(_NODES["mixamorig:Hips"]["localRotation"], float)
_FEET = ["mixamorig:LeftFoot", "mixamorig:LeftToeBase",
         "mixamorig:RightFoot", "mixamorig:RightToeBase"]
_MOTION = os.path.join(os.path.dirname(core._PIPELINE), "public",
                       "concerts", "motown25-billiejean", "billiejean.motion.json")
MW0, MW1 = 218.15, 226.36


def _qmat(q):
    x, y, z, w = q
    n = (x * x + y * y + z * z + w * w) ** 0.5 or 1.0
    x, y, z, w = x / n, y / n, z / n, w / n
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def _M(t, q):
    m = np.eye(4); m[:3, :3] = _qmat(q); m[:3, 3] = t; return m


def main():
    m = json.load(open(_MOTION))
    F = m["frameCount"]; fps = m["fps"]
    assert m["boneNames"] == BONES, "boneNames mismatch!"
    assert F == 8903 and abs(m["duration"] - 296.796) < 1e-3
    hp = np.array(m["bones"]["mixamorig:Hips"]["pos"]).reshape(F, 3)
    hr_local = np.array(m["bones"]["mixamorig:Hips"]["rot"]).reshape(F, 4)
    # world hips orientation = parent * local (yaw/up must be measured in world)
    hr = np.array([Q.qmul(_HIPS_PARENT_Q, q) for q in hr_local])
    limb = {b: np.array(m["bones"][b]["rot"]).reshape(F, 4) for b in LIMB_BONES}
    t = np.arange(F) / fps
    results = []

    def gate(name, ok, detail):
        results.append((name, ok, detail))

    # 1) root speed (lateral metres; depth held) --------------------------------
    xm = hp[:, 0] * _S
    v = np.abs(np.diff(xm)) * fps
    mw = (t[1:] >= MW0) & (t[1:] <= MW1)
    v_out = v[~mw]; v_mw = v[mw]
    gate("root speed <=2.5 m/s (outside moonwalk)", v_out.max() <= 2.5,
         f"max {v_out.max():.2f} @ t={t[1:][~mw][np.argmax(v_out)]:.1f}")
    gate("root speed <=3.5 m/s (moonwalk)", v_mw.max() <= 3.5,
         f"max {v_mw.max():.2f}")

    # 2) moonwalk net travel ----------------------------------------------------
    i0 = int(round(MW0 * fps)); i1 = int(round(MW1 * fps))
    net = abs(xm[i1] - xm[i0])
    gate("moonwalk net travel >=4.5 m", net >= 4.5, f"{net:.2f} m")

    # 3) yaw sanity (<=120 deg/frame) ------------------------------------------
    def fyaw(q):
        x, y, z, w = q.T
        return np.arctan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y))
    yaw = np.unwrap(fyaw(hr))
    dyaw = np.abs(np.diff(np.degrees(yaw)))
    gate("yaw <=120 deg/frame", dyaw.max() <= 120.0,
         f"max {dyaw.max():.1f} @ t={t[1:][np.argmax(dyaw)]:.1f}")
    # profile at moonwalk
    yaw222 = np.degrees(fyaw(hr[int(222 * fps):int(222 * fps) + 1])[0]) % 360
    gate("moonwalk left profile (~ -90/270 deg)", 250 <= yaw222 <= 290,
         f"yaw@222 = {yaw222:.0f} deg")

    # 4) no freeze: every 1.5s window has visible limb motion -------------------
    # per-frame total limb angular delta (deg)
    tot = np.zeros(F)
    for b in LIMB_BONES:
        a = limb[b]
        d = np.abs(np.sum(a[1:] * a[:-1], axis=1)).clip(0, 1)
        tot[1:] += np.degrees(2 * np.arccos(d))
    win = int(round(1.5 * fps))
    csum = np.cumsum(np.concatenate([[0.0], tot]))
    wsum = csum[win:] - csum[:-win]           # motion over each 1.5s window
    THRESH = 8.0                               # deg of summed limb travel / 1.5s
    worst = wsum.min()
    gate("no freeze >1.5s (win motion >= 8 deg)", worst >= THRESH,
         f"min window motion {worst:.1f} deg @ t={t[np.argmin(wsum)]:.1f}")

    # 5) feet grounded: FK lowest foot world height, mean |y| < 5cm ------------
    root = _M(np.zeros(3), _HIPS_PARENT_Q)
    foot_y = np.zeros(F)
    step = 3                                    # subsample for speed
    idxs = range(0, F, step)
    for i in idxs:
        W = {}
        for b in _FK_ORDER:
            if b == "mixamorig:Hips":
                W[b] = root @ _M(np.zeros(3), _HIPS_LOCAL); continue
            lq = limb[b][i] if b in LIMB_BONES else _LOCAL_ALL[b]
            W[b] = W[_PARENT[b]] @ _M(_BINDT[b], lq)
        hy = W["mixamorig:Hips"][1, 3]
        fmin = min(W[b][1, 3] for b in _FEET if b in W)
        fRel = (fmin - hy) * 0.01
        foot_y[i] = _RESTY + _S * hp[i, 2] + fRel   # world height of lowest foot
    fy = foot_y[list(idxs)]
    gate("feet grounded (mean |y| < 5cm)", np.mean(np.abs(fy)) < 0.05,
         f"mean |y| {np.mean(np.abs(fy))*100:.2f} cm, max {np.max(np.abs(fy))*100:.1f} cm")

    # 6) upright: no frame flipped upside down (hips up-axis y-component > 0) ----
    ups = np.array([_qmat(q) @ np.array([0, 1.0, 0]) for q in hr])
    gate("upright (hips up.y > 0.3 all frames)", ups[:, 1].min() > 0.3,
         f"min up.y {ups[:,1].min():.2f}")

    # ---- report --------------------------------------------------------------
    print("=" * 64)
    allok = True
    for name, ok, detail in results:
        allok &= ok
        print(f"[{'PASS' if ok else 'FAIL'}] {name:44s} {detail}")
    print("=" * 64)
    print("ALL GATES PASS" if allok else "SOME GATES FAILED")
    return allok


if __name__ == "__main__":
    import sys
    sys.exit(0 if main() else 1)
