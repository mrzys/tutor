import test from "node:test";
import assert from "node:assert/strict";
import { reviewRowsForFilter, nextReviewQuestion, reviewStatusLabel, sourceReviewState,
  isReviewReady, isTeachingPending, isBothReviewReady, importReviewSummary } from "../src/import-review-flow.ts";

const row = (id, extra = {}) => ({ questionId: id, question: {questionId: id, sourceLabel: id}, eligible: false,
  published: false, needsAction: false, duplicateState: "none", sourceState: "pending", teachingState: "not_started",
  issues: [], notices: [], ...extra });

test("simulated 19-question scope-only regression counts 10 eligible originals and 8 eligible AI drafts", () => {
  const paper = [], eligibility = {};
  for (let i = 0; i < 19; i++) {
    const id = `sim-${i + 1}`, eligible = i < 10, sourceOnly = i === 8 || i === 9;
    paper.push(row(id, {eligible, teachingState: sourceOnly ? "needs_review" : "ready", duplicateState: i === 18 ? "exact" : "none",
      question: {questionId: id, sourceLabel: String(i + 1), teachingWorkflow: {status: sourceOnly ? "needs_review" : "ready_candidate"}}}));
    eligibility[id] = {eligible, publicationScope: sourceOnly ? "source_only" : i < 17 ? "source_and_teaching" : undefined};
  }
  assert.equal(Object.values(eligibility).filter(item => item.publicationScope === "source_and_teaching").length, 15);
  assert.equal(Object.values(eligibility).filter(item => item.publicationScope === "source_and_teaching"
    || item.publicationScope === "source_only").length, 17); // The previous scope-only counter reproduced the incorrect 17.
  const summary = importReviewSummary(paper, eligibility);
  assert.deepEqual(summary, {total: 19, sourcePending: 8, sourceReady: 10, published: 0, duplicate: 1, rejected: 0,
    teachingPending: 2, bothReady: 8, sourceOnlyReady: 2});
  assert.deepEqual(reviewRowsForFilter(paper, "both_ready", eligibility).map(item => item.questionId), paper.slice(0, 8).map(item => item.questionId));
  assert.deepEqual(reviewRowsForFilter(paper, "source_pending", eligibility).map(item => item.questionId), paper.slice(10, 18).map(item => item.questionId));
  assert.equal(summary.sourceReady + summary.published + summary.duplicate + summary.rejected + summary.sourcePending, 19);
});

test("simulated conflicting flags follow published, duplicate, rejected, eligible, pending priority", () => {
  const paper = [row("published", {published: true, duplicateState: "exact", eligible: true, question: {reviewDecision: "reject"}}),
    row("duplicate", {duplicateState: "exact", eligible: true, question: {reviewDecision: "reject"}}),
    row("rejected", {eligible: true, question: {reviewDecision: "reject"}}), row("eligible", {eligible: true, needsAction: true}),
    row("pending", {needsAction: false})];
  assert.deepEqual(paper.map(sourceReviewState), ["published", "duplicate", "rejected", "eligible", "pending"]);
  assert.deepEqual(importReviewSummary(paper), {total: 5, sourcePending: 1, sourceReady: 1, published: 1, duplicate: 1,
    rejected: 1, teachingPending: 0, bothReady: 0, sourceOnlyReady: 0});
  for (const [filter, id] of [["published", "published"], ["duplicate", "duplicate"], ["rejected", "rejected"],
    ["source_ready", "eligible"], ["source_pending", "pending"]]) {
    assert.deepEqual(reviewRowsForFilter(paper, filter).map(item => item.questionId), [id]);
  }
  assert.deepEqual(paper.map(reviewStatusLabel), ["原题已入库", "题库已有此题", "本题未采用", "原题可入库", "本题待核对"]);
});

test("simulated scope, source state, local approval and truthy values cannot grant server readiness", () => {
  const paper = [row("scope-only", {sourceState: "eligible", question: {reviewDecision: "approve"}}),
    row("truthy", {eligible: "true"}), row("scope-stale", {eligible: true}), row("scope-current", {eligible: true}),
    row("duplicate", {eligible: true, duplicateState: "exact"})];
  const eligibility = {
    "scope-only": {eligible: false, publicationScope: "source_and_teaching"},
    truthy: {eligible: true, publicationScope: "source_and_teaching"},
    "scope-stale": {eligible: false, publicationScope: "source_and_teaching"},
    "scope-current": {eligible: true, publicationScope: "source_and_teaching"},
    duplicate: {eligible: true, publicationScope: "source_and_teaching"},
  };
  assert.equal(isReviewReady(paper[0]), false); assert.equal(isReviewReady(paper[1]), false);
  assert.deepEqual(paper.map(item => isBothReviewReady(item, eligibility)), [false, false, false, true, false]);
  assert.equal(isBothReviewReady(paper[3], {}), false);
});

test("simulated published AI work remains findable without turning adopted history or rejected copies into tasks", () => {
  const pendingIssue = {domain: "teaching", code: "unresolved-proof"};
  const receipt = {domain: "teaching", code: "teaching_publication_receipt_pending"};
  const paper = [row("published-awaiting-adoption", {published: true, teachingState: "ready"}),
    row("published-proof-pending", {published: true, teachingState: "needs_review", issues: [pendingIssue]}),
    row("adopted-receipt", {published: true, teachingState: "adopted", issues: [receipt]}),
    row("adopted-old-finding", {published: true, teachingState: "adopted", issues: [pendingIssue]}),
    row("no-AI-chosen", {published: true, teachingState: "not_adopted"}),
    row("duplicate-copy", {duplicateState: "exact", issues: [pendingIssue]}),
    row("rejected-copy", {question: {reviewDecision: "reject"}, issues: [pendingIssue]}),
    row("generation-pending", {question: {teachingWorkflow: {status: "generation_pending"}}})];
  assert.deepEqual(reviewRowsForFilter(paper, "teaching").map(item => item.questionId),
    ["published-awaiting-adoption", "published-proof-pending", "adopted-receipt", "generation-pending"]);
  assert.equal(importReviewSummary(paper).teachingPending, 4);
  assert.equal(importReviewSummary(paper).published, 5);
  assert.equal(importReviewSummary(paper).sourcePending, 1);
  assert.equal(isTeachingPending(row("source-only", {eligible: true, teachingState: "needs_review",
    question: {teachingWorkflow: {status: "needs_review"}}})), true);
});

test("simulated task navigation wraps exact question IDs without changing the paper order or source labels", () => {
  const paper = [row("exact-qid-9", {eligible: true, question: {sourceLabel: "9"}}),
    row("exact-qid-27", {question: {sourceLabel: "27"}}),
    row("exact-qid-5", {published: true, teachingState: "ready", question: {sourceLabel: "5"}})];
  const before = structuredClone(paper);
  assert.equal(nextReviewQuestion(paper, "exact-qid-9", "source_pending"), "exact-qid-27");
  assert.equal(nextReviewQuestion(paper, "exact-qid-27", "source_pending"), null);
  assert.equal(nextReviewQuestion(paper, "exact-qid-5", "source_pending"), "exact-qid-27");
  assert.equal(nextReviewQuestion(paper, "exact-qid-27", "teaching"), "exact-qid-5");
  assert.equal(nextReviewQuestion(paper, "exact-qid-5", "teaching"), null);
  assert.equal(nextReviewQuestion(paper, "exact-qid-5"), "exact-qid-27");
  assert.equal(nextReviewQuestion(paper, "exact-qid-27", "previous"), "exact-qid-9");
  assert.equal(nextReviewQuestion(paper, "exact-qid-5", "next"), null);
  assert.equal(nextReviewQuestion(paper, "missing", "source_pending"), null);
  assert.deepEqual(reviewRowsForFilter(paper, "all"), paper);
  assert.deepEqual(paper, before);
});
