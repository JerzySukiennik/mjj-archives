#!/usr/bin/env python3
"""Step 2-4: Retarget MediaPipe world landmarks onto the Mixamo skeleton, clean, bake.
Inputs : pipeline/work/pose-raw.npz, pipeline/work/skeleton.json
Outputs: public/concerts/motown25-billiejean/billiejean.motion.json
         pipeline/work/unusable-spans.json
         pipeline/work/retarget-cache.npz (quats+pos+conf for validation/markers)
"""
import os, json
import numpy as np
from scipy.signal import savgol_filter
import qutil as Q


# ---- yaw / grounding helpers -------------------------------------------------
def quat_forward_yaw(q):
    """Heading (radians) of a quaternion: yaw of its rotated +Z axis in the XZ plane."""
    x, y, z, w = q
    # rotate (0,0,1) by q -> forward vector
    fx = 2 * (x * z + w * y)
    fz = 1 - 2 * (x * x + y * y)
    return np.arctan2(fx, fz)

def axis_y_quat(angle):
    """Quaternion (xyzw) for a rotation of `angle` rad about the +Y (world up) axis."""
    return np.array([0.0, np.sin(angle / 2.0), 0.0, np.cos(angle / 2.0)])

def hampel(x, win=7, n_sig=3.0):
    """Hampel filter: replace outliers (|x-median|>n_sig*1.4826*MAD) by the local median.
    Returns filtered copy + boolean mask of replaced samples."""
    x = x.astype(float).copy()
    n = len(x); out = x.copy(); mask = np.zeros(n, bool)
    k = win // 2
    for i in range(n):
        a = max(0, i - k); b = min(n, i + k + 1)
        seg = x[a:b]
        med = np.median(seg)
        mad = np.median(np.abs(seg - med))
        sigma = 1.4826 * mad
        if sigma > 1e-9 and abs(x[i] - med) > n_sig * sigma:
            out[i] = med; mask[i] = True
    return out, mask

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, "pipeline", "work")
OUTDIR = os.path.join(ROOT, "public", "concerts", "motown25-billiejean")
POSE = os.path.join(WORK, "pose-raw.npz")
SKEL = os.path.join(WORK, "skeleton.json")

# MediaPipe landmark indices
NOSE=0; L_SH=11; R_SH=12; L_EL=13; R_EL=14; L_WR=15; R_WR=16
L_IDX=19; R_IDX=20; L_HIP=23; R_HIP=24; L_KN=25; R_KN=26
L_AN=27; R_AN=28; L_FT=31; R_FT=32

def C(v):
    """MediaPipe world/normalized -> model space (Y-up, meters). proper rotation (x,y flip)."""
    return np.array([-v[...,0], -v[...,1], v[...,2]]).T if v.ndim>1 else np.array([-v[0],-v[1],v[2]])

# Bone -> (start_lm, end_lm, child_bone_for_rest_dir). Hips handled separately.
LIMB_MAP = {
    "mixamorig:LeftShoulder": (None, L_SH, "mixamorig:LeftArm"),   # dir shouldersMid->L_SH (special start)
    "mixamorig:LeftArm":      (L_SH, L_EL, "mixamorig:LeftForeArm"),
    "mixamorig:LeftForeArm":  (L_EL, L_WR, "mixamorig:LeftHand"),
    "mixamorig:LeftHand":     (L_WR, L_IDX, "mixamorig:LeftHandMiddle1"),
    "mixamorig:RightShoulder":(None, R_SH, "mixamorig:RightArm"),
    "mixamorig:RightArm":     (R_SH, R_EL, "mixamorig:RightForeArm"),
    "mixamorig:RightForeArm": (R_EL, R_WR, "mixamorig:RightHand"),
    "mixamorig:RightHand":    (R_WR, R_IDX, "mixamorig:RightHandMiddle1"),
    "mixamorig:LeftUpLeg":    (L_HIP, L_KN, "mixamorig:LeftLeg"),
    "mixamorig:LeftLeg":      (L_KN, L_AN, "mixamorig:LeftFoot"),
    "mixamorig:LeftFoot":     (L_AN, L_FT, "mixamorig:LeftToeBase"),
    "mixamorig:RightUpLeg":   (R_HIP, R_KN, "mixamorig:RightLeg"),
    "mixamorig:RightLeg":     (R_KN, R_AN, "mixamorig:RightFoot"),
    "mixamorig:RightFoot":    (R_AN, R_FT, "mixamorig:RightToeBase"),
    "mixamorig:Spine":        (None, None, None),   # torso up special
    "mixamorig:Neck":         (None, None, None),   # head up special
}
# Bones we output rotations for (mapped + a few bind-follow spine bones for hierarchy)
OUTPUT_BONES = list(LIMB_MAP.keys())

def main():
    d = np.load(POSE)
    world = d["world"]; norm = d["norm"]; conf = d["conf"]; times = d["times"]
    fps = float(d["sample_fps"]); dur = float(d["duration"])
    F = world.shape[0]
    skel = json.load(open(SKEL))
    nodes = skel["nodes"]
    restPos = {b: np.array(nodes[b]["restWorldPos"]) for b in nodes}
    restQuat = {b: np.array(nodes[b]["restWorldQuat"]) for b in nodes}
    localBind = {b: np.array(nodes[b]["localRotation"]) for b in nodes}
    parentName = {b: nodes[b]["parent"] for b in nodes}
    hipsParentQ = np.array(skel["hipsParentWorldQuat"])

    GOOD = conf > 0.5

    # ---- camera-shot gating (v9) ----
    # MediaPipe reports HIGH confidence on close-up shots even though the lower
    # body is out of frame and the legs are hallucinated -> tangled full-body
    # poses that pass the conf gate. The broadcast cut list knows the framing:
    # trust full-body pose only in medium/wide/side shots; close-ups and
    # crowd/establishing shots are forced into the donor-fill path.
    CAM = os.path.join(OUTDIR, "camera-track.json")
    try:
        shots = json.load(open(CAM))["shots"]
        UNTRUSTED = {"close-face", "close-feet", "establishing"}
        n_shot = 0
        for k, sh in enumerate(shots):
            t0 = float(sh["t"])
            t1 = float(shots[k+1]["t"]) if k+1 < len(shots) else dur
            if sh.get("type") in UNTRUSTED:
                a, b = int(t0*fps), min(F, int(t1*fps)+1)
                # never demote the moonwalk window (217-228 s): the footwork
                # there is the showpiece and the mocap is visibly readable even
                # in tighter framings — donor legs would ruin it.
                MW_A, MW_B = int(217*fps), int(228*fps)
                for i2 in range(a, b):
                    if MW_A <= i2 < MW_B: continue
                    if GOOD[i2]: n_shot += 1
                    GOOD[i2] = False
        print(f"camera-shot gating: {n_shot} conf-passing frames in close/establishing shots demoted to donor-fill")
    except FileNotFoundError:
        print("camera-shot gating: camera-track.json not found, skipped")

    # ---- temporal outlier rejection ----
    # Reject "good" frames whose core world landmarks jump implausibly vs the last
    # accepted frame (wide/crowd shots where MediaPipe grabs a wrong or mangled body).
    CORE = [0,11,12,23,24,25,26,27,28]
    last = None
    n_rej = 0
    for i in range(F):
        if not GOOD[i]:
            continue
        if last is not None:
            dt = (i - last) / fps
            d = float(np.mean(np.linalg.norm(world[i][CORE] - world[last][CORE], axis=1)))
            # allow ~3 m/s mean landmark speed, floor of 0.45 m for cut jumps
            if d > max(0.45, 3.0 * dt):
                GOOD[i] = False
                n_rej += 1
                continue
        last = i
    # second pass: kill short good islands (< 8 frames ~ 0.27s) — usually spurious
    # detections inside wide/crowd shots that would poison gap blending.
    i = 0
    while i < F:
        if GOOD[i]:
            j = i
            while j < F and GOOD[j]: j += 1
            if (j - i) < 8:
                GOOD[i:j] = False
            i = j
        else:
            i += 1
    print(f"outlier rejection: removed {n_rej} jump frames; good now {GOOD.mean()*100:.1f}%")

    # ---- per-frame retarget ----
    quats = {b: np.zeros((F,4), np.float32) for b in OUTPUT_BONES}
    hips_pos = np.zeros((F,3), np.float32)
    hips_quat = np.zeros((F,4), np.float32)
    hips_global = np.zeros((F,4), np.float32)   # world-space hips orientation (pre local-convert)

    # rest torso reference
    r_hipR = restPos["mixamorig:RightUpLeg"]; r_hipL = restPos["mixamorig:LeftUpLeg"]
    rest_right = r_hipR - r_hipL
    rest_shMid = 0.5*(restPos["mixamorig:LeftArm"]+restPos["mixamorig:RightArm"])
    rest_hipMid = 0.5*(r_hipR+r_hipL)
    rest_up = rest_shMid - rest_hipMid

    restY = restPos["mixamorig:Hips"][1]

    for i in range(F):
        if not GOOD[i]:
            continue
        P = C(world[i])            # (33,3) model space, hip-centered
        shMid = 0.5*(P[L_SH]+P[R_SH]); hipMid = 0.5*(P[L_HIP]+P[R_HIP])
        # hips global via frame align
        meas_right = P[R_HIP]-P[L_HIP]
        meas_up = shMid - hipMid
        Ralign = Q.frame_align(rest_right, rest_up, meas_right, meas_up)
        Ghip = Q.qmul(Ralign, restQuat["mixamorig:Hips"])
        hips_global[i] = Ghip                               # store world hips; local convert later
        hips_quat[i] = Q.qmul(Q.qconj(hipsParentQ), Ghip)   # local = inv(parentRest)*Ghip

        Gmeas = {"mixamorig:Hips": Ghip}

        def measured_dir(bone):
            s,e,ch = LIMB_MAP[bone]
            if bone == "mixamorig:Spine":
                return shMid - hipMid
            if bone == "mixamorig:Neck":
                return P[NOSE] - shMid
            if s is None:  # shoulder clavicle: shouldersMid -> joint
                return P[e] - shMid
            return P[e]-P[s]

        def rest_dir(bone):
            s,e,ch = LIMB_MAP[bone]
            if bone == "mixamorig:Spine":
                return restPos["mixamorig:Neck"]-restPos["mixamorig:Spine"]
            if bone == "mixamorig:Neck":
                return restPos["mixamorig:Head"]-restPos["mixamorig:Neck"]
            return restPos[ch]-restPos[bone]

        for bone in OUTPUT_BONES:
            dM = measured_dir(bone); dR = rest_dir(bone)
            if np.linalg.norm(dM) < 1e-5:
                quats[bone][i] = localBind[bone]; continue
            swing = Q.from_to(dR, dM)
            Gb = Q.qmul(swing, restQuat[bone])
            Gmeas[bone] = Gb
            pn = parentName[bone]
            Gp = Gmeas.get(pn, restQuat.get(pn, np.array([0,0,0,1.0])))
            local = Q.qmul(Q.qconj(Gp), Gb)
            quats[bone][i] = Q.qnorm(local)

        # hips translation: vertical bob from leg compression + lateral from normalized hip x
        ankMidY = 0.5*(P[L_AN][1]+P[R_AN][1])      # negative (below hips)
        legSpan = hipMid[1]-ankMidY
        hips_pos[i,1] = restY   # base; adjust after (needs ref) -> store legSpan in z temp
        hips_pos[i,0] = legSpan   # temp store
        # lateral from normalized landmark hip center x (image 0..1)
        nx = 0.5*(norm[i,L_HIP,0]+norm[i,R_HIP,0])
        hips_pos[i,2] = nx        # temp store

    # ---- fill gaps by slerp between good neighbors ----
    good_idx = np.where(GOOD)[0]
    if len(good_idx)==0:
        raise SystemExit("No good frames detected!")
    def nearest_good(i):
        # returns (prev, next) good indices
        pos = np.searchsorted(good_idx, i)
        nxt = good_idx[pos] if pos < len(good_idx) else good_idx[-1]
        prv = good_idx[pos-1] if pos > 0 else good_idx[0]
        return prv, nxt

    for i in range(F):
        if GOOD[i]: continue
        prv, nxt = nearest_good(i)
        if prv==nxt:
            t=0.0
        else:
            gap = nxt - prv
            if gap <= int(0.5*fps):
                t=(i-prv)/gap            # short gap: straight interpolation
            else:
                # long gap: hold last good pose, blend to next only in final 0.5s
                blend = int(0.5*fps)
                k = i - (nxt - blend)
                t = 0.0 if k < 0 else k/blend
                t = t*t*(3-2*t)          # smoothstep
        for bone in OUTPUT_BONES:
            quats[bone][i] = Q.slerp(quats[bone][prv], quats[bone][nxt], t)
        hips_quat[i] = Q.slerp(hips_quat[prv], hips_quat[nxt], t)
        hips_global[i] = Q.slerp(hips_global[prv], hips_global[nxt], t)
        hips_pos[i,0] = hips_pos[prv,0]*(1-t)+hips_pos[nxt,0]*t
        hips_pos[i,2] = hips_pos[prv,2]*(1-t)+hips_pos[nxt,2]*t

    # =====================================================================
    # MOTION-GRAPH GAP FILL (limb quats) — "MJ keeps dancing" through the
    # unusable spans. For every bad span longer than 0.4 s, instead of holding
    # the last good pose, borrow a HIGH-CONFIDENCE mocap segment whose start/
    # end poses are closest to the span's boundary poses, splice it in and
    # crossfade 0.5 s at both ends (and at chunk joins when a long gap needs
    # more than one donor — different donors per chunk, no robotic looping).
    # Root position/orientation are NOT taken from donors (handled separately).
    # =====================================================================
    XFADE = int(0.5*fps)
    INTRO_END_F = int(16.5*fps)      # spoken/vamp intro: MJ stands at the mic
    SPEECH_END_F = int(88.0*fps)     # whole spoken section: at the mic until the bass hits (~89.4)
    CALM_THR = 70.0                  # deg/frame summed over 16 bones (song median ~65)
    def pose_dist(ia, ib):
        d = 0.0
        for b in OUTPUT_BONES:
            d += 1.0 - abs(float(np.dot(quats[b][ia], quats[b][ib])))
        return d
    # per-frame summed bone angular speed on GOOD frame pairs (for calm-donor test)
    raw_rate = np.full(F-1, np.nan)
    for b in OUTPUT_BONES:
        q = quats[b]
        dd = np.abs(np.einsum('ij,ij->i', q[1:], q[:-1]))
        a = 2*np.degrees(np.arccos(np.clip(dd, -1, 1)))
        valid = GOOD[1:] & GOOD[:-1]
        raw_rate[valid] = np.where(np.isnan(raw_rate[valid]), a[valid], raw_rate[valid]+a[valid])
    def window_calm(s, L):
        seg = raw_rate[s:s+L-1]
        v = seg[~np.isnan(seg)]
        return len(v) > 0.5*(L-1) and float(np.mean(v)) < CALM_THR
    # good runs (start,len) for donor search
    runs = []
    i = 0
    while i < F:
        if GOOD[i]:
            j = i
            while j < F and GOOD[j]: j += 1
            runs.append((i, j-i)); i = j
        else: i += 1
    max_run = max(l for _, l in runs)
    def best_donor(L, pose_a, pose_b, exclude_start=None, calm_only=False):
        """Best good window of length L: min pose distance to boundary frames.
        calm_only restricts to low-angular-velocity windows (intro gap fill)."""
        best = None; best_c = 1e18
        for (s, l) in runs:
            if l < L: continue
            for st in range(s, s+l-L+1, 4):
                if exclude_start is not None and abs(st-exclude_start) < L//2: continue
                if calm_only and not window_calm(st, L): continue
                c = pose_dist(st, pose_a) + pose_dist(st+L-1, pose_b)
                if c < best_c: best_c = c; best = st
        if best is None and calm_only:                      # relax rather than fail
            return best_donor(L, pose_a, pose_b, exclude_start, calm_only=False)
        return best
    bad_spans = []
    i = 0
    while i < F:
        if not GOOD[i]:
            j = i
            while j < F and not GOOD[j]: j += 1
            bad_spans.append((i, j)); i = j
        else: i += 1
    n_graph = 0
    for (a, b) in bad_spans:
        L = b - a
        if L <= int(0.4*fps): continue                     # short gaps: slerp is fine
        prv, nxt = nearest_good(a)
        # chunk the gap so each chunk fits inside an available good run
        chunk_max = min(max_run - 2, int(6*fps))
        starts = list(range(a, b, chunk_max))
        prev_donor = None
        fill = {bone: np.empty((L,4), np.float32) for bone in OUTPUT_BONES}
        for ci, cs in enumerate(starts):
            ce = min(cs + chunk_max, b)
            CL = ce - cs
            don = best_donor(CL, prv if ci == 0 else prv, nxt, exclude_start=prev_donor,
                             calm_only=(a < SPEECH_END_F))
            if don is None:                                 # pathological; keep slerp
                for bone in OUTPUT_BONES:
                    fill[bone][cs-a:ce-a] = quats[bone][cs:ce]
                continue
            prev_donor = don
            for bone in OUTPUT_BONES:
                seg = quats[bone][don:don+CL]
                if ci > 0:                                  # crossfade chunk join
                    W = min(XFADE, CL)
                    for k in range(CL):
                        if k < W:
                            t = 0.5 - 0.5*np.cos(np.pi*k/W)   # 0->1
                            fill[bone][cs-a+k] = Q.slerp(fill[bone][cs-a-1], seg[k], t)
                        else:
                            fill[bone][cs-a+k] = seg[k]
                else:
                    fill[bone][cs-a:ce-a] = seg
        # boundary crossfades: ease out of pose[prv], ease into pose[nxt]
        Win = min(XFADE, L); Wout = min(XFADE, L)
        for bone in OUTPUT_BONES:
            for k in range(L):
                q = fill[bone][k]
                if k < Win:
                    t = 0.5 - 0.5*np.cos(np.pi*(k+1)/Win)
                    q = Q.slerp(quats[bone][prv], q, t)
                if k >= L - Wout:
                    t = 0.5 - 0.5*np.cos(np.pi*(L-k)/Wout)  # 1 at k=L-W .. ->0 at end
                    q = Q.slerp(quats[bone][nxt], q, t)
                quats[bone][a+k] = Q.qnorm(np.asarray(q, float))
        n_graph += 1
    print(f"motion-graph fill: {n_graph}/{len(bad_spans)} spans donor-filled (xfade {XFADE} fr)")

    # ---- SPEECH-SECTION POSE ANCHOR (v9): through 0-88 s the real MJ stands
    # upright at the mic. Mocap there is a mix of decent frames, mangled
    # medium-shot detections and donor fills — rate caps alone just freeze bad
    # silhouettes. Extract a canonical upright pose from a verified-good window
    # (t=2..6 s matches the video: standing at the mic) and pull every
    # speech-section frame toward it. 40% of the mocap's own motion survives as
    # natural life; spine/neck are pinned harder to kill the hunch. The blend
    # ramps out over the last 1.5 s so the song section takes over seamlessly.
    RAMP = int(1.5*fps)
    # pick the single most-UPRIGHT calm good frame in the whole take as the
    # anchor: spine+neck local rotation closest to the bind pose (straight back
    # in the Mixamo T-pose), i.e. minimal hunch. A fixed time window can't be
    # trusted — the early mocap is itself bent.
    def bind_dev(i):
        dev = 0.0
        for b in ("mixamorig:Spine", "mixamorig:Neck"):
            dev += 1.0 - abs(float(np.dot(quats[b][i], localBind[b] / np.linalg.norm(localBind[b]))))
        return dev
    cand = [i for i in range(F) if GOOD[i] and i < F-1 and not np.isnan(raw_rate[i]) and raw_rate[i] < CALM_THR]
    if not cand: cand = [i for i in range(F) if GOOD[i]]
    i_star = min(cand, key=bind_dev)
    print(f"pose anchor frame: t={i_star/fps:.2f}s (bind-dev {bind_dev(i_star):.4f})")
    anchor = {b: quats[b][i_star].copy() for b in OUTPUT_BONES}
    STRONG = {"mixamorig:Spine", "mixamorig:Neck"}
    for b in OUTPUT_BONES:
        w0 = 0.75 if b in STRONG else 0.6
        q = quats[b]
        for i in range(min(SPEECH_END_F, F)):
            w = w0
            if i > SPEECH_END_F - RAMP:
                w = w0 * (SPEECH_END_F - i) / RAMP     # ramp out into the song
            q[i] = np.asarray(Q.slerp(q[i], anchor[b], w), np.float32)
    print(f"speech-section pose anchor: frames 0-{SPEECH_END_F} pulled to upright mic pose (w=0.6/0.75)")

    # ---- INTRO limb angular-velocity soft cap (0-16.5 s): MJ stands at the
    # mic and talks/poses; low-conf mocap garbage + energetic content must not
    # survive as wild swings. Sequential per-bone rate limiter — small natural
    # gestures (<5 deg/frame/bone = 150 deg/s) pass through untouched.
    # Two regimes: hard cap in the strict intro (0-16.5s), moderate cap for the
    # rest of the spoken section (16.5-88s) — gestures survive, flails don't.
    n_capped = 0
    for b in OUTPUT_BONES:
        q = quats[b]
        for i in range(1, min(SPEECH_END_F, F)):
            cap = np.radians(5.0) if i < INTRO_END_F else np.radians(8.0)
            d = float(np.dot(q[i], q[i-1]))
            qq = q[i] if d >= 0 else -q[i]
            ang = 2*np.arccos(min(1.0, abs(d)))
            if ang > cap:
                q[i] = np.asarray(Q.slerp(q[i-1], qq, cap/ang), np.float32)
                n_capped += 1
    print(f"speech-section rate cap: {n_capped} bone-frames limited (5/8 deg/frame)")

    # keep the raw temp stores (legSpan in [,0], normalized hip-x in [,2])
    nxArr = hips_pos[:,2].copy()

    def smooth(a, w, poly=2):
        w = min(w, len(a) - (1-len(a)%2))
        if w<5 or w%2==0: w=max(5,(w//2)*2+1)
        if w>=len(a): return a
        return savgol_filter(a, w, poly)

    # =====================================================================
    # DEFECT 1 + 3 — hips ORIENTATION rebuilt from landmark geometry.
    #
    # Facing (yaw) comes from the measured body-forward = cross(hipRight, up)
    # per frame — NOT from an integrated yaw-rate (v3's cumsum drifted, which
    # left long sections facing -Z). Verified against extracted video frames:
    # at t=110/155/250 (frontal) measured fz ~ +0.9; at t=222 (moonwalk, left
    # profile) measured fx ~ -0.93. Known limitation: when MJ genuinely turns
    # his BACK to the camera (e.g. ~95 s) MediaPipe mirror-flips and reports a
    # frontal pose — undetectable here (face-landmark visibility is ~1.0
    # everywhere), so back-facing spans render as front-facing.
    #
    # Continuity: shortest-path unwrap across good frames + hampel on the yaw
    # signal (kills single-frame flips, preserves genuine sustained spins like
    # 181.8 s), then interpolation over the gap frames. No cumsum => no drift.
    #
    # DEFECT 2 (new) — tilt soft-clamp: hips pitch/roll limited to a plausible
    # upright band (35 deg, tanh soft) so bad mocap spans (t~12 s stumble,
    # t~209 s horizontal body) can never put the model on the floor, while
    # moderate genuine leans survive.
    # =====================================================================
    # measured up/forward per frame in model space (vectorized C())
    Pm = np.stack([-world[...,0], -world[...,1], world[...,2]], axis=-1)  # (F,33,3)
    up_m  = 0.5*(Pm[:,L_SH]+Pm[:,R_SH]) - 0.5*(Pm[:,L_HIP]+Pm[:,R_HIP])
    rgt_m = Pm[:,R_HIP] - Pm[:,L_HIP]
    fwd_m = np.cross(rgt_m, up_m)
    fn = np.linalg.norm(fwd_m, axis=1, keepdims=True); fn[fn<1e-9]=1
    fwd_m /= fn
    un = np.linalg.norm(up_m, axis=1, keepdims=True); un[un<1e-9]=1
    up_m /= un

    good_list = list(good_idx)
    # continuous yaw over GOOD frames (shortest-path unwrap between samples)
    yaw_g = np.zeros(len(good_list))
    prev = None
    for k, gi in enumerate(good_list):
        y = np.arctan2(fwd_m[gi,0], fwd_m[gi,2])
        if prev is None:
            yaw_g[k] = y
        else:
            dlt = (y - prev + np.pi) % (2*np.pi) - np.pi
            yaw_g[k] = yaw_g[k-1] + dlt
        prev = (yaw_g[k] + np.pi) % (2*np.pi) - np.pi
    # hampel on the yaw signal itself: ramps (real spins) keep their local
    # median; isolated flip spikes get replaced.
    yaw_g, n_yaw_out = (lambda r: (r[0], int(r[1].sum())))(hampel(yaw_g, win=11, n_sig=3.0))
    # interpolate yaw + up-vector to ALL frames, then light smoothing
    idx_all = np.arange(F)
    yaw_all = np.interp(idx_all, np.array(good_list, float), yaw_g)
    yaw_all = smooth(yaw_all, 9)

    # --- moonwalk yaw rail: keep him in LEFT PROFILE (facing -X, yaw=-pi/2)
    # during the glide so the authored backward travel reads correctly.
    # 70% pull toward profile, 0.5 s ramps, glide window only.
    MW_T0, MW_T1 = 217.5, 227.5
    mw_a, mw_b = int(MW_T0*fps), int(MW_T1*fps)
    ramp = int(0.5*fps)
    target = -np.pi/2
    for i in range(max(0, mw_a-ramp), min(F, mw_b+ramp)):
        if i < mw_a:   w = (i-(mw_a-ramp))/ramp
        elif i > mw_b: w = ((mw_b+ramp)-i)/ramp
        else:          w = 1.0
        w *= 0.7
        d = (target - yaw_all[i] + np.pi) % (2*np.pi) - np.pi
        yaw_all[i] = yaw_all[i] + w*d
    up_all = np.zeros((F,3))
    for c in range(3):
        up_all[:,c] = np.interp(idx_all, np.array(good_list, float), up_m[good_list, c])
        up_all[:,c] = smooth(up_all[:,c], 9)
    n = np.linalg.norm(up_all, axis=1, keepdims=True); n[n<1e-9]=1
    up_all /= n

    # tilt soft clamp (35 deg, tanh knee)
    TILT_MAX = np.radians(35.0)
    Yup = np.array([0.0,1.0,0.0])
    n_tilt_clamped = 0
    for i in range(F):
        u = up_all[i]
        cosT = np.clip(u[1], -1.0, 1.0)
        theta = np.arccos(cosT)
        if theta > 1e-4:
            th2 = TILT_MAX * np.tanh(theta / TILT_MAX)
            if theta > TILT_MAX: n_tilt_clamped += 1
            horiz = u - u[1]*Yup
            hn = np.linalg.norm(horiz)
            horiz = horiz/hn if hn > 1e-9 else np.array([0.0,0.0,1.0])
            up_all[i] = np.cos(th2)*Yup + np.sin(th2)*horiz

    # rebuild hips orientation: yaw sets heading exactly, tilt from clamped up
    for i in range(F):
        psi = yaw_all[i]
        fwd_h = np.array([np.sin(psi), 0.0, np.cos(psi)])
        u = up_all[i]
        r = np.cross(u, fwd_h)
        rn = np.linalg.norm(r)
        r = r/rn if rn > 1e-9 else np.array([1.0,0.0,0.0])
        Ralign = Q.frame_align(rest_right, rest_up, r, u)
        G0 = Q.qmul(Ralign, restQuat["mixamorig:Hips"])
        # enforce heading EXACTLY on the runtime's probe axis (hips local +Z):
        psi0 = quat_forward_yaw(G0)
        G = Q.qmul(axis_y_quat(psi - psi0), G0)
        hips_global[i] = G
        hips_quat[i]   = Q.qmul(Q.qconj(hipsParentQ), G)        # world -> local
    print(f"yaw rebuild: {n_yaw_out} hampel outliers replaced, {n_tilt_clamped} frames tilt-clamped (>{np.degrees(TILT_MAX):.0f} deg)")

    # ---- automated facing assertion: 90-130 s high-confidence frames must
    # face the audience (+Z). Video frames at 110/155 confirm frontal there.
    tsec = idx_all / fps
    w = (tsec >= 90) & (tsec <= 130) & GOOD
    fz_check = np.array([quat_forward_yaw(hips_global[i]) for i in np.where(w)[0]])
    mean_fz = float(np.mean(np.cos(fz_check)))
    print(f"facing check 90-130s: mean fz={mean_fz:.3f} over {w.sum()} good frames")
    assert mean_fz > 0.4, f"facing check FAILED: mean fz={mean_fz:.3f} <= 0.4"

    # ---- light Savitzky-Golay on quats (win 7, poly 2) + renormalize ----
    def filt_quat(arr):
        out = arr.copy()
        for i in range(1,F):
            if np.dot(out[i], out[i-1]) < 0:
                out[i] = -out[i]
        if F >= 9:
            for c in range(4):
                out[:,c] = savgol_filter(out[:,c], 7, 2)
        n = np.linalg.norm(out, axis=1, keepdims=True); n[n<1e-9]=1
        return (out/n).astype(np.float32)
    for bone in OUTPUT_BONES:
        quats[bone] = filt_quat(quats[bone])
    hips_quat = filt_quat(hips_quat)

    # =====================================================================
    # DEFECT 2 — GROUNDING. FK the FINAL pose per frame (same convention as
    # validate.py) and drop the hips so the lowest foot joint touches the
    # floor. Runtime maps baked-Z -> world vertical at 0.01*posScale m/unit,
    # and rest hips sit restY above the stage, so:
    #     footWorldY = objY + restY + 0.01*s*z_b + fRel   (fRel = foot-below-hips, m)
    #     -> z_b = -(restY + fRel) / (0.01*s)   to put the lowest foot on the floor.
    # =====================================================================
    bindT = {b: np.array(nodes[b]["localTranslation"], float) for b in nodes}
    hipsParentP = np.array(skel["hipsParentWorldPos"])
    fk_order = []
    def _visit(b):
        if b in fk_order: return
        p = parentName[b]
        if p in nodes: _visit(p)
        fk_order.append(b)
    for b in nodes: _visit(b)
    def _qmat(q):
        x,y,z,w=q; n=(x*x+y*y+z*z+w*w)**0.5 or 1.0; x,y,z,w=x/n,y/n,z/n,w/n
        return np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
                         [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],
                         [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
    def _M(t,q):
        m=np.eye(4); m[:3,:3]=_qmat(q); m[:3,3]=t; return m
    FEET = ["mixamorig:LeftFoot","mixamorig:LeftToeBase",
            "mixamorig:RightFoot","mixamorig:RightToeBase"]
    def local_rot(b, i):
        if b == "mixamorig:Hips": return hips_quat[i]
        if b in quats:             return quats[b][i]
        return localBind[b]
    root = _M(hipsParentP, hipsParentQ)
    fRel = np.zeros(F)                     # metres, lowest foot joint below the hips
    for i in range(F):
        W={}
        for b in fk_order:
            lp = np.zeros(3) if b=="mixamorig:Hips" else bindT[b]   # hips at origin: measure shape only
            loc = _M(lp, local_rot(b,i))
            W[b] = root@loc if b=="mixamorig:Hips" else W[parentName[b]]@loc
        hy = W["mixamorig:Hips"][1,3]
        fmin = min(W[b][1,3] for b in FEET)
        fRel[i] = (fmin - hy) * 0.01       # native cm -> metres
    posScale = float(nodes["mixamorig:Hips"]["localTranslation"][1] / restY)  # bindY/restY
    M2U = 0.01 * posScale                   # world metres per baked unit
    # fRel is a per-frame FK estimate and jitters with pose noise/donor blends;
    # every downstream signal (z_b AND the floor clamp) must use a smoothed
    # version, otherwise the floor clamp re-injects the very spikes the rate
    # limiter removes (np.maximum against a jittery z_floor = unlimited vz).
    fRel = savgol_filter(fRel, 11, 2)
    z_b = -(restY + fRel) / M2U
    # clamp hips vertical excursion to a physical range (rest grounding is ~z0);
    # blocks a bad-frame pose from slamming the hips through the floor.
    z0 = float(np.median(z_b))
    z_b = np.clip(z_b, z0 - 0.55/M2U, z0 + 0.30/M2U)
    # ---- VERTICAL PHYSICS (v9): the per-frame contact solve has no temporal
    # constraint, so pose jitter + donor blends made the hips bounce at up to
    # 4 m/s ("flying"). Order: smooth (0.4 s), then rate-limit |vz|<=0.8 m/s as
    # the final pass, then a floor-clamp relaxation — feet must not sink, so
    # where the limited Z would push the lowest foot below -2 cm we raise the
    # hips just enough (landing-style corrections may briefly exceed 0.8 m/s
    # but stay well under the 1.5 m/s gate).
    z_b = smooth(z_b, 13)                   # ~0.4 s
    VZ = (0.8/fps) / M2U                    # baked units per frame
    z_floor = (-0.02 - restY - fRel) / M2U  # min z so lowest foot >= -2 cm (fRel smoothed)
    for _pass in range(3):
        z_b = np.maximum(z_b, z_floor)      # keep feet at/above the floor
        for i in range(1, F):               # rate limit LAST so the output is physical
            d = z_b[i] - z_b[i-1]
            if d > VZ:   z_b[i] = z_b[i-1] + VZ
            elif d < -VZ: z_b[i] = z_b[i-1] - VZ

    # =====================================================================
    # DEFECT 4 — LATERAL STAGE TRAVEL from the normalized hip-x trajectory.
    # Moderate smoothing (keeps walks/moonwalk), map to metres, clip to stage.
    # After the 180 facing flip the lateral sense is mirrored, so negate.
    # =====================================================================
    # PHYSICAL ROOT ("random flying" fix):
    #  1. anchor the trajectory on HIGH-CONFIDENCE frames only;
    #  2. in bad spans FREEZE the root (hold last confident x), then ease to
    #     the next confident anchor over >=1 s (smoothstep) — limbs keep
    #     dancing via the motion-graph fill while the root stays planted;
    #  3. robust smoothing (~0.8 s savgol) + hard speed clamp 2.0 m/s
    #     (3.0 m/s inside the moonwalk glide window);
    #  4. moonwalk 217.5-227.5 s: authored backward glide, net ~5 m in the
    #     +X direction (he faces -X / left profile there; moonwalk = travel
    #     opposite facing), eased in/out, blended with mocap at both ends.
    lat_raw = nxArr.copy()
    # ROOT ANCHORS: only good frames inside runs >= 1 s. Short good islands
    # (mostly wide/crowd shots between cuts, each with different framing)
    # produce nx jumps that read as "flying" — the root must not chase them.
    ANCH = np.zeros(F, bool)
    for (s, l) in runs:
        if l >= int(1.0*fps): ANCH[s:s+l] = True
    anch_idx = np.where(ANCH)[0]
    if len(anch_idx) == 0: anch_idx = good_idx
    lat = lat_raw.copy()
    # freeze + ease across every NON-anchor span
    i = 0
    while i < F:
        if not ANCH[i]:
            j = i
            while j < F and not ANCH[j]: j += 1
            p = np.searchsorted(anch_idx, i)
            prv = anch_idx[p-1] if p > 0 else anch_idx[0]
            nxt = anch_idx[p] if p < len(anch_idx) else anch_idx[-1]
            g = j - i
            E = min(g, max(int(1.0*fps), g//3))      # ease >=1 s (or whole gap)
            for k2 in range(i, j):
                k = k2 - (j - E)
                if k < 0:
                    lat[k2] = lat_raw[prv]           # frozen root
                else:
                    t = (k+1)/E; t = t*t*(3-2*t)
                    lat[k2] = lat_raw[prv]*(1-t) + lat_raw[nxt]*t
            i = j
        else: i += 1
    from scipy.signal import medfilt
    lat = medfilt(lat, 45)                           # 1.5 s: kills cut-jump wobble
    lat = smooth(lat, 25)                            # ~0.8 s robust smoothing
    # INTRO: root fully planted at the mic (video ground truth: he is already
    # at the mic at t=0.5 and stands there through the spoken intro). Constant
    # equal to the first post-intro value => seamless at the boundary.
    lat[:min(SPEECH_END_F, F)] = lat[min(SPEECH_END_F, F-1)]
    # camera sits at +Z looking -Z => screen-right == world +X; normalized-x
    # grows to screen-right, so the gain is POSITIVE.
    lat = (lat - np.median(lat)) * 12.0              # normalized drift -> metres
    lat = np.clip(lat, -4.0, 4.0)                    # stage half-width ~4 m

    # moonwalk glide override (world metres). Glide window = exactly 217-228 s
    # (the validation-gate window) so the measured NET travel is the full GL.
    # Approach segment eases the root to the glide start BEFORE 217 s; return
    # blend eases back to mocap after 228 s.
    GL = 5.0                                          # net backward travel (m)
    gl_a, gl_b = int(217*fps), int(228*fps)
    x_start, x_end = -1.4, -1.4 + GL                  # within +/-4 stage bounds
    appW = int(2.5*fps)
    for k in range(appW):                             # approach: mocap -> x_start
        i = gl_a - appW + k
        if i < 0: continue
        t = (k+1)/appW; t = t*t*(3-2*t)
        lat[i] = lat[i]*(1-t) + x_start*t
    for i in range(gl_a, min(gl_b+1, F)):             # the glide itself
        u = (i - gl_a) / max(1, (gl_b - gl_a))
        e = u*u*(3-2*u)                               # ease-in/out
        lat[i] = x_start + GL*e
    retW = int(1.5*fps)
    for k in range(retW):                             # return: x_end -> mocap
        i = gl_b + 1 + k
        if i >= F: break
        t = (k+1)/retW; t = t*t*(3-2*t)
        lat[i] = x_end*(1-t) + lat[i]*t

    # smoothing already applied; now the HARD speed clamp is the FINAL pass
    # (nothing after it may re-introduce overshoot).
    lat = np.clip(lat, -4.0, 4.0)
    vmax = np.full(F, 1.9/fps)                        # m/frame (margin under 2.0)
    vmax[gl_a:gl_b] = 2.9/fps                         # only INSIDE the gate window
    for i in range(1, F):
        d = lat[i] - lat[i-1]
        lim = vmax[i]
        if d > lim:   lat[i] = lat[i-1] + lim
        elif d < -lim: lat[i] = lat[i-1] - lim
    x_b = lat / (0.01 * posScale)                    # metres -> baked units

    hips_pos[:,0] = x_b                               # already rate-limited: DO NOT re-smooth
    hips_pos[:,1] = restY                             # depth channel: hold rest (drives posScale)
    hips_pos[:,2] = z_b                               # already smoothed+rate-limited: DO NOT re-smooth

    # ---- unusable spans (conf<0.5 contiguous > 0.5s) ----
    spans=[]
    i=0
    thr_frames=int(0.5*fps)
    while i<F:
        if not GOOD[i]:
            j=i
            while j<F and not GOOD[j]: j+=1
            if (j-i) > thr_frames:
                spans.append({"start": round(i/fps,3), "end": round(j/fps,3),
                              "frames": int(j-i), "type": "held/blended (mocap unusable)"})
            i=j
        else: i+=1
    json.dump({"note":"conf<0.5 for >0.5s; filled by slerp-blend between good poses; hand-key later",
               "spans":spans}, open(os.path.join(WORK,"unusable-spans.json"),"w"), indent=1)

    # ---- bake motion json ----
    def flat(a): return [round(float(x),5) for x in a.reshape(-1)]
    bones_out = {"mixamorig:Hips": {"pos": flat(hips_pos), "rot": flat(hips_quat)}}
    for bone in OUTPUT_BONES:
        bones_out[bone] = {"rot": flat(quats[bone])}
    motion = {
        "fps": fps, "duration": round(dur,3), "frameCount": F,
        "boneNames": ["mixamorig:Hips"]+OUTPUT_BONES,
        "bones": bones_out,
        "confidence": [round(float(c),3) for c in conf],
    }
    outpath = os.path.join(OUTDIR, "billiejean.motion.json")
    json.dump(motion, open(outpath,"w"), separators=(",",":"))
    # cache for markers/validation
    np.savez_compressed(os.path.join(WORK,"retarget-cache.npz"),
        hips_pos=hips_pos, hips_quat=hips_quat, conf=conf, times=times, fps=fps,
        **{f"q_{b.split(':')[1]}":quats[b] for b in OUTPUT_BONES})

    sz=os.path.getsize(outpath)
    det=float(np.mean(GOOD))
    longest = max([s["frames"] for s in spans], default=0)/fps
    print(f"motion baked: {outpath} ({sz/1e6:.2f} MB), frames={F}")
    print(f"detected(conf>0.5)={det*100:.1f}%  unusable spans={len(spans)}  longest={longest:.1f}s")
    print("spans:", json.dumps(spans))

if __name__ == "__main__":
    main()
