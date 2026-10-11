import { selectionProposalSchema, createSelectionGateway } from '../llm/selection-gateway.mjs';

const MAX_CANDIDATES = 8;
const MAX_BATCH_SLOTS = 8;
const MAX_CONTEXT_CHARS = 100000;
const MAX_TEXT_CHARS = 6000;
const invalid = message => { throw Object.assign(new Error(message), { code: 'invalid_model_output' }); };
const cancelled = () => ({ ok: false, error: { code: 'cancelled', message: '已取消 AI 候选比较，未保存草稿。' } });

async function proposeWithCancellation(gateway, context, signal) {
  if (signal?.aborted) return cancelled();
  let onAbort;
  const abort = new Promise(resolve => {
    onAbort = () => resolve(cancelled());
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => gateway.propose(context, {
      signal, validate: proposal => validateSelectionProposal(proposal, context),
    })), abort]);
  } finally { signal?.removeEventListener('abort', onAbort); }
}

function candidateView(record, candidate) {
  const question = record.result.question;
  const evidence = {};
  const truncated = [];
  let remaining = MAX_TEXT_CHARS;
  const add = (key, value) => {
    if (typeof value !== 'string' || !value) return;
    if (!remaining) { truncated.push(key); return; }
    evidence[key] = value.slice(0, remaining);
    remaining -= evidence[key].length;
    if (evidence[key].length < value.length) truncated.push(key);
  };
  add('student.stem', question.student.stem);
  question.student.options.forEach((option, index) => add(`student.options[${index}].text`, `${option.label}. ${option.text}`));
  question.student.parts.forEach((part, index) => add(`student.parts[${index}].prompt`, `${part.partId}: ${part.prompt}`));
  add('allowedSolutionPath.basis', candidate.allowedSolutionPath.basis);
  question.teacher.solutions.forEach((solution, index) => add(`teacher.solutions[${index}].text`, `${solution.partId}: ${solution.text}`));
  return {
    candidateKey: question.questionId, questionId: question.questionId,
    contentVersion: question.contentVersion, teacherVersion: question.teacherVersion,
    duplicateGroup: candidate.duplicateGroup,
    questionType: question.questionType, evidence,
    allowedSolutionPath: { id: candidate.allowedSolutionPath.id,
      requiredSections: candidate.allowedSolutionPath.requiredSections,
      requiredPremises: candidate.allowedSolutionPath.requiredPremises },
    goalSupport: structuredClone(candidate.goalSupport),
    imageAvailability: { pixelsProvided: false, assets: question.student.assets.map(({ assetId, alt }) => ({ assetId, alt, availability: 'registered_local_asset_not_sent' })) },
    contentTruncation: { truncated: truncated.length > 0, paths: truncated, maxTextChars: MAX_TEXT_CHARS },
  };
}

export function validateSelectionProposal(proposal, context) {
  const parsed = selectionProposalSchema.parse(proposal);
  if (parsed.rankings.length !== context.slots.length) invalid('题位排名数量与本批题位不一致。');
  const slots = new Map(context.slots.map(slot => [slot.slotId, slot]));
  const views = new Map(context.candidates.map(candidate => [candidate.questionId, candidate]));
  const seenSlots = new Set();
  for (const ranking of parsed.rankings) {
    const slot = slots.get(ranking.slotId);
    if (!slot || seenSlots.has(ranking.slotId)) invalid('排名包含未知或重复题位。');
    seenSlots.add(ranking.slotId);
    if (ranking.candidates.length !== slot.candidates.length) invalid('必须完整排序该题位的全部短名单候选。');
    const seenCandidates = new Set();
    for (const candidate of ranking.candidates) {
      const view = views.get(candidate.questionId);
      if (!view || !slot.candidates.includes(candidate.questionId) || seenCandidates.has(candidate.questionId)) invalid('排名包含不合格、未知或重复候选。');
      seenCandidates.add(candidate.questionId);
      if (candidate.contentVersion !== view.contentVersion || candidate.teacherVersion !== view.teacherVersion) invalid('候选版本与本次读取的题面/解析不一致。');
      if (new Set(candidate.evidenceRefs).size !== candidate.evidenceRefs.length
          || candidate.evidenceRefs.some(ref => !Object.hasOwn(view.evidence, ref))
          || !candidate.evidenceRefs.some(ref => ref.startsWith('student.'))) invalid('必须引用该候选已提供的精确证据键，并包含题面证据。');
    }
  }
  return parsed;
}

// Successive shortest augmenting paths: exhaust augmentations for maximum
// cardinality, then minimum rank cost among those complete assignments.
// Duplicate groups, not question IDs alone, are capacity-one resources.
export function combineRankings(slots, rankings, candidateMap) {
  const bySlot = new Map(rankings.map(item => [item.slotId, item.candidates]));
  const groups = [...new Set([...candidateMap.values()].map(item => item.duplicateGroup))].sort();
  const groupIndex = new Map(groups.map((group, index) => [group, slots.length + 1 + index]));
  const source = 0; const sink = slots.length + groups.length + 1;
  const graph = Array.from({ length: sink + 1 }, () => []);
  const add = (from, to, cost, candidate = null) => {
    const edge = { to, cost, capacity: 1, reverse: graph[to].length, candidate };
    graph[from].push(edge);
    graph[to].push({ to: from, cost: -cost, capacity: 0, reverse: graph[from].length - 1 });
    return edge;
  };
  const choices = [];
  slots.forEach((slot, index) => {
    const node = index + 1;
    add(source, node, 0);
    const seen = new Set();
    (bySlot.get(slot.slotId) ?? []).forEach((candidate, rank) => {
      const group = candidateMap.get(candidate.questionId).duplicateGroup;
      if (seen.has(group)) return;
      seen.add(group);
      choices.push({ slotId: slot.slotId, edge: add(node, groupIndex.get(group), rank, candidate), rank });
    });
  });
  groups.forEach(group => add(groupIndex.get(group), sink, 0));
  let filled = 0; let preferenceCost = 0;
  while (true) {
    const distances = Array(graph.length).fill(Infinity);
    const previous = Array(graph.length).fill(null);
    distances[source] = 0;
    // Bellman-Ford is bounded by <= 60 slots and <= 480 shortlisted groups.
    for (let pass = 1; pass < graph.length; pass++) {
      let changed = false;
      for (let from = 0; from < graph.length; from++) {
        if (!Number.isFinite(distances[from])) continue;
        graph[from].forEach((edge, edgeIndex) => {
          const next = distances[from] + edge.cost;
          if (edge.capacity && next < distances[edge.to]) {
            distances[edge.to] = next; previous[edge.to] = { from, edgeIndex }; changed = true;
          }
        });
      }
      if (!changed) break;
    }
    if (!previous[sink]) break;
    for (let node = sink; node !== source;) {
      const { from, edgeIndex } = previous[node];
      const edge = graph[from][edgeIndex];
      edge.capacity--; graph[node][edge.reverse].capacity++; node = from;
    }
    filled++; preferenceCost += distances[sink];
  }
  return { assignments: new Map(choices.filter(({ edge }) => edge.capacity === 0).map(({ slotId, edge, rank }) => [slotId, { ...edge.candidate, rank: rank + 1 }])),
    summary: { algorithm: 'maximum_cardinality_minimum_rank_cost', selectedQuestions: filled,
      missingQuestions: slots.length - filled, preferenceCost,
      scope: 'eligible_shortlists_only', noAutomaticRelaxation: true } };
}

// Keep one maximum-cardinality full-pool assignment inside the bounded model
// shortlists. Truncating every slot to the same first eight must not invent a
// supply shortage when the complete eligible pool can fill more positions.
function coverageBackbone(slots, eligibleBySlot) {
  const groupOwner = new Map(); const assignment = new Map();
  const visit = (slotId, seen) => {
    for (const candidate of eligibleBySlot.get(slotId)) {
      if (seen.has(candidate.duplicateGroup)) continue;
      seen.add(candidate.duplicateGroup);
      const owner = groupOwner.get(candidate.duplicateGroup);
      if (!owner || visit(owner, seen)) {
        groupOwner.set(candidate.duplicateGroup, slotId);
        assignment.set(slotId, candidate);
        return true;
      }
    }
    return false;
  };
  [...slots].sort((a, b) => eligibleBySlot.get(a.slotId).length - eligibleBySlot.get(b.slotId).length)
    .forEach(slot => visit(slot.slotId, new Set()));
  return assignment;
}

export async function selectWithLlm({ slots, requirements, pool, candidatesBySlot, gateway = createSelectionGateway(), signal }) {
  const eligibleBySlot = new Map(slots.map(slot => [slot.slotId, candidatesBySlot.get(slot.slotId).filter(candidate => candidate.status === 'eligible')]));
  const backbone = coverageBackbone(slots, eligibleBySlot);
  const shortlists = slots.map(slot => {
    const eligible = eligibleBySlot.get(slot.slotId);
    const shortlist = eligible.slice(0, MAX_CANDIDATES);
    const reserved = backbone.get(slot.slotId);
    if (reserved && !shortlist.some(candidate => candidate.questionId === reserved.questionId)) shortlist[shortlist.length - 1] = reserved;
    return { slotId: slot.slotId, candidates: shortlist,
      eligibleCount: eligible.length, shortlistedCount: Math.min(eligible.length, MAX_CANDIDATES), truncated: eligible.length > MAX_CANDIDATES };
  });
  const records = new Map(pool.records.map(record => [record.entry.questionId, record]));
  const candidates = new Map(shortlists.flatMap(list => list.candidates).map(candidate => [candidate.questionId, candidate]));
  const views = new Map([...candidates].map(([id, candidate]) => [id, candidateView(records.get(id), candidate)]));
  for (const [id, view] of views) {
    const supports = shortlists.flatMap(list => list.candidates.filter(candidate => candidate.questionId === id).flatMap(candidate => candidate.goalSupport));
    view.goalSupport = [...new Map(supports.map(goal => [`${goal.goalId}:${goal.goalVersion}`, goal])).values()];
    view.goalSupportScope = 'union_of_linked_shortlisted_slots; exact_associations_in_slots.candidateGoalSupport';
  }
  const metadata = { mode: 'llm', summary: '', run: null, runs: [],
    candidateEvidenceSnapshot: [...views.values()], rankings: [],
    shortlists: shortlists.map(({ candidates: ignored, ...list }) => list),
    limits: { maxCandidatesPerSlot: MAX_CANDIDATES, maxSlotsPerBatch: MAX_BATCH_SLOTS, maxContextChars: MAX_CONTEXT_CHARS, maxCandidateTextChars: MAX_TEXT_CHARS },
    shortlistStrategy: 'stable_identity_order_with_full_eligible_maximum_matching_backbone',
    fullEligibleMaximumFill: backbone.size,
    supportStatus: 'AI 匹配建议；不替代已复核教学目标证据，难度仍未知。' };
  const fail = result => ({ ...result, selectionGeneration: metadata });
  if (signal?.aborted) return fail(cancelled());
  const contextFor = batch => {
    const ids = [...new Set(batch.flatMap(slot => shortlists.find(list => list.slotId === slot.slotId).candidates.map(item => item.questionId)))];
    return { task: 'candidate_selection', requirements,
      slots: batch.map(({ slotId, taskLabel, goalIds, points, planningReason }) => ({ slotId, taskLabel, goalIds, points, planningReason,
        candidates: shortlists.find(list => list.slotId === slotId).candidates.map(item => item.questionId),
        candidateGoalSupport: shortlists.find(list => list.slotId === slotId).candidates.map(item => ({ questionId: item.questionId, goalSupport: item.goalSupport })) })),
      candidates: ids.map(id => views.get(id)), limits: metadata.limits,
      shortlists: metadata.shortlists.filter(list => batch.some(slot => slot.slotId === list.slotId)) };
  };
  const batches = []; let current = [];
  for (const slot of slots) {
    const proposed = [...current, slot];
    if (current.length && (proposed.length > MAX_BATCH_SLOTS || JSON.stringify(contextFor(proposed)).length > MAX_CONTEXT_CHARS)) {
      batches.push(current); current = [];
    }
    current.push(slot);
    if (JSON.stringify(contextFor(current)).length > MAX_CONTEXT_CHARS) return fail({ ok: false, error: { code: 'selection_resource_limit', message: '单题位候选上下文超出上限，请减少条件文本后重试。未保存草稿。' } });
  }
  if (current.length) batches.push(current);
  const rankings = []; const summaries = [];
  for (const batch of batches) {
    if (signal?.aborted) return fail(cancelled());
    const context = contextFor(batch);
    // Empty supply never needs a fabricated model ranking or API call.
    if (!context.candidates.length) {
      rankings.push(...batch.map(slot => ({ slotId: slot.slotId, candidates: [] })));
      continue;
    }
    let result;
    try { result = await proposeWithCancellation(gateway, context, signal); }
    catch { return fail({ ok: false, error: { code: signal?.aborted ? 'cancelled' : 'model_error', message: 'AI 候选比较调用失败或已取消，未保存草稿。' } }); }
    if (!result || typeof result.ok !== 'boolean') return fail({ ok: false, error: { code: 'invalid_model_output', message: 'AI 候选比较返回无效结果，未保存草稿。' } });
    if (result.run) { metadata.runs.push(result.run); metadata.run = result.run; }
    if (signal?.aborted) return fail(cancelled());
    if (!result.ok) return fail(result);
    try {
      const proposal = validateSelectionProposal(result.proposal, context);
      rankings.push(...proposal.rankings); summaries.push(proposal.summary);
      metadata.rankings = structuredClone(rankings);
    } catch { return fail({ ok: false, error: { code: 'invalid_model_output', message: 'AI 候选排名未通过身份、版本及证据校验，未保存草稿。' } }); }
  }
  const combined = combineRankings(slots, rankings, candidates);
  metadata.rankings = structuredClone(rankings);
  metadata.summary = summaries.join('\n') || '本次题位没有已证实合格候选，保留空位。';
  metadata.combination = { ...combined.summary, fullEligibleMaximumFill: backbone.size, shortlistPreservesMaximumFill: combined.summary.selectedQuestions === backbone.size };
  return { ok: true, assignments: combined.assignments, selectionGeneration: metadata };
}
