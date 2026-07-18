"""choreo.core — cycle library core machinery + module contract.

This package authors Michael-Jackson-style dance motion for the Motown 25
Billie Jean rebuild. Task 1 (this package: core.py / cycles.py / mocap_layer.py
/ preview.py) provides the pose primitives and the authored cycle/one-shot
library. Task 2 (timeline.py / build.py / verify.py) consumes them.

============================  MODULE CONTRACT  ============================
Everything below is the interface Task 2 codes against. Signatures are stable.

BONES : list[str]
    The 17 output-bone names, copied VERBATIM (names + order) from the current
    public/.../billiejean.motion.json "boneNames" (mixamorig: prefix kept;
    runtime strips the colon).  BONES[0] == "mixamorig:Hips".
LIMB_BONES : list[str]
    BONES[1:] — the 16 authorable rotation bones (everything except Hips).
    Poses never carry a Hips rotation: root translation + yaw are the timeline
    layer's job (Poses are ROOT-RELATIVE).
REST_LOCAL : dict[str, np.ndarray(4)]
    Per-bone rest LOCAL rotation quaternion (xyzw), relative to its parent,
    taken from skeleton.json "localRotation". A bone absent from a Pose.rot
    resolves to REST_LOCAL[bone].

@dataclass Pose
    rot  : dict[boneName -> np.ndarray(4) xyzw]  local rotation per bone.
           Missing bone => REST_LOCAL[bone] (rest). Only LIMB_BONES appear.
    dy   : float   hips vertical offset in METERS (default 0). +up.
    lean : float   forward-lean in RADIANS applied to hips/spine at bake
           (default 0). +lean tips the torso toward the audience.
    Helper: Pose.get(bone) -> quat (falls back to REST_LOCAL). Pose.copy().

rest_pose() -> Pose
    Empty pose (all bones at rest, dy=lean=0).

class BeatGrid(bpm=117.0, t0=89.37)
    beats(t)->float   (t-t0)/beat_len          (may be negative before t0)
    time(beat)->float t0 + beat*beat_len
    snap(t)->float    nearest beat time
    bar(t)->float     bar index (4 beats/bar) as float
    .beat_len, .bar_len attributes.
class FreeGrid(period=1.0)
    Same 4 methods, t0=0, "beat"=period seconds (spoken-intro pseudo-grid).

class Cycle(name, duration_beats, keys)
    keys : list[(phase in [0,1], Pose)] sorted by phase; loops (phase wraps).
    sample(phase)->Pose  per-bone slerp between bracketing keys with smoothstep
                         easing; wraps 1->0 so loops are seamless.
class OneShot(Cycle)  (name, duration_beats, keys, mask=None, env=None)
    No wrap (clamps at ends). Adds:
      mask : set[boneName] | None  bones this one-shot drives when overlaid.
             None => all bones present in its keys.
      weight_env(phase)->float in [0,1]  ramp for overlay blending
             (default: smooth ease-in/out hann-like window).
    sample(phase) clamps phase to [0,1] (no wrap).

CYCLES : dict[str, Cycle|OneShot]   exported by cycles.py (imported here-free).

slerp_pose(a: Pose, b: Pose, w: float) -> Pose
    Per-bone quaternion slerp (sign/neighborhood-fixed via qutil.slerp), missing
    bones filled from REST_LOCAL. dy/lean linearly interpolated.
overlay(base: Pose, top: Pose, mask, w: float) -> Pose
    Returns base with the masked bones slerped w toward `top` (a sampled
    one-shot Pose). dy/lean lerped toward top's by w. mask=None -> top.rot keys.

Authoring helpers (used by cycles.py; safe for Task 2 to reuse):
    world_dir(name) -> np.ndarray(3)   named unit direction in the REST/root
        frame. In this frame the performer FACES -Z (audience), performer-RIGHT
        is +X, UP is +Y. The timeline layer yaw-rotates the hips so facing=0
        points at the audience; Poses stay in this fixed rest frame.
    pose_from_world_dirs(targets, dy=0, lean=0) -> Pose
        targets: dict[boneName -> dir3 | ('quat', worldquat)]. Each entry sets
        that bone's world-space long-axis (local +Y) to point along dir3 via a
        shortest-arc swing from its rest world axis; FK then converts to the
        parent-relative LOCAL quats stored in the Pose. Unlisted bones stay at
        rest (and correctly follow any authored parent, e.g. a Spine bend
        carries the arms). Only LIMB_BONES land in Pose.rot.
==========================================================================
"""
from __future__ import annotations
import os, sys, json
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_PIPELINE = os.path.dirname(_HERE)
if _PIPELINE not in sys.path:
    sys.path.insert(0, _PIPELINE)
import qutil as Q  # noqa: E402

# ---------------------------------------------------------------- skeleton load
_SKEL_PATH = os.path.join(_PIPELINE, "work", "skeleton.json")
_SKEL = json.load(open(_SKEL_PATH))
_NODES = _SKEL["nodes"]

# The 17 output bones — verbatim from the current motion JSON boneNames.
BONES: List[str] = [
    "mixamorig:Hips",
    "mixamorig:LeftShoulder", "mixamorig:LeftArm", "mixamorig:LeftForeArm", "mixamorig:LeftHand",
    "mixamorig:RightShoulder", "mixamorig:RightArm", "mixamorig:RightForeArm", "mixamorig:RightHand",
    "mixamorig:LeftUpLeg", "mixamorig:LeftLeg", "mixamorig:LeftFoot",
    "mixamorig:RightUpLeg", "mixamorig:RightLeg", "mixamorig:RightFoot",
    "mixamorig:Spine", "mixamorig:Neck",
]
LIMB_BONES: List[str] = BONES[1:]

REST_LOCAL: Dict[str, np.ndarray] = {
    b: Q.qnorm(np.array(_NODES[b]["localRotation"], float)) for b in BONES
}
# full-skeleton rest data (all nodes, for FK authoring)
_REST_WORLD_Q: Dict[str, np.ndarray] = {
    b: Q.qnorm(np.array(_NODES[b]["restWorldQuat"], float)) for b in _NODES
}
_LOCAL_ROT_ALL: Dict[str, np.ndarray] = {
    b: Q.qnorm(np.array(_NODES[b]["localRotation"], float)) for b in _NODES
}
_PARENT: Dict[str, str] = {b: _NODES[b]["parent"] for b in _NODES}

# parent-first FK order over all skeleton nodes
def _fk_order() -> List[str]:
    order: List[str] = []
    seen: Set[str] = set()
    def visit(b: str):
        if b in seen or b not in _NODES:
            return
        p = _PARENT.get(b)
        if p in _NODES:
            visit(p)
        seen.add(b)
        order.append(b)
    for b in _NODES:
        visit(b)
    return order
_FK_ORDER = _fk_order()


def _qrot(q: np.ndarray, v) -> np.ndarray:
    """Rotate 3-vector v by quaternion q (xyzw)."""
    x, y, z, w = q
    u = np.array([x, y, z], float)
    v = np.asarray(v, float)
    return 2 * np.dot(u, v) * u + (w * w - np.dot(u, u)) * v + 2 * w * np.cross(u, v)


# ------------------------------------------------------------------- directions
# Rest/root frame: performer faces -Z (audience), performer-RIGHT = +X, UP = +Y.
_DIRS: Dict[str, np.ndarray] = {
    "up":        np.array([0.0, 1.0, 0.0]),
    "down":      np.array([0.0, -1.0, 0.0]),
    "fwd":       np.array([0.0, 0.0, -1.0]),   # toward audience
    "back":      np.array([0.0, 0.0, 1.0]),
    "right":     np.array([1.0, 0.0, 0.0]),    # performer's right
    "left":      np.array([-1.0, 0.0, 0.0]),
}
def world_dir(name: str) -> np.ndarray:
    return _DIRS[name].copy()

def vdir(*comps) -> np.ndarray:
    """Normalized direction from raw components (x=right, y=up, z=back)."""
    v = np.asarray(comps, float)
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else np.array([0.0, 1.0, 0.0])


# ------------------------------------------------------------------------- Pose
@dataclass
class Pose:
    rot: Dict[str, np.ndarray] = field(default_factory=dict)
    dy: float = 0.0
    lean: float = 0.0

    def get(self, bone: str) -> np.ndarray:
        q = self.rot.get(bone)
        return q if q is not None else REST_LOCAL[bone]

    def copy(self) -> "Pose":
        return Pose({b: np.array(q, float) for b, q in self.rot.items()},
                    float(self.dy), float(self.lean))


def rest_pose() -> Pose:
    return Pose({}, 0.0, 0.0)


# --------------------------------------------------------- world-dir authoring
def pose_from_world_dirs(targets: Dict[str, object], dy: float = 0.0,
                         lean: float = 0.0) -> Pose:
    """Build a Pose from world-space long-axis targets. See module contract."""
    # 1) resolve each authored bone's WORLD orientation
    posed_world: Dict[str, np.ndarray] = {}
    authored: Set[str] = set()
    for bone, tgt in targets.items():
        if isinstance(tgt, tuple) and tgt and tgt[0] == "quat":
            Gb = Q.qnorm(np.asarray(tgt[1], float))
        else:
            d = np.asarray(tgt, float)
            n = np.linalg.norm(d)
            if n < 1e-9:
                continue
            d = d / n
            rest_axis = _qrot(_REST_WORLD_Q[bone], [0.0, 1.0, 0.0])
            swing = Q.from_to(rest_axis, d)
            Gb = Q.qnorm(Q.qmul(swing, _REST_WORLD_Q[bone]))
        posed_world[bone] = Gb
        authored.add(bone)

    # 2) FK over the whole skeleton: authored bones use their target world quat,
    #    everything else follows rest local off its posed parent. Hips = rest
    #    (root-relative frame; timeline applies yaw/translation later).
    for b in _FK_ORDER:
        if b in authored:
            continue
        if b == "mixamorig:Hips" or _PARENT.get(b) not in posed_world:
            posed_world[b] = _REST_WORLD_Q[b] if b == "mixamorig:Hips" \
                else Q.qmul(posed_world.get(_PARENT.get(b), _REST_WORLD_Q.get(_PARENT.get(b), np.array([0,0,0,1.0]))), _LOCAL_ROT_ALL[b])
        else:
            posed_world[b] = Q.qmul(posed_world[_PARENT[b]], _LOCAL_ROT_ALL[b])

    # 3) extract parent-relative LOCAL quats for the authored limb bones only
    rot: Dict[str, np.ndarray] = {}
    for b in authored:
        if b not in LIMB_BONES:
            continue
        p = _PARENT[b]
        Gp = posed_world.get(p, _REST_WORLD_Q.get(p, np.array([0, 0, 0, 1.0])))
        rot[b] = Q.qnorm(Q.qmul(Q.qconj(Gp), posed_world[b]))
    return Pose(rot, float(dy), float(lean))


# -------------------------------------------------------------------- blend ops
def _smoothstep(t: float) -> float:
    t = min(1.0, max(0.0, t))
    return t * t * (3.0 - 2.0 * t)


def slerp_pose(a: Pose, b: Pose, w: float) -> Pose:
    w = float(w)
    bones = set(a.rot) | set(b.rot)
    rot: Dict[str, np.ndarray] = {}
    for bone in bones:
        qa = a.get(bone)
        qb = b.get(bone)
        rot[bone] = Q.slerp(qa, qb, w)
    dy = a.dy * (1 - w) + b.dy * w
    lean = a.lean * (1 - w) + b.lean * w
    return Pose(rot, dy, lean)


def overlay(base: Pose, top: Pose, mask: Optional[Set[str]], w: float) -> Pose:
    """Blend the masked bones of `top` onto `base` by weight w."""
    w = float(w)
    if w <= 0.0:
        return base.copy()
    out = base.copy()
    bones = mask if mask is not None else set(top.rot.keys())
    for bone in bones:
        if bone not in LIMB_BONES:
            continue
        qb = base.get(bone)
        qt = top.get(bone)
        out.rot[bone] = Q.slerp(qb, qt, w)
    out.dy = base.dy * (1 - w) + top.dy * w
    out.lean = base.lean * (1 - w) + top.lean * w
    return out


# ------------------------------------------------------------------- beat grids
class BeatGrid:
    def __init__(self, bpm: float = 117.0, t0: float = 89.37):
        self.bpm = float(bpm)
        self.t0 = float(t0)
        self.beat_len = 60.0 / self.bpm
        self.bar_len = 4.0 * self.beat_len

    def beats(self, t: float) -> float:
        return (t - self.t0) / self.beat_len

    def time(self, beat: float) -> float:
        return self.t0 + beat * self.beat_len

    def snap(self, t: float) -> float:
        return self.time(round(self.beats(t)))

    def bar(self, t: float) -> float:
        return self.beats(t) / 4.0


class FreeGrid(BeatGrid):
    """Uniform pseudo-grid for the spoken intro (period-second pulse, t0=0)."""
    def __init__(self, period: float = 1.0):
        self.bpm = 60.0 / period
        self.t0 = 0.0
        self.beat_len = float(period)
        self.bar_len = 4.0 * self.beat_len


# ----------------------------------------------------------------- cycle system
class Cycle:
    WRAP = True

    def __init__(self, name: str, duration_beats: float,
                 keys: List[Tuple[float, Pose]]):
        self.name = name
        self.duration_beats = float(duration_beats)
        self.keys = sorted(keys, key=lambda kp: kp[0])
        if not self.keys:
            raise ValueError(f"cycle {name!r} has no keys")

    def sample(self, phase: float) -> Pose:
        keys = self.keys
        if len(keys) == 1:
            return keys[0][1].copy()
        if self.WRAP:
            phase = phase % 1.0
        else:
            phase = min(1.0, max(0.0, phase))
        # find bracketing keys
        if phase <= keys[0][0]:
            if self.WRAP and keys[0][0] > 0.0:
                p0, a = keys[-1]
                p0 -= 1.0
                p1, b = keys[0]
            else:
                return keys[0][1].copy()
        elif phase >= keys[-1][0]:
            if self.WRAP and keys[-1][0] < 1.0:
                p0, a = keys[-1]
                p1, b = keys[0]
                p1 += 1.0
            else:
                return keys[-1][1].copy()
        else:
            i = 0
            while i < len(keys) - 1 and not (keys[i][0] <= phase <= keys[i + 1][0]):
                i += 1
            p0, a = keys[i]
            p1, b = keys[i + 1]
        span = (p1 - p0)
        t = 0.0 if span <= 1e-9 else (phase - p0) / span
        return slerp_pose(a, b, _smoothstep(t))


class OneShot(Cycle):
    WRAP = False

    def __init__(self, name: str, duration_beats: float,
                 keys: List[Tuple[float, Pose]],
                 mask: Optional[Set[str]] = None,
                 env=None):
        super().__init__(name, duration_beats, keys)
        if mask is None:
            m: Set[str] = set()
            for _, p in self.keys:
                m |= set(p.rot.keys())
            mask = m
        self.mask = set(mask)
        self._env = env

    def weight_env(self, phase: float) -> float:
        if self._env is not None:
            return float(self._env(phase))
        # default hann-ish window: ramp up over first 25%, hold, ramp down last 25%
        p = min(1.0, max(0.0, phase))
        if p < 0.25:
            return _smoothstep(p / 0.25)
        if p > 0.75:
            return _smoothstep((1.0 - p) / 0.25)
        return 1.0
