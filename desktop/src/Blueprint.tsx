import { For, Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import { ArrowRight, Check, Link2, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-solid";
import { typeLabels } from "./bridge";
import { ErrorBanner, Modal, Popover, TypeTabs } from "./ui";
import { RichText } from "./Paper";
import { slotDifficulty } from "./assembly-details";
import { teachingDisplayText } from "./teaching-text";
import { availableTasks, bindBlueprintGoal, changeBlueprintTask, goalSlots, linkedGoalSlots, missingRequiredGoals } from "./blueprint-goals";
import { addBlueprintSlot, blueprintCatalogGaps, blueprintReview, blueprintTypes, editableBlueprintTypes, removeBlueprintSlot, updateBlueprintPoints, updateBlueprintSlot } from "./blueprint-review";
import "./Blueprint.css";

function BlueprintTaskPicker(props: { slot: any; label: string; options: any[]; disabled: boolean; onChange: (id: string) => void }) {
  const [open, setOpen] = createSignal(false);
  const [active, setActive] = createSignal(0);
  const [position, setPosition] = createSignal<JSX.CSSProperties>({});
  let trigger!: HTMLButtonElement;
  let list!: HTMLDivElement;
  const id = () => `blueprint-task-${props.slot.slotId}`;
  const close = (restore = false) => {
    setOpen(false);
    if (restore) queueMicrotask(() => document.getElementById(id())?.focus({ preventScroll: true }));
  };
  function reposition() {
    const rect = trigger.getBoundingClientRect(), viewport = window.visualViewport;
    const leftEdge = (viewport?.offsetLeft || 0) + 8, rightEdge = leftEdge + (viewport?.width || innerWidth) - 16;
    const topEdge = (viewport?.offsetTop || 0) + 8, bottomEdge = topEdge + (viewport?.height || innerHeight) - 16;
    const below = bottomEdge - rect.bottom - 6, above = rect.top - topEdge - 6;
    const upwards = below < Math.min(220, props.options.length * 58 + 16) && above > below;
    const width = Math.min(Math.max(rect.width, 280), rightEdge - leftEdge);
    setPosition({ left: `${Math.max(leftEdge, Math.min(rect.left, rightEdge - width))}px`, width: `${width}px`, "max-height": `${Math.max(44, Math.min(320, upwards ? above : below))}px`, top: upwards ? undefined : `${rect.bottom + 6}px`, bottom: upwards ? `${innerHeight - rect.top + 6}px` : undefined });
  }
  function show() {
    if (props.disabled || !props.options.length) return;
    setActive(Math.max(0, props.options.findIndex(option => option.id === props.slot.taskId)));
    reposition(); setOpen(true);
  }
  function choose(index: number) {
    const option = props.options[index];
    if (!option || props.disabled) return;
    const triggerId = id();
    close(); props.onChange(option.id);
    queueMicrotask(() => document.getElementById(triggerId)?.focus({ preventScroll: true }));
  }
  function keys(event: KeyboardEvent) {
    if (!open()) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) { event.preventDefault(); show(); }
      return;
    }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === "Tab") close();
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setActive(index => event.key === "Home" ? 0 : event.key === "End" ? props.options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + props.options.length) % props.options.length);
    } else if (["Enter", " "].includes(event.key)) { event.preventDefault(); choose(active()); }
  }
  createEffect(() => {
    if (props.disabled) close();
  });
  createEffect(() => {
    if (!open()) return;
    const update = () => reposition();
    window.addEventListener("resize", update); document.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update); window.visualViewport?.addEventListener("scroll", update);
    onCleanup(() => {
      window.removeEventListener("resize", update); document.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update); window.visualViewport?.removeEventListener("scroll", update);
    });
  });
  createEffect(() => {
    if (!open()) return;
    const index = active();
    queueMicrotask(() => {
      const option = list?.children[index] as HTMLElement | undefined;
      if (!option) return;
      const bounds = option.getBoundingClientRect(), visible = list.getBoundingClientRect();
      if (bounds.top < visible.top) list.scrollTop -= visible.top - bounds.top;
      else if (bounds.bottom > visible.bottom) list.scrollTop += bounds.bottom - visible.bottom;
    });
  });
  return <div class="blueprint-task-picker">
    <button ref={trigger} id={id()} type="button" class="plan-task" data-task-id={props.slot.taskId} role="combobox" aria-label={`第 ${props.slot.number} 题考查任务`} aria-haspopup="listbox" aria-expanded={open()} aria-controls={open() ? `${id()}-options` : undefined} aria-activedescendant={open() ? `${id()}-option-${active()}` : undefined} disabled={props.disabled} onClick={() => open() ? close() : show()} onKeyDown={keys}><span><RichText text={teachingDisplayText(props.label)} /></span><Pencil size={14} /></button>
    <Show when={open()}><Popover class="blueprint-task-popover" close={() => close()}><div ref={list} id={`${id()}-options`} class="blueprint-task-menu" role="listbox" aria-label={`第 ${props.slot.number} 题考查任务`} style={position()}><For each={props.options}>{(option, index) => <button type="button" role="option" data-task-id={option.id} tabIndex={-1} id={`${id()}-option-${index()}`} aria-selected={props.slot.taskId === option.id} classList={{ "is-active": active() === index() }} onPointerMove={() => setActive(index())} onMouseDown={event => event.preventDefault()} onClick={() => choose(index())}><span><RichText text={teachingDisplayText(option.label)} /></span><Show when={props.slot.taskId === option.id}><Check size={16} /></Show></button>}</For></div></Popover></Show>
  </div>;
}

function BlueprintSlotActions(props: { slot: any; disabled: boolean; onEdit: () => void; onRemove: () => void }) {
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal<JSX.CSSProperties>({});
  let trigger!: HTMLButtonElement, menu!: HTMLDivElement;
  const close = (restore = false) => { setOpen(false); if (restore) trigger.focus({ preventScroll: true }); };
  function show() {
    const rect = trigger.getBoundingClientRect(), width = Math.min(190, innerWidth - 16);
    setPosition({ left: `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`, width: `${width}px`, top: `${rect.bottom + 108 > innerHeight ? Math.max(8, rect.top - 108) : rect.bottom + 4}px` });
    setOpen(true); queueMicrotask(() => menu?.querySelector<HTMLButtonElement>("button")?.focus());
  }
  createEffect(() => { if (props.disabled) close(); });
  return <div class="blueprint-slot-actions" onKeyDown={event => {
    if (!open()) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>("button")), index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    } else if (event.key === "Tab") close();
  }}>
    <button ref={trigger} id={`blueprint-actions-${props.slot.slotId}`} type="button" class="icon-button" disabled={props.disabled} aria-label={`第 ${props.slot.number} 题操作`} aria-haspopup="menu" aria-expanded={open()} onClick={() => open() ? close() : show()}><MoreHorizontal size={18} /></button>
    <Show when={open()}><Popover class="blueprint-task-popover" close={() => close()}><div ref={menu} role="menu" class="blueprint-row-menu" aria-label={`第 ${props.slot.number} 题操作`} style={position()}>
      <button type="button" role="menuitem" onClick={() => { close(); props.onEdit(); }}><Pencil size={15} />调整题型与任务</button>
      <button type="button" role="menuitem" onClick={() => { close(); props.onRemove(); }}><Trash2 size={15} />删除题位</button>
    </div></Popover></Show>
  </div>;
}

export function BlueprintView(props: {
  blueprint: any;
  config: any;
  busy: boolean;
  onChange: (value: any) => void;
  onSelect: (mode: string) => void;
  configured: boolean;
  onConfigure: () => void;
}) {
  const [tab, setTab] = createSignal("single_choice");
  const [bindingGoal, setBindingGoal] = createSignal<any>(null);
  const [bindingSlots, setBindingSlots] = createSignal<string[]>([]);
  const [bindingError, setBindingError] = createSignal("");
  const [editError, setEditError] = createSignal("");
  const [editor, setEditor] = createSignal<{ slotId?: string; questionType: string; taskId: string; points: number } | null>(null);
  let editorReturnId = "blueprint-add-slot";
  const slots = () => props.blueprint?.slots || [];
  const req = () => props.blueprint?.requirements || {};
  const goals = () => req().teachingGoals || [];
  const missing = () => missingRequiredGoals(props.blueprint, props.config.tasks || []);
  const review = () => blueprintReview(props.blueprint, props.config.tasks || []);
  const quantity = () => review().quantity;
  const catalogGaps = () => blueprintCatalogGaps(props.blueprint, props.config.tasks || []);
  const editableTypes = () => editableBlueprintTypes(props.blueprint);
  const editorSlot = () => ({ slotId: editor()?.slotId ? `edit-${editor()!.slotId}` : "new-slot", number: editor()?.slotId ? slots().find((slot: any) => slot.slotId === editor()!.slotId)?.number : slots().length + 1, questionType: editor()?.questionType, taskId: editor()?.taskId });
  const editorTasks = () => availableTasks(props.blueprint, editorSlot(), props.config.tasks || []);
  const editorTask = () => editorTasks().find((task: any) => task.id === editor()?.taskId);
  const editorPointsValid = () => Boolean(editor()) && Number.isInteger(editor()!.points) && editor()!.points >= 0 && editor()!.points <= 1000;
  const quantitySuggestion = () => !review().hasExcess
    ? "可继续选题，未满足的部分会在草稿中保留为缺口；也可修改需求或题位。原定题量保持不变。"
    : `建议将${blueprintTypes.filter(type => quantity().expectedCounts[type] !== quantity().actualCounts[type]).map(type => `${typeLabels[type]}由 ${quantity().actualCounts[type]} 题调整为原定 ${quantity().expectedCounts[type]} 题`).join("，")}。可新增、删除或调整题位；原需求题量保持不变。`;
  createEffect(() => {
    if (!slots().some((slot: any) => slot.questionType === tab()))
      setTab(slots()[0]?.questionType || "single_choice");
  });
  function task(slot: any, id: string) {
    const chosen = props.config.tasks.find((item: any) => item.id === id);
    setEditError("");
    try { props.onChange(changeBlueprintTask(props.blueprint, slot.slotId, chosen)); }
    catch (error: any) { setEditError(error.message); }
  }
  function openBinding(goal: any) {
    setBindingGoal(goal);
    setBindingSlots(linkedGoalSlots(props.blueprint, goal, props.config.tasks || []).map((slot: any) => slot.slotId));
    setBindingError("");
  }
  function openEditor(slot?: any) {
    setEditError(""); editorReturnId = slot ? `blueprint-actions-${slot.slotId}` : "blueprint-add-slot";
    const type = slot?.questionType || blueprintTypes.find(type => quantity().actualCounts[type] < quantity().expectedCounts[type]) || (editableTypes().includes(tab() as any) ? tab() : editableTypes()[0]);
    setEditor({ slotId: slot?.slotId, questionType: type || "single_choice", taskId: slot?.taskId || "", points: slot?.points || 0 });
  }
  function closeEditor() {
    setEditor(null); setEditError("");
    requestAnimationFrame(() => document.getElementById(editorReturnId)?.focus({ preventScroll: true }));
  }
  function saveEditor() {
    const value = editor(); if (!value || !editorTask()) return;
    try {
      const next = value.slotId ? updateBlueprintSlot(props.blueprint, value.slotId, editorTask(), value.points) : addBlueprintSlot(props.blueprint, editorTask(), value.points);
      props.onChange(next); setTab(value.questionType); closeEditor();
    } catch (failure: any) { setEditError(failure.message); }
  }
  function remove(slot: any) {
    try {
      props.onChange(removeBlueprintSlot(props.blueprint, slot.slotId)); setEditError("");
      queueMicrotask(() => document.getElementById("blueprint-heading")?.focus({ preventScroll: true }));
    } catch (failure: any) { setEditError(failure.message); }
  }
  return (
    <>
      <section class="blueprint-panel" classList={{ "is-unscored": req().scoringMode === "none" }}>
        <div class="section-heading">
          <h2 id="blueprint-heading" tabIndex={-1}>题位规划</h2>
          <div class="blueprint-heading-actions"><span class="muted">{slots().length} 题</span><button id="blueprint-add-slot" type="button" class="secondary" disabled={props.busy || !editableTypes().length} onClick={() => openEditor()}><Plus size={16} />新增题位</button></div>
        </div>
        <Show when={!quantity().matches}>
          <section class="blueprint-quantity-review" aria-label="题位数量待调整">
            <h3>题位数量与原需求不一致</h3>
            <Show when={catalogGaps().length}><p role="status">当前考查范围尚未登记{catalogGaps().map(type => typeLabels[type]).join("、")}考查任务，相关题位待安排；这不代表题库没有对应题目。</p></Show>
            <table aria-label="题位数量核对"><thead><tr><th scope="col">题型</th><th scope="col">原定</th><th scope="col">当前</th><th scope="col">差异</th></tr></thead><tbody>
              <For each={blueprintTypes}>{type => <tr classList={{ "has-difference": quantity().expectedCounts[type] !== quantity().actualCounts[type] }}><th scope="row">{typeLabels[type]}</th><td>{quantity().expectedCounts[type]} 题</td><td>{quantity().actualCounts[type]} 题</td><td>{quantity().actualCounts[type] === quantity().expectedCounts[type] ? "一致" : quantity().actualCounts[type] > quantity().expectedCounts[type] ? `多 ${quantity().actualCounts[type] - quantity().expectedCounts[type]} 题` : `少 ${quantity().expectedCounts[type] - quantity().actualCounts[type]} 题`}</td></tr>}</For>
              <tr class="blueprint-quantity-total"><th scope="row">总题量</th><td>{quantity().expectedTotal} 题</td><td>{quantity().actualTotal} 题</td><td>{quantity().actualTotal === quantity().expectedTotal ? "一致" : quantity().actualTotal > quantity().expectedTotal ? `多 ${quantity().actualTotal - quantity().expectedTotal} 题` : `少 ${quantity().expectedTotal - quantity().actualTotal} 题`}</td></tr>
            </tbody></table>
            <p>{quantitySuggestion()}</p>
          </section>
        </Show>
        <TypeTabs slots={slots()} value={tab()} onChange={setTab} />
        <Show when={!editor()}><ErrorBanner message={editError()} /></Show>
        <Show when={review().invalidTasks.length}><p class="warning-text" role="status">第 {review().invalidTasks.map((slot: any) => slot.number).join("、")} 题的考查任务不存在或题型不匹配，请调整题位。</p></Show>
        <Show when={review().invalidPoints.length}><p class="warning-text" role="status">第 {review().invalidPoints.map((slot: any) => slot.number).join("、")} 题分值无效，请填写 0～1000 的整数，并核对小问分值。</p></Show>
        <Show when={review().points !== review().expectedPoints}><p class="warning-text" role="status">分值合计 {review().points} 分，原定 {review().expectedPoints} 分。建议手动调整题位分值至原定总分。</p></Show>
        <Show when={goals().length}>
          <details class="plan-goals" open={missing().length > 0}>
            <summary>教学目标 · {goals().length} 项<Show when={missing().length}><span class="warning-text"> · {missing().length} 项必须目标待关联</span></Show></summary>
            <For each={goals()}>{(goal: any) => <div class="plan-goal-row">
              <div><strong><RichText text={teachingDisplayText(goal.observable || "教学目标")} /></strong><small>{goal.priority === "required" ? "必须" : "偏好"} · 已关联 {linkedGoalSlots(props.blueprint, goal, props.config.tasks || []).length} 个题位</small></div>
              <button aria-label={`关联教学目标：${goal.observable || goal.id}`} disabled={props.busy} onClick={() => openBinding(goal)}><Link2 size={14} />关联题位</button>
            </div>}</For>
            <Show when={missing().length}><p class="warning-text">未关联的必须目标将保留待核对说明，可继续选题。</p></Show>
          </details>
        </Show>
        <div class="plan-labels">
          <span>题位</span>
          <span>
            考查任务 <small>点击修改</small>
          </span>
          <Show when={req().scoringMode !== "none"}>
            <span>分值</span>
          </Show>
        </div>
        <For each={slots().filter((slot: any) => slot.questionType === tab())}>
          {(slot: any) => (
            <div class="plan-row" data-slot-id={slot.slotId}>
              <span class="muted">{slot.number}</span>
              <div>
                <div class="blueprint-task-line"><BlueprintTaskPicker slot={slot} label={slot.taskLabel || props.config.tasks.find((task: any) => task.id === slot.taskId)?.label || "选择考查任务"} options={availableTasks(props.blueprint, slot, props.config.tasks || [])} disabled={props.busy} onChange={id => task(slot, id)} /><BlueprintSlotActions slot={slot} disabled={props.busy} onEdit={() => openEditor(slot)} onRemove={() => remove(slot)} /></div>
                <p class="plan-target-difficulty">目标难度：{slotDifficulty(slot, req(), props.config.assemblyIndex).targetLabel || "未指定"}</p>
                <Show when={slot.planningReason}>
                  <p class="plan-slot-reason"><RichText text={teachingDisplayText(slot.planningReason)} /></p>
                </Show>
              </div>
              <Show when={req().scoringMode !== "none"}>
                <input
                  aria-label={`第 ${slot.number} 题分值`}
                  disabled={props.busy}
                  type="number"
                  min="0"
                  max="1000"
                  value={slot.points}
                  onChange={(event) => {
                    const value = Number(event.currentTarget.value);
                    props.onChange(updateBlueprintPoints(props.blueprint, slot.slotId, value, props.config.tasks || []));
                  }}
                  onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}
                />
              </Show>
            </div>
          )}
        </For>
        <Show when={!slots().length}><p class="muted blueprint-empty">尚无题位，请新增题位并选择真实考查任务。</p></Show>
      </section>
      <footer class="workbench-footer">
        <span class="muted">
          {slots().length} 题 ·{" "}
          {req().scoringMode === "none" ? "不计分" : `${req().targetScore} 分`}
        </span>
        <div class="inline-actions">
          <Show when={!props.configured}><button disabled={props.busy} onClick={props.onConfigure}>配置模型</button></Show>
          <button
            class="primary"
            disabled={props.busy || !review().canSelect}
            onClick={() => props.configured ? props.onSelect("llm") : props.onConfigure()}
          >
            {!slots().length ? "生成草稿，保留缺口" : !quantity().matches ? "继续选题，保留缺口" : "采用安排，开始选题"} <ArrowRight size={17} />
          </button>
        </div>
      </footer>
      <Show when={editor()}>{value => <Modal title={value().slotId ? "调整题位" : "新增题位"} stable onClose={closeEditor} busy={props.busy} footer={<><button type="button" class="secondary" disabled={props.busy} onClick={closeEditor}>取消</button><button type="button" class="primary" disabled={props.busy || !editorTask() || !editorPointsValid()} onClick={saveEditor}>{value().slotId ? "保存题位" : "确认新增"}</button></>}>
        <div class="blueprint-slot-editor">
          <label class="field-label">题型<select aria-label="题位题型" value={value().questionType} disabled={props.busy} onChange={event => setEditor(current => current && ({ ...current, questionType: event.currentTarget.value, taskId: "" }))}><For each={editableTypes()}>{type => <option value={type}>{typeLabels[type]}</option>}</For></select></label>
          <div class="field-label"><span>考查任务</span><BlueprintTaskPicker slot={editorSlot()} label={editorTask()?.label || "请选择考查任务"} options={editorTasks()} disabled={props.busy || !editorTasks().length} onChange={taskId => setEditor(current => current && ({ ...current, taskId }))} /></div>
          <Show when={!editorTasks().length}><p class="warning-text">本次范围内没有此题型的考查任务，请修改需求范围或补充题库任务。</p></Show>
          <Show when={req().scoringMode !== "none"}><label class="field-label">分值<input type="number" aria-label="题位分值" min="0" max="1000" value={value().points} disabled={props.busy} onInput={event => setEditor(current => current && ({ ...current, points: Number(event.currentTarget.value) }))} /></label></Show>
          <ErrorBanner message={editError()} />
        </div>
      </Modal>}</Show>
      <Show when={bindingGoal()}>
        <Modal title="关联教学目标" stable onClose={() => setBindingGoal(null)} busy={props.busy}
          footer={<><button class="secondary" disabled={props.busy} onClick={() => setBindingGoal(null)}>取消</button><button class="primary" disabled={props.busy || (bindingGoal().priority === "required" && !bindingSlots().length)} onClick={() => {
            try { props.onChange(bindBlueprintGoal(props.blueprint, bindingGoal().id, bindingSlots(), props.config.tasks || [])); setBindingGoal(null); }
            catch (error: any) { setBindingError(error.message); }
          }}>确认关联</button></>}>
          <p><RichText text={teachingDisplayText(bindingGoal().observable)} /></p>
          <p class="muted">选择承担该目标的题位。关联表示选题要求，不代表题目已证实覆盖目标。</p>
          <ErrorBanner message={bindingError()} />
          <div class="plan-goal-options">
            <For each={goalSlots(props.blueprint, bindingGoal(), props.config.tasks || [])}>{(slot: any) => <label>
              <input type="checkbox" aria-label={`关联第 ${slot.number} 题`} checked={bindingSlots().includes(slot.slotId)} disabled={props.busy} onChange={event => setBindingSlots(ids => event.currentTarget.checked ? [...ids, slot.slotId] : ids.filter(id => id !== slot.slotId))} />
              <span><strong>第 {slot.number} 题 · {typeLabels[slot.questionType]}</strong><small><RichText text={teachingDisplayText(slot.taskLabel || props.config.tasks.find((task: any) => task.id === slot.taskId)?.label || "未指定考查任务")} /></small></span>
            </label>}</For>
          </div>
          <Show when={!goalSlots(props.blueprint, bindingGoal(), props.config.tasks || []).length}><p class="warning-text">暂无兼容题位，请先调整考查任务或修改需求。</p></Show>
          <Show when={bindingGoal().priority === "required" && !bindingSlots().length}><p class="warning-text">必须目标至少需要一个兼容题位。</p></Show>
        </Modal>
      </Show>
    </>
  );
}
