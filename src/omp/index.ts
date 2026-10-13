/**
 * Orrery inside OMP (oh-my-pi): the pi extension with OMP's differences on (spec 2026-10-10-omp-design). Install with a
 * one-line <agentDir>/extensions/orrery.ts that re-exports this file by a relative path (docs/omp.md): OMP does not
 * follow an absolute re-export. Outside OMP it does nothing. In OMP it registers /orrery, /compactor and /browse when it
 * loads, so they are in OMP's autocomplete in every session; outside a lane folder they say no lane memory is open.
 * In a lane it switches OMP's own compaction, memory, project CLAUDE.md and titles off for the session: settings.ts.
 */

import { createOrrery } from "../pi/index.ts";
import { applyLaneSettings } from "./settings.ts";

export default createOrrery({ host: "omp", laneSettings: (ctx, workspace) => applyLaneSettings(ctx, workspace) });
