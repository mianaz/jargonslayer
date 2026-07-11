export type LearnKind = "expression" | "term";

export interface LearnRecord {
  learnKey: string;
  kind: LearnKind;
  surface: string;
  familiarity: number;
  suppressed: boolean;
  suppressedAt?: number;
  reps: number;
  intervalDays: number;
  ease: number;
  dueAt: number;
  lastReviewedAt?: number;
  lapses: number;
  createdAt: number;
  updatedAt: number;
}
