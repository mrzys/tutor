import { For, Show, createEffect, createSignal } from "solid-js";
import { ArrowRight, Link2, Pencil } from "lucide-solid";
import { typeLabels } from "./bridge";
import { ErrorBanner, Modal, TypeTabs } from "./ui";
import { availableTasks, bindBlueprintGoal, changeBlueprintTask, goalSlots, linkedGoalSlots, missingRequiredGoals } from "./blueprint-goals";

export function BlueprintView(props: {
  blueprint: any;
  config: any;
  busy: boolean;
  onChange: (value: any) => void;
  onSelect: (mode: string) => void;
  configured: boolean;
}) {
  const [tab, setTab] = createSignal("single_choice");
  const [editing, setEditing] = createSignal("");
  const [bindingGoal, setBindingGoal] = createSignal<any>(null);
  const [bindingSlots, setBindingSlots] = createSignal<string[]>([]);
  const [bindingError, setBindingError] = createSignal("");
  const [editError, setEditError] = createSignal("");
  const [mode, setMode] = createSignal(props.configured ? "llm" : "rule");
  const slots = () => props.blueprint?.slots || [];
  const req = () => props.blueprint?.requirements || {};
  const goals = () => req().teachingGoals || [];
  const missing = () => missingRequiredGoals(props.blueprint, props.config.tasks || []);
  createEffect(() => {
    if (!slots().some((slot: any) => slot.questionType === tab()))
      setTab(slots()[0]?.questionType || "single_choice");
  });
  function task(slot: any, id: string) {
    const chosen = props.config.tasks.find((item: any) => item.id === id);
    setEditError("");
    try { props.onChange(changeBlueprintTask(props.blueprint, slot.slotId, chosen)); }
    catch (error: any) { setEditError(error.message); }
    setEditing("");
  }
  function openBinding(goal: any) {
    setBindingGoal(goal);
    setBindingSlots(linkedGoalSlots(props.blueprint, goal, props.config.tasks || []).map((slot: any) => slot.slotId));
    setBindingError("");
  }
  return (
    <>
      <section class="blueprint-panel">
        <div class="section-heading">
          <h2>题位规划</h2>
          <span class="muted">{slots().length} 题</span>
        </div>
        <TypeTabs slots={slots()} value={tab()} onChange={setTab} />
        <ErrorBanner message={editError()} />
        <Show when={goals().length}>
          <details class="plan-goals" open={missing().length > 0}>
            <summary>教学目标 · {goals().length} 项<Show when={missing().length}><span class="warning-text"> · {missing().length} 项必须目标待关联</span></Show></summary>
            <For each={goals()}>{(goal: any) => <div class="plan-goal-row">
              <div><strong>{goal.observable || "教学目标"}</strong><small>{goal.priority === "required" ? "必须" : "偏好"} · 已关联 {linkedGoalSlots(props.blueprint, goal, props.config.tasks || []).length} 个题位</small></div>
              <button aria-label={`关联教学目标：${goal.observable || goal.id}`} disabled={props.busy} onClick={() => openBinding(goal)}><Link2 size={14} />关联题位</button>
            </div>}</For>
            <Show when={missing().length}><p class="warning-text">请为每项必须目标关联至少一个兼容题位，再开始选题。</p></Show>
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
            <div class="plan-row">
              <span class="muted">{slot.number}</span>
              <div>
                <Show
                  when={editing() === slot.slotId}
                  fallback={
                    <button
                      class="plan-task"
                      onClick={() => setEditing(slot.slotId)}
                      disabled={props.busy}
                    >
                      {slot.taskLabel ||
                        props.config.tasks.find(
                          (task: any) => task.id === slot.taskId,
                        )?.label ||
                        "选择考查任务"}
                      <Pencil size={13} />
                    </button>
                  }
                >
                  <select
                    aria-label={`第 ${slot.number} 题考查任务`}
                    disabled={props.busy}
                    value={slot.taskId}
                    onChange={(event) => task(slot, event.currentTarget.value)}
                    onBlur={() => setEditing("")}
                  >
                    <For
                      each={availableTasks(props.blueprint, slot, props.config.tasks)}
                    >
                      {(item) => <option value={item.id}>{item.label}</option>}
                    </For>
                  </select>
                </Show>
                <Show when={slot.planningReason}>
                  <details class="plan-detail">
                    <summary>详情</summary>
                    <p class="muted">{slot.planningReason}</p>
                  </details>
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
                  onInput={(event) => {
                    const value = Number(event.currentTarget.value);
                    const next = structuredClone(props.blueprint);
                    const target = next.slots.find(
                      (item: any) => item.slotId === slot.slotId,
                    );
                    target.points = value;
                    const parts = target.partPoints || [];
                    target.partPoints = parts.map(
                      (part: any, index: number) => ({
                        ...part,
                        points:
                          Math.floor(value / parts.length) +
                          (index < value % parts.length ? 1 : 0),
                      }),
                    );
                    props.onChange(next);
                  }}
                />
              </Show>
            </div>
          )}
        </For>
      </section>
      <footer class="workbench-footer">
        <span class="muted">
          {slots().length} 题 ·{" "}
          {req().scoringMode === "none" ? "不计分" : `${req().targetScore} 分`}
        </span>
        <div class="inline-actions">
          <select
            aria-label="选题方式"
            value={mode()}
            disabled={props.busy}
            onChange={(event) => setMode(event.currentTarget.value)}
          >
            <option value="llm" disabled={!props.configured}>
              AI 比较{props.configured ? "" : "（需设置）"}
            </option>
            <option value="rule">规则选题</option>
          </select>
          <button
            class="primary"
            disabled={props.busy || missing().length > 0}
            onClick={() => props.onSelect(mode())}
          >
            采用安排，开始选题 <ArrowRight size={17} />
          </button>
        </div>
      </footer>
      <Show when={bindingGoal()}>
        <Modal title="关联教学目标" stable onClose={() => setBindingGoal(null)} busy={props.busy}
          footer={<><button class="secondary" disabled={props.busy} onClick={() => setBindingGoal(null)}>取消</button><button class="primary" disabled={props.busy || (bindingGoal().priority === "required" && !bindingSlots().length)} onClick={() => {
            try { props.onChange(bindBlueprintGoal(props.blueprint, bindingGoal().id, bindingSlots(), props.config.tasks || [])); setBindingGoal(null); }
            catch (error: any) { setBindingError(error.message); }
          }}>确认关联</button></>}>
          <p>{bindingGoal().observable}</p>
          <p class="muted">选择承担该目标的题位。关联表示选题要求，不代表题目已证实覆盖目标。</p>
          <ErrorBanner message={bindingError()} />
          <div class="plan-goal-options">
            <For each={goalSlots(props.blueprint, bindingGoal(), props.config.tasks || [])}>{(slot: any) => <label>
              <input type="checkbox" aria-label={`关联第 ${slot.number} 题`} checked={bindingSlots().includes(slot.slotId)} disabled={props.busy} onChange={event => setBindingSlots(ids => event.currentTarget.checked ? [...ids, slot.slotId] : ids.filter(id => id !== slot.slotId))} />
              <span><strong>第 {slot.number} 题 · {typeLabels[slot.questionType]}</strong><small>{slot.taskLabel || props.config.tasks.find((task: any) => task.id === slot.taskId)?.label}</small></span>
            </label>}</For>
          </div>
          <Show when={!goalSlots(props.blueprint, bindingGoal(), props.config.tasks || []).length}><p class="warning-text">暂无兼容题位，请先调整考查任务或修改需求。</p></Show>
          <Show when={bindingGoal().priority === "required" && !bindingSlots().length}><p class="warning-text">必须目标至少需要一个兼容题位。</p></Show>
        </Modal>
      </Show>
    </>
  );
}
