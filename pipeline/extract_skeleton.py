#!/usr/bin/env python3
"""Parse the shipped mj.glb (== soldier.glb) bind/rest pose.
For every mixamorig node compute: parent, local T/R/S, rest global matrix,
rest global position, rest global rotation quaternion.
Output: pipeline/work/skeleton.json
"""
import os, struct, json
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GLB = os.path.join(ROOT, "public", "concerts", "motown25-billiejean", "mj.glb")
OUT = os.path.join(ROOT, "pipeline", "work", "skeleton.json")

def load_glb_json(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, ver, length = struct.unpack("<III", data[:12])
    off = 12
    clen, ctype = struct.unpack("<II", data[off:off+8]); off += 8
    j = json.loads(data[off:off+clen])
    return j

def quat_to_mat(q):
    x, y, z, w = q
    n = (x*x+y*y+z*z+w*w) ** 0.5
    if n == 0: return np.eye(3)
    x,y,z,w = x/n,y/n,z/n,w/n
    return np.array([
        [1-2*(y*y+z*z), 2*(x*y-z*w),   2*(x*z+y*w)],
        [2*(x*y+z*w),   1-2*(x*x+z*z), 2*(y*z-x*w)],
        [2*(x*z-y*w),   2*(y*z+x*w),   1-2*(x*x+y*y)],
    ])

def trs_matrix(t, r, s):
    M = np.eye(4)
    R = quat_to_mat(r)
    M[:3,:3] = R * np.array(s)[None,:]
    M[:3,3] = t
    return M

def mat_to_quat(R):
    m = R
    tr = m[0,0]+m[1,1]+m[2,2]
    if tr > 0:
        S = (tr+1.0)**0.5 * 2
        w = 0.25*S; x=(m[2,1]-m[1,2])/S; y=(m[0,2]-m[2,0])/S; z=(m[1,0]-m[0,1])/S
    elif m[0,0] > m[1,1] and m[0,0] > m[2,2]:
        S = (1.0+m[0,0]-m[1,1]-m[2,2])**0.5*2
        w=(m[2,1]-m[1,2])/S; x=0.25*S; y=(m[0,1]+m[1,0])/S; z=(m[0,2]+m[2,0])/S
    elif m[1,1] > m[2,2]:
        S=(1.0+m[1,1]-m[0,0]-m[2,2])**0.5*2
        w=(m[0,2]-m[2,0])/S; x=(m[0,1]+m[1,0])/S; y=0.25*S; z=(m[1,2]+m[2,1])/S
    else:
        S=(1.0+m[2,2]-m[0,0]-m[1,1])**0.5*2
        w=(m[1,0]-m[0,1])/S; x=(m[0,2]+m[2,0])/S; y=(m[1,2]+m[2,1])/S; z=0.25*S
    q=np.array([x,y,z,w]); return q/np.linalg.norm(q)

def main():
    j = load_glb_json(GLB)
    nodes = j["nodes"]
    N = len(nodes)
    parent = [-1]*N
    for i,n in enumerate(nodes):
        for c in n.get("children", []):
            parent[c] = i
    name = [n.get("name","") for n in nodes]

    local = []
    for n in nodes:
        t = n.get("translation",[0,0,0])
        r = n.get("rotation",[0,0,0,1])
        s = n.get("scale",[1,1,1])
        local.append(trs_matrix(t,r,s))

    # world matrices
    world = [None]*N
    def compute(i):
        if world[i] is not None: return world[i]
        if parent[i] == -1:
            world[i] = local[i]
        else:
            world[i] = compute(parent[i]) @ local[i]
        return world[i]
    for i in range(N): compute(i)

    idx = {name[i]: i for i in range(N)}
    out = {"nodes": {}, "parent_name": {}}
    for i in range(N):
        if not name[i].startswith("mixamorig"): continue
        W = world[i]
        pos = W[:3,3].tolist()
        # orthonormalize rotation (strip scale)
        R = W[:3,:3].copy()
        for c in range(3):
            R[:,c] /= (np.linalg.norm(R[:,c])+1e-12)
        q = mat_to_quat(R).tolist()
        pn = name[parent[i]] if parent[i] != -1 else None
        out["nodes"][name[i]] = {
            "restWorldPos": pos,
            "restWorldQuat": q,
            "localTranslation": nodes[i].get("translation",[0,0,0]),
            "localRotation": nodes[i].get("rotation",[0,0,0,1]),
            "parent": pn,
        }
    # also record parent of Hips (armature root) global quat for reference
    hips = idx.get("mixamorig:Hips")
    ph = parent[hips]
    Wp = world[ph]
    Rp = Wp[:3,:3].copy()
    for c in range(3): Rp[:,c] /= (np.linalg.norm(Rp[:,c])+1e-12)
    out["hipsParentWorldQuat"] = mat_to_quat(Rp).tolist()
    out["hipsParentWorldPos"] = Wp[:3,3].tolist()
    out["hipsParentName"] = name[ph]

    with open(OUT,"w") as f: json.dump(out,f,indent=1)
    # quick report
    print("hips parent:", name[ph], "quat", [round(x,3) for x in out["hipsParentWorldQuat"]])
    for b in ["mixamorig:Hips","mixamorig:Spine","mixamorig:LeftArm","mixamorig:LeftForeArm","mixamorig:LeftUpLeg","mixamorig:LeftLeg","mixamorig:Head"]:
        nd=out["nodes"][b]; print(b, "pos", [round(x,3) for x in nd["restWorldPos"]])
    print("saved", OUT, "bones", len(out["nodes"]))

if __name__ == "__main__":
    main()
