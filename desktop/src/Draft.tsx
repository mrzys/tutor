import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import {
  Check,
  ChevronDown,
  Eye,
  Info,
  LockKeyhole,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  UnlockKeyhole,
  X,
} from "lucide-solid";
import { cancel, operationId, request, typeIds, typeLabels } from "./bridge";
import { ErrorBanner, Modal, Popover, TypeTabs } from "./ui";
import { QuestionBody, RichText } from "./Paper";
import { difficultyLevels, slotDifficulty } from "./assembly-details";
import { confirmedSlotTaskLabel } from "./shared/assembly-evidence.mjs";
import { QuestionDetails } from "./QuestionDetails";
import { teachingDisplayText } from "./teaching-text";

export function DraftView(props: {
  draft: any;
  config: any;
  busy: boolean;
  operation: (operation: any) => Promise<void>;
  onRefreshDraft: (draft: any) => void;
  preview: () => void;
  confirm: () => void;
  details: () => void;
}) {
  const [tab, setTab] = createSignal("single_choice");
  const [selected, setSelected] = createSignal<string[]>([]);
  const [menu, setMenu] = createSignal("");
  const [candidateSlot, setCandidateSlot] = createSignal<any>(null);
  const [candidates, setCandidates] = createSignal<any[]>([]);
  const [candidateBusy, setCandidateBusy] = createSignal(false);
  const [candidateError, setCandidateError] = createSignal("");
  const [candidateMessage, setCandidateMessage] = createSignal("");
  const [candidateSearch, setCandidateSearch] = createSignal<any>(null);
  const [manualAddOpen, setManualAddOpen] = createSignal(false);
  const [addType, setAddType] = createSignal("single_choice");
  const [addQuery, setAddQuery] = createSignal("");
  const [addPage, setAddPage] = createSignal(1);
  const [addTotal, setAddTotal] = createSignal(0);
  const [replaceQuery, setReplaceQuery] = createSignal("");
  const [replacePage, setReplacePage] = createSignal(1);
  let candidateVersion = 0;
  onCleanup(() => { ++candidateVersion; });
  const [addOpen, setAddOpen] = createSignal(false);
  const [taskId, setTaskId] = createSignal("");
  const [criteriaSlot, setCriteriaSlot] = createSignal<any>(null);
  const [detailSlot, setDetailSlot] = createSignal("");
  const detail = createMemo(() => (props.draft?.slots || []).find((slot: any) => slot.slotId === detailSlot()));
  const [difficultyTarget, setDifficultyTarget] = createSignal("");
  createEffect(() => {
    const slot = criteriaSlot();
    if (slot) setDifficultyTarget(slotDifficulty(slot, props.draft?.baseline?.requirements, props.draft?.baseline?.questionIndexSnapshot).selectValue);
  });
  const [pointsSlot, setPointsSlot] = createSignal<any>(null);
  const [points, setPoints] = createSignal(0);
  const [partPoints, setPartPoints] = createSignal<any[]>([]);
  const [deleteSlot, setDeleteSlot] = createSignal<any>(null);
  const [editError, setEditError] = createSignal("");
  async function mutate(value: any) {
    setEditError("");
    try {
      await props.operation(value);
      return true;
    } catch (error: any) {
      setEditError(error.message);
      return false;
    }
  }
  const slots = () => props.draft?.slots || [];
  const manual = () => props.draft?.selectionGeneration?.mode === "manual";
  const replaceMatches = createMemo(() => {
    const query = replaceQuery().trim().toLocaleLowerCase();
    return candidates().filter((candidate: any) => !query || JSON.stringify(candidate.question?.student || {}).toLocaleLowerCase().includes(query));
  });
  const visible = () =>
    slots().filter((slot: any) => slot.questionType === tab());
  const taskType = () => criteriaSlot()?.questionType || addType();
  const matchingTasks = () => (props.config.tasks || []).filter((task: any) => task.questionType === taskType());
  function chooseAddType(type: string) {
    setAddType(type);
    setTaskId((props.config.tasks || []).find((task: any) => task.questionType === type)?.id || "");
  }
  const scored = () =>
    props.draft?.baseline?.requirements?.scoringMode !== "none";
  createEffect(() => {
    if (!slots().some((slot: any) => slot.questionType === tab()))
      setTab(slots()[0]?.questionType || "single_choice");
    setSelected((ids) =>
      ids.filter((id) => slots().some((slot: any) => slot.slotId === id)),
    );
  });
  async function loadCandidates(slot: any, continuation?: any) {
    const own = ++candidateVersion;
    setCandidateSlot(slot);
    setReplaceQuery("");
    setReplacePage(1);
    setCandidateBusy(true);
    setCandidateError("");
    if (!continuation) {
      setCandidateMessage("");
      setCandidates([]);
      setCandidateSearch(null);
    }
    try {
      const result = await request("draft_candidates", {
        draftId: props.draft.draftId,
        slotId: slot.slotId,
        expectedRevision: props.draft.revision,
        ...(continuation ? { continuation } : {}),
      });
      if (own === candidateVersion) {
        if (result.draft) props.onRefreshDraft(result.draft);
        setCandidates(result.candidates || []);
        setCandidateMessage(result.missingReason || "");
        setCandidateSearch(result.search || null);
      }
    } catch (error: any) {
      if (own === candidateVersion) setCandidateError(error.message);
    } finally {
      if (own === candidateVersion) setCandidateBusy(false);
    }
  }
  async function replace(candidate?: any) {
    setCandidateError("");
    try {
      await props.operation({
        type: "replace",
        mode: "direct",
        slotIds: [candidateSlot().slotId],
        ...(candidate
          ? {
              candidateId: candidate.questionId || candidate.id,
              contentVersion: candidate.contentVersion, teacherVersion: candidate.teacherVersion,
            }
          : {}),
      });
      setCandidateSlot(null);
    } catch (error: any) {
      setCandidateError(error.message);
    }
  }
  async function loadManualAdd(page = 1) {
    const own = ++candidateVersion;
    setManualAddOpen(true);
    setCandidateBusy(true);
    setCandidateError("");
    setCandidates([]);
    try {
      const result = await request("bank_search", {
        query: addQuery(), questionType: addType(), page, pageSize: 20,
      });
      if (own === candidateVersion) {
        setCandidates(result.questions || []);
        setAddPage(result.page || page);
        setAddTotal(result.total || 0);
      }
    } catch (error: any) {
      if (own === candidateVersion) setCandidateError(error.message);
    } finally {
      if (own === candidateVersion) setCandidateBusy(false);
    }
  }
  async function addManualQuestion(question: any) {
    if (await mutate({
      type: "add", questionType: question.questionType,
      candidateId: question.questionId, contentVersion: question.contentVersion,
      teacherVersion: question.teacherVersion,
    })) {
      ++candidateVersion;
      setManualAddOpen(false);
      setTab(question.questionType);
    }
  }
  async function add() {
    if (!taskId() || !matchingTasks().some((task: any) => task.id === taskId())) return;
    const task = (props.config.tasks || []).find(
      (item: any) => item.id === taskId(),
    );
    if (
      !(await mutate({
        type: "add",
        taskId: taskId(),
        points: scored() ? 10 : 0,
        partPoints:
          task?.questionType === "free_response"
            ? (task.partIds || []).map(
                (partId: string, index: number, ids: string[]) => ({
                  partId,
                  points: scored()
                    ? Math.floor(10 / ids.length) +
                      (index < 10 % ids.length ? 1 : 0)
                    : 0,
                }),
              )
            : [],
      }))
    )
      return;
    setAddOpen(false);
    setTab(task.questionType);
  }
  const changeLock = async (slot: any) => {
    if (
      await mutate({ type: "lock", slotId: slot.slotId, locked: !slot.locked })
    )
      setMenu("");
  };
  return (
    <>
      <ErrorBanner message={editError()} />
      <div class="draft-layout">
        <div class="draft-main">
          <div class="draft-controls">
            <TypeTabs
              slots={slots()}
              value={tab()}
              onChange={(value) => {
                setTab(value);
                setSelected([]);
              }}
            />
            <span class="muted draft-count">
            已选 {slots().filter((slot: any) => slot.question).length} 题
            <Show when={(props.draft?.stats?.missingCount ?? slots().filter((slot: any) => !slot.question).length) > 0}>
              {" · 缺 "}{props.draft?.stats?.missingCount ?? slots().filter((slot: any) => !slot.question).length} 题
            </Show>
            </span>
            <Show when={!manual()}>
              <label class="select-all">
                <input
                  type="checkbox"
                  aria-label="全选当前题型"
                  checked={visible().length > 0 && visible().every((slot: any) => selected().includes(slot.slotId))}
                  ref={(element) => createEffect(() => {
                    element.indeterminate = visible().some((slot: any) => selected().includes(slot.slotId)) && !visible().every((slot: any) => selected().includes(slot.slotId));
                  })}
                  onChange={(event) => setSelected(event.currentTarget.checked ? visible().map((slot: any) => slot.slotId) : [])}
                />
                全选
              </label>
            </Show>
          </div>
      <div class="draft-questions" role="tabpanel">
        <Show when={props.draft?.planningShortage?.missingTotal > 0}>
          <p class="warning-text" role="status">原定 {props.draft.baseline.requirements.questionCount} 题，尚有 {props.draft.planningShortage.missingTotal} 题未安排考查任务，已保留缺口；可继续编辑、预览和确认成卷。</p>
        </Show>
        <For each={visible()}>
          {(slot: any) => (
            <article
              class={`draft-question ${selected().includes(slot.slotId) ? "selected" : ""}`}
            >
              <Show when={!manual()}><label class="question-checkbox">
                <input
                  type="checkbox"
                  aria-label={`选择第 ${slot.number} 题`}
                  checked={selected().includes(slot.slotId)}
                  onChange={(event) =>
                    setSelected((ids) =>
                      event.currentTarget.checked
                        ? [...ids, slot.slotId]
                        : ids.filter((id) => id !== slot.slotId),
                    )
                  }
                />
              </label></Show>
              <QuestionBody
                question={slot.question}
                number={slot.number}
                manifest={props.draft.baseline.sourceManifest}
                points={slot.points}
                showPoints={scored()}
              />
              <Show when={!slot.question}>
                <p class="missing-slot-task">
                  <strong>考查点：</strong>
                  <RichText text={teachingDisplayText(confirmedSlotTaskLabel(slot, props.draft?.baseline?.taskCatalogSnapshot))} />
                </p>
                <p class="warning-text">
                  <RichText text={teachingDisplayText((slot.selection?.reasons || slot.missingReasons || []).join(
                    "；",
                  ) || "当前条件下没有可用题目，保留此题位。")} />
                </p>
                <button
                  class="secondary"
                  onClick={() => {
                    setCriteriaSlot(slot);
                    setTaskId(slot.taskId);
                  }}
                >
                  调整要求
                </button>
              </Show>
              <Show when={slot.locked}>
                <span class="lock-indicator" title="已锁定，自动换题将跳过">
                  <LockKeyhole size={13} />
                </span>
              </Show>
              <div class="question-actions">
                <button aria-label={`第 ${slot.number} 题详情`} onClick={() => setDetailSlot(slot.slotId)}><Info size={14} />详情</button>
                <button
                  disabled={props.busy}
                  onClick={() => loadCandidates(slot)}
                >
                  <RefreshCw size={14} />
                  换题
                </button>
                <Show when={!manual()}><button
                  disabled={props.busy}
                  onClick={() => {
                    setCriteriaSlot(slot);
                    setTaskId(slot.taskId);
                  }}
                >
                  <Pencil size={14} />
                  调整
                </button></Show>
                <div class="relative">
                  <button
                    aria-label={`第 ${slot.number} 题更多操作`}
                    title="更多操作"
                    onClick={() =>
                      setMenu(menu() === slot.slotId ? "" : slot.slotId)
                    }
                  >
                    <MoreHorizontal size={18} />
                  </button>
                  <Show when={menu() === slot.slotId}>
                    <Popover close={() => setMenu("")}>
                      <button onClick={() => changeLock(slot)}>
                        {slot.locked ? (
                          <UnlockKeyhole size={16} />
                        ) : (
                          <LockKeyhole size={16} />
                        )}{" "}
                        {slot.locked ? "解锁" : "锁定"}
                      </button>
                      <Show when={scored()}>
                        <button
                          onClick={() => {
                            setPointsSlot(slot);
                            setPoints(slot.points);
                            setPartPoints(
                              structuredClone(slot.partPoints || []),
                            );
                            setMenu("");
                          }}
                        >
                          调整题分
                        </button>
                      </Show>
                      <button
                        class="danger"
                        onClick={() => {
                          setDeleteSlot(slot);
                          setMenu("");
                        }}
                      >
                        <Trash2 size={16} />
                        删除
                      </button>
                    </Popover>
                  </Show>
                </div>
              </div>
            </article>
          )}
        </For>
      </div>
        </div>
        <aside class="draft-actions" aria-label="试卷操作">
          <button class="primary" disabled={props.busy} onClick={props.confirm}>
            <Check size={17} />确认成卷
          </button>
          <button class="secondary" disabled={props.busy} onClick={props.preview}>
            <Eye size={16} />预览
          </button>
          <button
            disabled={props.busy}
            onClick={() => {
              if (manual()) {
                setAddQuery("");
                setAddType(tab());
                void loadManualAdd();
                return;
              }
              chooseAddType(tab());
              setAddOpen(true);
            }}
          >
            <Plus size={16} />添加题目
          </button>
          <Show when={!manual()}>
            <button onClick={props.details}><Info size={16} />组卷说明</button>
          </Show>
          <Show when={selected().length}>
            <div class="bulk-actions">
              <span>已选 {selected().length} 题</span>
              <button disabled={props.busy} onClick={() => mutate({type: "replace", mode: "automatic", slotIds: selected()})}>
                <RefreshCw size={15} />批量换题
              </button>
              <button onClick={() => setSelected([])}><X size={16} />取消选择</button>
            </div>
          </Show>
        </aside>
      </div>
      <Show when={detail()}><QuestionDetails slot={detail()} draft={props.draft} onClose={() => setDetailSlot("")} /></Show>
      <Show when={candidateSlot()}>
        <Modal
          title={`替换第 ${candidateSlot().number} 题`}
          onClose={() => { ++candidateVersion; setCandidateSlot(null); }}
          wide
          busy={props.busy}
        >
          <ErrorBanner
            message={candidateError()}
            retry={() => loadCandidates(candidateSlot())}
          />
          <Show when={candidateBusy()}>
            <p role="status">{manual() ? "正在查找可用题目…" : "正在由模型评估真实备选题…"}</p>
            <Show when={!manual()}><button class="secondary" onClick={() => cancel().catch((error: any) => setCandidateError(error.message))}>停止评估</button></Show>
          </Show>
          <Show when={!candidateBusy() && !candidateError() && !candidates().length}>
            <p class="muted">
              {manual() ? "没有其它可用的同题型题目，现题保留。" : candidateMessage() || "模型未找到符合当前要求的备选题，现题保留。可调整考查要求或补充题库。"}
            </p>
          </Show>
          <Show when={manual()}>
            <input type="search" aria-label="搜索备选题" placeholder="搜索备选题内容"
              value={replaceQuery()} onInput={(event) => { setReplaceQuery(event.currentTarget.value); setReplacePage(1); }} />
            <Show when={!candidateBusy() && candidates().length && !replaceMatches().length}><p class="muted">没有匹配的备选题。</p></Show>
          </Show>
          <For each={manual() ? replaceMatches().slice((replacePage() - 1) * 20, replacePage() * 20) : candidates()}>
            {(item: any) => (
              <div class="candidate">
                <Show
                  when={item.question}
                  fallback={
                    <p>
                      <RichText
                        text={item.stem || item.taskLabel || item.questionId}
                      />
                    </p>
                  }
                >
                  <QuestionBody question={item.question} />
                </Show>
                <Show when={item.reasons?.length}>
                  <p class="muted"><RichText text={teachingDisplayText(item.reasons.join("；"))} /></p>
                </Show>
                <button
                  class="secondary"
                  disabled={
                    props.busy ||
                    item.canSelect === false ||
                    item.current ||
                    item.duplicate
                  }
                  onClick={() => replace(item)}
                >
                  选用
                </button>
              </div>
            )}
          </For>
          <Show when={manual() && replaceMatches().length > 20}><div class="pagination">
            <button disabled={replacePage() <= 1} onClick={() => setReplacePage((page) => page - 1)}>上一页</button>
            <span>{replacePage()} / {Math.ceil(replaceMatches().length / 20)}</span>
            <button disabled={replacePage() * 20 >= replaceMatches().length} onClick={() => setReplacePage((page) => page + 1)}>下一页</button>
          </div></Show>
          <Show when={!manual() && candidateSearch()}>
            <div class="pagination">
              <span class="muted">已发送 {candidateSearch().presentedCount || 0} 题 · 模型已判断 {candidateSearch().assessedCount || 0} 题</span>
              <Show when={candidateSearch().continuation}>
                <button class="secondary" disabled={candidateBusy() || props.busy}
                  onClick={() => loadCandidates(candidateSlot(), candidateSearch().continuation)}>继续比较其他候选</button>
              </Show>
            </div>
          </Show>
        </Modal>
      </Show>
      <Show when={manualAddOpen()}>
        <Modal title="添加题目" wide busy={props.busy}
          onClose={() => { ++candidateVersion; setManualAddOpen(false); }}>
          <form class="bank-search" onSubmit={(event) => { event.preventDefault(); void loadManualAdd(); }}>
            <select aria-label="添加题型" value={addType()} disabled={props.busy}
              onChange={(event) => { setAddType(event.currentTarget.value); void loadManualAdd(); }}>
              <For each={typeIds}>{(type) => <option value={type}>{typeLabels[type]}</option>}</For>
            </select>
            <input type="search" aria-label="搜索要添加的题目" placeholder="搜索题目内容"
              value={addQuery()} onInput={(event) => setAddQuery(event.currentTarget.value)} />
            <button class="secondary" disabled={candidateBusy()}>搜索</button>
          </form>
          <ErrorBanner message={candidateError()} retry={() => loadManualAdd(addPage())} />
          <ErrorBanner message={editError()} />
          <Show when={candidateBusy()}><p role="status">正在查询题目…</p></Show>
          <Show when={!candidateBusy() && !candidates().length && !candidateError()}><p class="muted">没有匹配的题目，试试其它关键词。</p></Show>
          <For each={candidates()}>{(row: any) => {
            const question = () => row.question || row;
            const already = () => slots().some((slot: any) => slot.question?.questionId === question().questionId);
            return <article class="candidate"><QuestionBody question={question()} manifest={props.draft.baseline.sourceManifest} />
              <button class="secondary" disabled={props.busy || already() || slots().length >= 60}
                onClick={() => addManualQuestion(question())}>{already() ? "已在试卷中" : "加入试卷"}</button></article>;
          }}</For>
          <Show when={addTotal() > 20}><div class="pagination">
            <button disabled={candidateBusy() || addPage() <= 1} onClick={() => loadManualAdd(addPage() - 1)}>上一页</button>
            <span>{addPage()} / {Math.ceil(addTotal() / 20)}</span>
            <button disabled={candidateBusy() || addPage() * 20 >= addTotal()} onClick={() => loadManualAdd(addPage() + 1)}>下一页</button>
          </div></Show>
        </Modal>
      </Show>
      <Show when={addOpen() || criteriaSlot()}>
        <Modal
          title={
            criteriaSlot() ? `调整第 ${criteriaSlot().number} 题` : "添加题目"
          }
          stable
          onClose={() => {
            setAddOpen(false);
            setCriteriaSlot(null);
          }}
          busy={props.busy}
          footer={
            <button
              class="primary"
              disabled={props.busy || !taskId() || !matchingTasks().some((task: any) => task.id === taskId())}
              onClick={async () => {
                if (criteriaSlot()) {
                  if (
                    await mutate({
                      type: "criteria",
                      slotId: criteriaSlot().slotId,
                      taskId: taskId(),
                      ...(difficultyTarget() === "legacy" ? {} : {targetDifficultyLevel: difficultyTarget() || null}),
                    })
                  )
                    setCriteriaSlot(null);
                } else await add();
              }}
            >
              确认
            </button>
          }
        >
          <ErrorBanner message={editError()} />
          <Show when={!criteriaSlot()}>
            <label class="field-label">
              题型
              <select aria-label="添加题型" value={addType()} disabled={props.busy}
                onChange={(event) => chooseAddType(event.currentTarget.value)}>
                <For each={typeIds}>{(type) => <option value={type}>{typeLabels[type]}</option>}</For>
              </select>
            </label>
          </Show>
          <label class="field-label">
            考查点
            <select
              aria-label="考查点"
              disabled={props.busy || !matchingTasks().length}
              value={taskId()}
              onChange={(event) => setTaskId(event.currentTarget.value)}
            >
              <Show when={!matchingTasks().length}><option value="">暂无对应题型的考查点</option></Show>
              <For each={matchingTasks()}>
                {(task) => (
                  <option value={task.id}>
                    {task.label}
                  </option>
                )}
              </For>
            </select>
          </label>
          <Show when={!matchingTasks().length}><p class="warning-text">当前题型没有可选考查点，请选择其它题型。</p></Show>
          <Show when={criteriaSlot()}>
            <label class="field-label">难度要求
              <select aria-label="难度要求" disabled={props.busy} value={difficultyTarget()} onChange={event => setDifficultyTarget(event.currentTarget.value)}>
                <option value="">未指定</option>
                <Show when={slotDifficulty(criteriaSlot(), props.draft?.baseline?.requirements, props.draft?.baseline?.questionIndexSnapshot).legacyLabel}>
                  <option value="legacy" disabled>{slotDifficulty(criteriaSlot(), props.draft?.baseline?.requirements, props.draft?.baseline?.questionIndexSnapshot).legacyLabel}</option>
                </Show>
                <For each={difficultyLevels}>{level => <option value={level.id}>{level.label}</option>}</For>
              </select>
            </label>
            <Show when={difficultyLevels.find(level => level.id === difficultyTarget())}>
              {level => <p class="muted" aria-live="polite">{level().summary}</p>}
            </Show>
            <details class="difficulty-guide">
              <summary>难度标准</summary>
              <p class="muted">按已学所需知识、独立作答判断内容挑战，不预测学生正确率。</p>
              <For each={difficultyLevels}>{level => <p><strong>{level.label}：</strong>{level.summary}</p>}</For>
            </details>
            <p class="muted">保存难度要求，保留现题；不改变题目已有的难度评估。</p>
          </Show>
          <Show when={criteriaSlot()} fallback={<p class="muted">先添加题位，再从真实候选中选择题目。</p>}>
            <p class="muted">保留当前题位及题型。</p>
          </Show>
        </Modal>
      </Show>
      <Show when={pointsSlot()}>
        <Modal
          title={`第 ${pointsSlot().number} 题分值`}
          onClose={() => setPointsSlot(null)}
          busy={props.busy}
          footer={
            <button
              class="primary"
              disabled={props.busy}
              onClick={async () => {
                if (
                  await mutate({
                    type: "points",
                    slotId: pointsSlot().slotId,
                    points: points(),
                    partPoints: partPoints(),
                  })
                )
                  setPointsSlot(null);
              }}
            >
              保存
            </button>
          }
        >
          <ErrorBanner message={editError()} />
          <label class="field-label">
            题分
            <input
              type="number"
              min="0"
              max="1000"
              value={points()}
              onInput={(event) => setPoints(Number(event.currentTarget.value))}
            />
          </label>
          <For each={partPoints()}>
            {(part: any, index) => (
              <label class="field-label">
                第 {index() + 1} 小问
                <input
                  type="number"
                  min="0"
                  value={part.points}
                  onInput={(event) =>
                    setPartPoints((parts) =>
                      parts.map((item, i) =>
                        i === index()
                          ? {
                              ...item,
                              points: Number(event.currentTarget.value),
                            }
                          : item,
                      ),
                    )
                  }
                />
              </label>
            )}
          </For>
        </Modal>
      </Show>
      <Show when={deleteSlot()}>
        <Modal
          title="删除题目"
          onClose={() => setDeleteSlot(null)}
          busy={props.busy}
          footer={
            <>
              <button class="secondary" onClick={() => setDeleteSlot(null)}>
                取消
              </button>
              <button
                class="primary"
                disabled={props.busy}
                onClick={async () => {
                  if (
                    await mutate({
                      type: "delete",
                      slotId: deleteSlot().slotId,
                    })
                  )
                    setDeleteSlot(null);
                }}
              >
                删除
              </button>
            </>
          }
        >
          <ErrorBanner message={editError()} />
          <p>删除第 {deleteSlot().number} 题？题量将相应减少。</p>
        </Modal>
      </Show>
    </>
  );
}
