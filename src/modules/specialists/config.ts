export interface SpecialistsConfig {
  maxSpecialistDepth: number;
  maxChainDelegations: number;
  maxSameTypeDispatches: number;
  maxTaskDurationMs: number;
  maxRestartRetries: number;
  defaultLastTurnSubNotice: string;
  defaultLastTurnParentNotice: string;
}

export const SPECIALISTS_CONFIG: SpecialistsConfig = {
  maxSpecialistDepth: 5,
  maxChainDelegations: 20,
  maxSameTypeDispatches: 3,
  maxTaskDurationMs: 4 * 60 * 60 * 1000, // 4 hours
  maxRestartRetries: 2,
  defaultLastTurnSubNotice:
    '[Final iteration: this is your last opportunity to respond. Provide your best conclusive output as no further iterations will occur.]',
  defaultLastTurnParentNotice:
    '[Final iteration: no further responses will follow from this specialist. Incorporate this as your final input and conclude your work.]',
};
