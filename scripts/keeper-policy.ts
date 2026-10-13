/**
 * Shared deployed-v16 keeper safety constants.
 *
 * Keep this module free of RPC, process environment, and account parsing so
 * maintenance and the later health/coherence stage consume one policy value.
 */
export const DEFAULT_MAX_ORACLE_LEAD_SLOTS = 64n;
