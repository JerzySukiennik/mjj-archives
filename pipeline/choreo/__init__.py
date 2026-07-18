"""choreo — authored MJ dance-cycle library + core machinery (Task 1).

    from choreo.core import BeatGrid, Pose, slerp_pose, overlay
    from choreo.cycles import CYCLES
    from choreo import mocap_layer
"""
from . import core, cycles, mocap_layer  # noqa: F401

__all__ = ["core", "cycles", "mocap_layer"]
