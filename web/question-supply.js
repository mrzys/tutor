export const draftSupplyKey = draft => `${draft.draftId}:${draft.revision ?? 0}`;

// A complete, revision-bound batch is required. Missing rows are never zero supply.
export function validateCandidateSupply(response, draft) {
  if (response.revision !== (draft.revision ?? 0) || !Array.isArray(response.slots)
    || response.slots.length !== draft.slots.length) throw new Error('换题余量与当前草稿不一致，请重新读取草稿。');
  const ids = new Set(draft.slots.map(slot => slot.slotId));
  const rows = {};
  for (const row of response.slots) {
    if (!ids.delete(row.slotId) || !['eligibleCount', 'suggestionCount', 'readFailureCount'].every(key => Number.isInteger(row[key]) && row[key] >= 0)) {
      throw new Error('换题余量返回不完整，尚不能判断有无备选。');
    }
    rows[row.slotId] = row;
  }
  return rows;
}

export function slotSupply(state, draft, slotId) {
  if (state.key !== draftSupplyKey(draft)) return { loading: true, error: '', data: null };
  return { loading: state.loading, error: state.error, data: state.rows?.[slotId] ?? null };
}

export function supplyPresentation(supply) {
  if (!supply || supply.loading) return { label: '核查中', detail: '正在核查当前草稿的真实备选…', exhausted: false };
  if (supply.error || !supply.data) return { label: '余量未核实', detail: supply.error || '未取得当前题位的余量，请重新读取草稿。', exhausted: false };
  const { eligibleCount, readFailureCount } = supply.data;
  const incomplete = readFailureCount > 0;
  return {
    label: incomplete ? `${eligibleCount} 道已核实 · ${readFailureCount} 道读取失败` : `${eligibleCount} 道备选`,
    detail: `${eligibleCount} 道合格备选（已排除现题及本卷重复）${incomplete ? `；另有 ${readFailureCount} 道读取失败，余量可能不完整。` : '。'}`,
    exhausted: eligibleCount === 0 && !incomplete,
  };
}
