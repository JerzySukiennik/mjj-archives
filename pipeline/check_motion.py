#!/usr/bin/env python3
"""Validation gates for the baked motion (coordinator spec):
  - max root speed <= 2.0 m/s (<= 3.0 m/s inside moonwalk 217-228 s)
  - no teleport > 0.12 m/frame
  - no freeze > 1.0 s (near-zero bone motion)
  - moonwalk net travel >= 4.5 m (217-228 s)
  - feet mean |y| < 5 cm (FK lowest foot vs floor)
  - yaw steps <= 120 deg/frame
Exits non-zero when a gate fails.
"""
import os, json, sys
import numpy as np
import qutil as Q

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, "pipeline", "work")
OUT  = os.path.join(ROOT, "public", "concerts", "motown25-billiejean", "billiejean.motion.json")

m = json.load(open(OUT))
fps = m["fps"]; F = m["frameCount"]
bones = m["bones"]
hp = np.array(bones["mixamorig:Hips"]["pos"]).reshape(-1,3)
hr = np.array(bones["mixamorig:Hips"]["rot"]).reshape(-1,4)
skel = json.load(open(os.path.join(WORK, "skeleton.json")))
nodes = skel["nodes"]
hpq = np.array(skel["hipsParentWorldQuat"]); hpp = np.array(skel["hipsParentWorldPos"])
posScale = float(nodes["mixamorig:Hips"]["localTranslation"][1] / nodes["mixamorig:Hips"]["restWorldPos"][1])
M2U = 0.01 * posScale     # world metres per baked unit

fails = []
def gate(name, ok, detail):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}")
    if not ok: fails.append(name)

# ---- root speed / teleports (world lateral X) ----
x = hp[:,0] * M2U
dx = np.abs(np.diff(x)) * fps          # m/s
mw = np.zeros(F-1, bool); mw[int(217*fps):int(228*fps)] = True
gate("root speed (outside moonwalk)", dx[~mw].max() <= 2.0 + 1e-6,
     f"max {dx[~mw].max():.2f} m/s (limit 2.0)")
gate("root speed (moonwalk)", (dx[mw].max() if mw.any() else 0) <= 3.0 + 1e-6,
     f"max {dx[mw].max():.2f} m/s (limit 3.0)")
step = np.abs(np.diff(x))
gate("no teleports", step.max() <= 0.12, f"max step {step.max()*100:.1f} cm/frame (limit 12)")

# ---- freeze detection: total bone rotation rate ----
names = [b for b in m["boneNames"] if b != "mixamorig:Hips"]
qs = {b: np.array(bones[b]["rot"]).reshape(-1,4) for b in names}
rate = np.zeros(F-1)
for b in names:
    q = qs[b]
    d = np.abs(np.einsum('ij,ij->i', q[1:], q[:-1]))
    rate += 2*np.degrees(np.arccos(np.clip(d, -1, 1)))
frozen = rate < 2.0                     # <2 deg total across 16 bones/frame
runs = []; i = 0
while i < F-1:
    if frozen[i]:
        j = i
        while j < F-1 and frozen[j]: j += 1
        runs.append((i/fps, (j-i)/fps)); i = j
    else: i += 1
longest = max([d for _, d in runs], default=0.0)
gate("no freeze >1.0s", longest <= 1.0,
     f"longest near-still span {longest:.2f} s ({len(runs)} spans <2deg/frame)")

# ---- moonwalk travel ----
i0, i1 = int(217*fps), int(228*fps)
net = abs(x[i1] - x[i0])
gate("moonwalk net travel", net >= 4.5, f"|x({228})-x({217})| = {net:.2f} m (min 4.5)")

# ---- feet grounding (FK) ----
parent = {b: nodes[b]["parent"] for b in nodes}
bindT = {b: np.array(nodes[b]["localTranslation"], float) for b in nodes}
bindR = {b: np.array(nodes[b]["localRotation"], float) for b in nodes}
order = []
def visit(b):
    if b in order: return
    if parent[b] in nodes: visit(parent[b])
    order.append(b)
for b in nodes: visit(b)
def qmat(q):
    x_,y_,z_,w_ = q; n=(x_*x_+y_*y_+z_*z_+w_*w_)**0.5 or 1.0
    x_,y_,z_,w_ = x_/n,y_/n,z_/n,w_/n
    return np.array([[1-2*(y_*y_+z_*z_),2*(x_*y_-z_*w_),2*(x_*z_+y_*w_)],
                     [2*(x_*y_+z_*w_),1-2*(x_*x_+z_*z_),2*(y_*z_-x_*w_)],
                     [2*(x_*z_-y_*w_),2*(y_*z_+x_*w_),1-2*(x_*x_+y_*y_)]])
def Mm(t,q):
    mm=np.eye(4); mm[:3,:3]=qmat(q); mm[:3,3]=t; return mm
FEET = ["mixamorig:LeftFoot","mixamorig:LeftToeBase","mixamorig:RightFoot","mixamorig:RightToeBase"]
def rot_of(b, i):
    if b == "mixamorig:Hips": return hr[i]
    if b in qs: return qs[b][i]
    return bindR[b]
# Replicate the runtime formula: footWorldY (rel. floor) =
#   restY + M2U*z_baked + fRel, where fRel = lowest-foot-below-hips from FK
# of the POSE ONLY (hips at origin), converted native-cm -> metres.
restY = float(nodes["mixamorig:Hips"]["restWorldPos"][1])
root = Mm(hpp, hpq)
idxs = range(0, F, 3)                   # stride 3 for speed
mf = []
for i in idxs:
    W = {}
    for b in order:
        lp = np.zeros(3) if b == "mixamorig:Hips" else bindT[b]
        loc = Mm(lp, rot_of(b, i))
        W[b] = root@loc if b == "mixamorig:Hips" else W[parent[b]]@loc
    hy = W["mixamorig:Hips"][1,3]
    fRel = (min(W[b][1,3] for b in FEET) - hy) * 0.01
    mf.append(restY + M2U*hp[i,2] + fRel)
mf = np.array(mf)
gate("feet grounding", abs(mf.mean()) < 0.05,
     f"lowest-foot y mean {mf.mean()*100:+.1f} cm, min {mf.min()*100:+.1f}, max {mf.max()*100:+.1f}")

# ---- yaw steps ----
def fwd_yaw(q):
    x_,y_,z_,w_ = q
    return np.arctan2(2*(x_*z_+w_*y_), 1-2*(x_*x_+y_*y_))
yaws = np.array([fwd_yaw(Q.qmul(hpq, hr[i])) for i in range(F)])
dy = np.degrees(np.abs(np.diff(np.unwrap(yaws))))
gate("yaw steps", dy.max() <= 120.0, f"max {dy.max():.1f} deg/frame (limit 120)")

# ---- extra report: root speed at Jurek's repro timestamps ----
for t in [8, 91, 202, 210]:
    i = int(t*fps)
    seg = dx[max(0,i-45):i+45]
    print(f"  repro t={t:>3d}s: local max root speed {seg.max():.2f} m/s")

print("RESULT:", "ALL GREEN" if not fails else f"FAILED: {fails}")
sys.exit(0 if not fails else 1)
