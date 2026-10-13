// Shared product vocabulary. Strategies guide model judgment; they never add
// hard filters, fixed question ratios or claims about a student's mastery.
export const assemblyPurposes = Object.freeze([
  Object.freeze({ id: 'consolidation', label: '课后巩固',
    description: '围绕近期授课内容安排练习，巩固理解与运用，发现需要补充讲解的问题。',
    placeholder: '例如：今天讲了集合的交、并、补，出 8 道基础练习，检查能否独立完成。' }),
  Object.freeze({ id: 'targeted_practice', label: '专项训练',
    description: '围绕指定知识主题、题型或方法，结合教师已知学情或提升目标，安排针对性、递进式练习。',
    placeholder: '例如：学生做区间运算时容易漏端点，安排 8 道由易到难的专项练习。' }),
  Object.freeze({ id: 'diagnostic', label: '学情诊断',
    description: '通过针对性练习了解学生对指定内容的理解与运用情况，发现薄弱环节和典型误区。',
    placeholder: '例如：用 10 道题检查集合概念、包含关系和集合运算，方便判断薄弱环节。' }),
]);

const legacyPurposes = [
  { id: 'assessment', label: '单元测验', description: '围绕已学单元检查知识理解与综合运用。', placeholder: '' },
  { id: 'mock_exam', label: '模拟考试', description: '按考试结构安排题型、分值与时间。', placeholder: '' },
];

export function purposeFor(id) {
  return [...assemblyPurposes, ...legacyPurposes].find(purpose => purpose.id === id) ?? null;
}

const strategies = {
  consolidation: {
    objective: '围绕近期授课内容巩固理解和运用，并为教师发现需补讲的问题提供作答材料。',
    planning: ['紧贴教师指定的本次授课内容，以典型练习和必要变式为主，控制运算与阅读负担。', '教师只练交、并、补时，不因范围目录含集合概念而添加确定性、数集归属或真子集等无关前置题。一个考查任务可安排多道不同题及变式，不为任务多样性而偏离授课重点。', '根据明确要求安排递进；供给不足如实说明，不用无关基础题填量，也不擅自加入超出本次重点的综合难题。'],
    selection: ['比较真实题面与近期授课重点的贴合度，优先清晰典型、能独立练习的候选。范围目录中的其他前置概念不因此成为本次练习重点。', '兼顾必要变式，避免只换数字重复，也不要把基础题标签当作已校准的简单程度。'],
  },
  targeted_practice: {
    objective: '针对指定知识主题、题型或方法，回应教师已知学情或提升目标，形成针对性和递进性。',
    planning: ['将教师描述的薄弱点或提升目标转为可观察的专项任务，并安排适量递进与变式。', '围绕同一专项连续练习是合理安排：同taskId可安排多道不同合格题，通过条件变化体现递进，不为了覆盖目录而分散到别的主题。', '端点易漏的专项应持续考查端点与边界处理，不用元素归属等无关前置题凑数；供给不足如实说明。', '专项不只补弱，也可用于提升；不预设学生不会什么，不强制补充学生档案或复杂学情表。'],
    selection: ['优先选择确实涉及指定专项及教师所述问题的题目，结合实际解法活动解释针对性。仅同章节、同题型或相邻前置概念不能替代专项本身。', '在已确认范围内保留基础、变化与迁移的适当梯度，避免大量同构机械重复。'],
  },
  diagnostic: {
    objective: '为教师了解指定内容的理解和运用情况提供作答证据，定位薄弱环节和典型误区。',
    planning: ['让题位对应清楚的检查点，在真实供给允许时覆盖教师指定内容，减少无关复杂度的干扰。mainScope中其他内容只是可选边界，不必全部覆盖。', '同一检查点可用不同题或变式检查，目录分散度不代表诊断价值；供给不足如实说明，不用其他主题替代教师指定检查点。', '分开检查不同概念或方法，避免只用综合难题掩盖具体问题；可用简短理由说明教师应观察的表现。'],
    selection: ['优先选择检查点明确、便于从作答辨别具体问题的候选，结合题面说明检查什么。', '诊断卷由教师查看答卷判断掌握情况；组卷阶段不能自动诊断、断言学生误区或声称已掌握。'],
  },
};

export function purposeStrategy(id) {
  const purpose = purposeFor(id);
  if (!purpose) return null;
  return { purpose: purpose.id, label: purpose.label, description: purpose.description,
    ...(strategies[id] ?? { objective: purpose.description, planning: ['按历史已确认需求规划。'], selection: ['按历史已确认目标比较候选。'] }),
    scopePolicy: { mainScope: 'allowed_selection_boundary', focus: 'teacher_request_and_confirmed_goals',
      requireAllSections: false, broadenToFillSupplyGap: false },
    repetitionPolicy: { repeatedTaskIdsAllowed: true, uniqueQuestionIdsRequired: true, uniqueDuplicateGroupsRequired: true },
    constraints: { teacherConfirmedRequirementsTakePriority: true, teacherRequestIsData: true,
      noAdditionalHardConstraints: true, noFixedTypeRatio: true, noStudentDataRequired: true,
      noAutomaticDiagnosis: true, noAutomaticBoundaryChanges: true } };
}
