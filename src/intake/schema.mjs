import { z } from 'zod';

export const stages = ['purpose', 'scope', 'boundary', 'size', 'goal', 'review'];
export const answerSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  purpose: z.enum(['consolidation', 'diagnostic', 'assessment', 'mock_exam']).optional(),
  mainScope: z.array(z.string().min(1).max(60)).max(30).optional(),
  learnedScope: z.array(z.string().min(1).max(60)).max(30).optional(),
  learnedScopeMode: z.enum(['progress', 'custom']).optional(),
  premises: z.array(z.string().min(1).max(60)).max(30).optional(),
  size: z.enum(['recommend', 'preset', 'custom']).optional(),
  questionCount: z.number().int().min(1).max(60).optional(),
  singleChoiceCount: z.number().int().min(0).max(30).optional(),
  fillBlankCount: z.number().int().min(0).max(30).optional(),
  freeResponseCount: z.number().int().min(0).max(30).optional(),
  scoringMode: z.enum(['none', 'points']).optional(),
  targetScore: z.number().int().min(0).max(1000).optional(),
  durationMinutes: z.number().int().min(1).max(300).optional(),
  cognition: z.enum(['unspecified', 'understand', 'apply', 'reason']).optional(),
  priority: z.enum(['preferred', 'required']).optional(),
  observable: z.string().trim().max(1000).optional(),
  response: z.enum(['unspecified', 'answer', 'written_reasoning']).optional(),
  prompt: z.enum(['unspecified', 'provided', 'independent']).optional(),
  abilities: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  literacies: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
}).strict();

const optionSchema = z.object({ id: z.string().min(1).max(120), label: z.string().min(1).max(120), description: z.string().max(500).optional() }).strict();
const blockBase = {
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  title: z.string().min(1).max(160), description: z.string().max(1500).optional(),
};
export const blockSchema = z.discriminatedUnion('kind', [
  z.object({ ...blockBase, kind: z.literal('single_choice'),
    field: z.enum(['purpose', 'size', 'scoringMode', 'cognition', 'priority', 'response', 'prompt']),
    options: z.array(optionSchema).min(1).max(40), value: z.string().max(1500).optional(),
  }).strict(),
  z.object({ ...blockBase, kind: z.literal('multi_choice'),
    field: z.enum(['mainScope', 'learnedScope', 'premises', 'abilities', 'literacies']),
    options: z.array(optionSchema).min(1).max(40), value: z.array(z.string().max(120)).max(30).optional(),
  }).strict(),
  z.object({ ...blockBase, kind: z.literal('number'),
    field: z.enum(['singleChoiceCount', 'fillBlankCount', 'freeResponseCount', 'targetScore', 'durationMinutes']),
    value: z.number().optional(),
  }).strict(),
  z.object({ ...blockBase, kind: z.literal('text'),
    field: z.enum(['title', 'observable']), value: z.string().max(1000).optional(),
  }).strict(),
  z.object({ ...blockBase, kind: z.literal('notice') }).strict(),
]);

// LLM emits data for a finite renderer. It cannot emit HTML, handlers, code or arbitrary fields.
export const proposalSchema = z.object({
  summary: z.string().min(1).max(1500),
  changes: answerSchema,
  blocks: z.array(blockSchema).max(8),
}).strict();

export const requestSchema = z.object({
  action: z.enum(['start', 'revise', 'answer', 'prepare', 'assist', 'suggest_methods', 'confirm']),
  flow: z.enum(['quick', 'guided']).optional(),
  sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
  revision: z.number().int().min(0).optional(),
  operationId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
  answers: answerSchema.optional(),
  message: z.string().trim().max(4000).optional(),
  lockedFields: z.array(z.enum(['questionCount', 'targetScore', 'durationMinutes', 'scoringMode'])).max(4)
    .refine(fields => new Set(fields).size === fields.length, '锁定字段不能重复。').optional(),
  next: z.boolean().optional(), stage: z.enum(stages).optional(),
  acceptProposal: z.boolean().optional(),
}).strict();
