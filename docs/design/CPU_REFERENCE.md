# CPU comparison reference

The Owner adopted the current feature-complete CPU cost on 8 November 2026.
The reference is **229.7818 milliseconds of whole-main-thread CPU per completed
dashboard update**, the conventional median of the two completed candidate
readings, 229.0071 and 230.5565. This includes continuous animation CPU between
updates; it is not an update response-time measurement.

The reference applies only to laptop-1366x620, the exact workload digest and
Mac/Chrome/Intel GPU environment in `CPU_REFERENCE` in
`scripts/performance-gate.mjs`. Evidence must supply the measured platform,
browserVersion and gpuRenderer in `cpuReferenceEnvironment`. Missing or different
conditions retain the paired comparison. Do not claim this number as a Pi,
Windows, phone or other-profile calibration.

The existing five-percent relative allowance remains: **241.27089 ms/update**
for that reference. All absolute frame, latency, long-task, transfer, heap,
record-preservation and scenario/sample-count requirements remain unchanged.
Historical baseline measurements and failed evidence are retained without edits.

The calibration is an explicitly adopted two-sample reference, not a completed
qualification campaign. The associated campaign stopped at five of 48 samples.
The Owner separately directed deployment with partial qualification; this is an
operational exception for this candidate, not a performance PASS or a standing
packager bypass. No benchmark was repeated to obtain this reference.
