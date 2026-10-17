/**
 * The pipeline every new tenant starts with (MVP_SPEC M2, M5).
 *
 * Seeded as rows, like roles and field metadata: an admin renames, reorders or
 * replaces these without a deploy, and nothing in the code names a stage.
 *
 * Positions are spaced by ten when inserted so a stage can be dropped between
 * two others without renumbering the rest.
 */
export interface StageTemplate {
  readonly name: string;
  readonly probability: number;
  readonly stageType: 'open' | 'won' | 'lost';
}

export const DEFAULT_PIPELINE: {
  readonly name: string;
  readonly stages: readonly StageTemplate[];
} = {
  name: 'Sales pipeline',
  stages: [
    { name: 'New', probability: 10, stageType: 'open' },
    { name: 'Qualified', probability: 25, stageType: 'open' },
    { name: 'Proposal', probability: 50, stageType: 'open' },
    { name: 'Negotiation', probability: 75, stageType: 'open' },
    { name: 'Won', probability: 100, stageType: 'won' },
    { name: 'Lost', probability: 0, stageType: 'lost' },
  ],
};
