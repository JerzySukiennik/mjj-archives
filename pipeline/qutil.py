"""Quaternion helpers (xyzw convention), numpy."""
import numpy as np

def normalize(v, eps=1e-9):
    n = np.linalg.norm(v)
    return v/n if n > eps else v

def qmul(a, b):
    ax,ay,az,aw = a; bx,by,bz,bw = b
    return np.array([
        aw*bx + ax*bw + ay*bz - az*by,
        aw*by - ax*bz + ay*bw + az*bx,
        aw*bz + ax*by - ay*bx + az*bw,
        aw*bw - ax*bx - ay*by - az*bz,
    ])

def qconj(q):
    return np.array([-q[0],-q[1],-q[2],q[3]])

def qnorm(q, eps=1e-12):
    n = np.linalg.norm(q)
    return q/n if n > eps else np.array([0,0,0,1.0])

def from_to(a, b):
    """Shortest-arc rotation mapping unit vector a to unit vector b (xyzw)."""
    a = normalize(np.asarray(a,float)); b = normalize(np.asarray(b,float))
    d = float(np.dot(a,b))
    if d > 0.999999:
        return np.array([0,0,0,1.0])
    if d < -0.999999:
        # 180 deg: pick any perpendicular axis
        axis = np.cross(a, np.array([1.0,0,0]))
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, np.array([0,1.0,0]))
        axis = normalize(axis)
        return np.array([axis[0],axis[1],axis[2],0.0])
    axis = np.cross(a,b)
    q = np.array([axis[0],axis[1],axis[2],1.0+d])
    return qnorm(q)

def mat_to_quat(m):
    tr = m[0,0]+m[1,1]+m[2,2]
    if tr > 0:
        S=(tr+1.0)**0.5*2; w=0.25*S; x=(m[2,1]-m[1,2])/S; y=(m[0,2]-m[2,0])/S; z=(m[1,0]-m[0,1])/S
    elif m[0,0]>m[1,1] and m[0,0]>m[2,2]:
        S=(1.0+m[0,0]-m[1,1]-m[2,2])**0.5*2; w=(m[2,1]-m[1,2])/S; x=0.25*S; y=(m[0,1]+m[1,0])/S; z=(m[0,2]+m[2,0])/S
    elif m[1,1]>m[2,2]:
        S=(1.0+m[1,1]-m[0,0]-m[2,2])**0.5*2; w=(m[0,2]-m[2,0])/S; x=(m[0,1]+m[1,0])/S; y=0.25*S; z=(m[1,2]+m[2,1])/S
    else:
        S=(1.0+m[2,2]-m[0,0]-m[1,1])**0.5*2; w=(m[1,0]-m[0,1])/S; x=(m[0,2]+m[2,0])/S; y=(m[1,2]+m[2,1])/S; z=0.25*S
    return qnorm(np.array([x,y,z,w]))

def slerp(q0, q1, t):
    q0=qnorm(q0); q1=qnorm(q1)
    d=float(np.dot(q0,q1))
    if d<0: q1=-q1; d=-d
    if d>0.9995:
        return qnorm(q0+t*(q1-q0))
    th0=np.arccos(d); s0=np.sin(th0)
    th=th0*t
    return (np.sin(th0-th)/s0)*q0 + (np.sin(th)/s0)*q1

def frame_align(right_r, up_r, right_m, up_m):
    """Rotation mapping rest orthonormal frame (right_r,up_r) to measured (right_m,up_m)."""
    def build(right, up):
        right=normalize(right)
        up=normalize(up - np.dot(up,right)*right)
        fwd=np.cross(right,up)
        return np.column_stack([right,up,fwd])
    Fr=build(right_r,up_r); Fm=build(right_m,up_m)
    R=Fm @ Fr.T
    return mat_to_quat(R)
