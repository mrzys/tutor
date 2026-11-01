import test from "node:test";
import assert from "node:assert/strict";
import { importFailure, importStage, teachingFailureStage } from "../src/import-process.ts";
import { importQuestionTriage } from "../src/import-triage.ts";

test("simulated observed stages preserve source index, transcription and teaching distinctions", () => {
  for (const [stage, expected] of [["recognizing", "ocr"], ["source_indexing", "source_index"], ["structuring", "source_transcription"], ["teaching_generating", "teaching_generation"], ["teaching_review", "teaching_review"], ["annotating", "annotation"]]) {
    assert.equal(importStage({ recognitionStage: stage, status: "processing" }).key, expected);
  }
  assert.equal(importStage({ status: "failed", recognitionStage: "future_stage" }).key, "unknown");
  assert.equal(importStage({ status: "failed" }, { stage: "structuring", status: "failed" }).stateLabel, "停在此阶段");
  assert.equal(importStage({ status: "failed", recognitionStage: "structuring" }, undefined, { stageKey: "source_validation" }).key, "source_validation");
  assert.equal(importStage({ status: "pending_review" }).key, "user_review");
});

test("simulated network and service failures never become proof of poor model reasoning", () => {
  for (const code of ["model_request_timeout", "model_response_timeout", "model_catalog_error", "ocr_network", "import_model_not_configured", "storage_error"]) {
    const view = importFailure({ code, message: "模拟具体失败" });
    assert.equal(view.category, "infrastructure");
    assert.equal(view.summary, "模拟具体失败");
  }
  assert.match(importFailure({ code: "model_request_timeout" }).causeNote, /不足以断定/);
  assert.equal(importFailure({ code: "model_error" }).category, "unknown");
  for (const code of ["future_error", "constructor", "__proto__"]) assert.equal(importFailure({ code }).category, "unknown");
});

test("simulated malformed output and source conflicts lead to different handling", () => {
  assert.equal(importFailure({ code: "model_output_invalid_json" }).category, "model_output");
  assert.equal(importFailure({ code: "model_output_truncated" }).category, "model_output");
  for (const code of ["source_plan_invalid", "ocr_question_coverage", "ocr_material_unassigned"]) {
    const view = importFailure({ code });
    assert.equal(view.category, "business");
    assert.match(view.nextAction, /不猜补/);
  }
  assert.equal(importFailure({ code: "revision_conflict" }).category, "business");
  assert.match(importFailure({ code: "revision_conflict" }).nextAction, /重新读取最新版本/);
});

test("simulated verified backend projection takes priority without altering original errors", () => {
  const error = { code: "model_error", message: "旧笼统错误" };
  const diagnostic = { stageKey: "source_transcription", stageLabel: "分批转录原题", category: "infrastructure", summary: "服务返回 HTTP 503", nextAction: "等待服务恢复后继续缺批", operationLabel: "转录请求", serviceLabel: "拆题模型服务", causeNote: "已收到服务端错误响应" };
  const before = structuredClone({ error, diagnostic });
  const view = importFailure(error, { diagnostic });
  assert.equal(view.category, "infrastructure");
  assert.equal(view.stageKey, "source_transcription");
  assert.equal(view.summary, diagnostic.summary);
  assert.equal(view.nextAction, diagnostic.nextAction);
  assert.deepEqual({ error, diagnostic }, before);
});

test("simulated per-question technical and content findings retain eligibility and evidence", () => {
  for (const [finding, expected] of [
    [{ type: "technical", code: "model_request_timeout", message: "模拟连接超时" }, "infrastructure"],
    [{ type: "display", code: "literal_newline_escape" }, "model_output"],
    [{ type: "quality", dimension: "proof", message: "模型提示缺少取等条件" }, "model_output"],
    [{ type: "quality", dimension: "material", fieldPath: "stem", message: "模型提示原题条件需核对" }, "business"],
  ]) {
    const question = { questionId: "sim-process", stem: "模拟题目", modelReview: { status: "ready" }, teachingWorkflow: { status: "needs_review", reviewCalls: 1, candidateResult: { answer: "1", teachingSolution: "模拟解析" }, findings: [finding] } };
    const before = structuredClone(question);
    const row = importQuestionTriage(question, { eligibility: { eligible: true, method: "teacher_review" } });
    assert.equal(row.issues[0].process.category, expected);
    assert.equal(row.eligible, true);
    assert.equal(row.teachingState, "needs_review");
    if (row.issues[0].process.stageKey === "teaching_review") assert.match(row.issues[0].process.nextAction, /复核次数已使用/);
    assert.deepEqual(question, before);
  }
  assert.equal(teachingFailureStage({ status: "generation_failed", reviewCalls: 0 }, "teaching"), "teaching_generation");
  assert.equal(teachingFailureStage({ status: "needs_review", reviewCalls: 1 }, "teaching"), "teaching_review");
});
