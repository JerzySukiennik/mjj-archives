"""choreo.mocap_layer — optional performance-flavor layer from the real mocap.

Exposes high-confidence LIMB rotations (never hips pos/rot, never root yaw) so
Task 2 can OPTIONALLY blend 50-70% of the real Motown 25 arm/leg flavor over the
authored base where the mocap is trustworthy. Authored motion wins by default.

    windows() -> list[(t0, t1)]  spans with conf>0.6 sustained >=2s, minus the
                                 spans listed in work/unusable-spans.json.
    get_limb_pose(t) -> Pose|None  parent-relative LOCAL limb rotations at time t
                                   (linear-in-index nearest, slerp between the two
                                   bracketing frames); None outside any window.
"""
from __future__ import annotations
import os, json
from typing import List, Optional, Tuple
import numpy as np

from .core import Pose, LIMB_BONES, _PIPELINE  # type: ignore
import qutil as Q

_WORK = os.path.join(_PIPELINE, "work")
_CACHE = os.path.join(_WORK, "retarget-cache.npz")
_UNUSABLE = os.path.join(_WORK, "unusable-spans.json")

_CONF_MIN = 0.6
_SUSTAIN_S = 2.0

# bone -> cache key (q_<shortname>); hips deliberately excluded (limbs only)
_CACHE_KEY = {b: "q_" + b.split(":")[1] for b in LIMB_BONES}


class _Data:
    def __init__(self):
        d = np.load(_CACHE)
        self.times = np.asarray(d["times"], float)
        self.fps = float(d["fps"])
        self.conf = np.asarray(d["conf"], float)
        self.q = {b: np.asarray(d[_CACHE_KEY[b]], float) for b in LIMB_BONES}
        self.F = len(self.times)
        self._windows = self._compute_windows()

    def _compute_windows(self) -> List[Tuple[float, float]]:
        fps = self.fps
        good = self.conf > _CONF_MIN
        need = int(round(_SUSTAIN_S * fps))
        spans: List[Tuple[float, float]] = []
        i = 0
        while i < self.F:
            if good[i]:
                j = i
                while j < self.F and good[j]:
                    j += 1
                if (j - i) >= need:
                    spans.append((self.times[i], self.times[j - 1]))
                i = j
            else:
                i += 1
        # subtract unusable spans
        try:
            unusable = json.load(open(_UNUSABLE))["spans"]
        except Exception:
            unusable = []
        bad = [(s["start"], s["end"]) for s in unusable]
        out: List[Tuple[float, float]] = []
        for (a, b) in spans:
            segs = [(a, b)]
            for (ua, ub) in bad:
                nxt = []
                for (sa, sb) in segs:
                    if ub <= sa or ua >= sb:
                        nxt.append((sa, sb))
                        continue
                    if ua > sa:
                        nxt.append((sa, min(ua, sb)))
                    if ub < sb:
                        nxt.append((max(ub, sa), sb))
                segs = nxt
            for (sa, sb) in segs:
                if sb - sa >= _SUSTAIN_S:
                    out.append((round(sa, 3), round(sb, 3)))
        return out

    def in_window(self, t: float) -> bool:
        return any(a <= t <= b for (a, b) in self._windows)

    def limb_pose(self, t: float) -> Optional[Pose]:
        if not self.in_window(t):
            return None
        # bracketing frames by time
        idx = np.searchsorted(self.times, t)
        i1 = min(max(idx, 1), self.F - 1)
        i0 = i1 - 1
        t0, t1 = self.times[i0], self.times[i1]
        w = 0.0 if t1 <= t0 else float(np.clip((t - t0) / (t1 - t0), 0.0, 1.0))
        rot = {b: Q.slerp(self.q[b][i0], self.q[b][i1], w) for b in LIMB_BONES}
        return Pose(rot, 0.0, 0.0)


_D: Optional[_Data] = None


def _data() -> _Data:
    global _D
    if _D is None:
        _D = _Data()
    return _D


def windows() -> List[Tuple[float, float]]:
    return list(_data()._windows)


def get_limb_pose(t: float) -> Optional[Pose]:
    return _data().limb_pose(float(t))
