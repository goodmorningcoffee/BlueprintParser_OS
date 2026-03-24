# Quantity Takeoff — Full Feature Plan

## Phase 1: Count Takeoff (current priority)
See active plan in `.claude/plans/` — shape markers, takeoff panel, CSV export.

## Phase 2: Area Tracing (future)
- Polygon drawing tool (click vertices, double-click to close)
- Scale calibration (click two points on scale bar, enter real distance)
- Area calculation via shoelace formula
- Area annotations stored in `data` jsonb with `type: "polygon"`
- TakeoffPanel extended with area items section

## Phase 3: Local Docker Mode
See `plans/local-docker-mode.md` — self-hosted deployment without AWS.
