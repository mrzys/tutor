import test from "node:test";
import assert from "node:assert/strict";
import { canonicalScope, filterScopeNodes, scopeCheckState, scopeNodes, toggleScopes } from "../src/scope-tree.ts";

// Simulated curriculum identities; no personal database or model is used.
const catalog = { textbooks: [{ id: "rja-compulsory-1", title: "模拟教材", chapters: [
  { id: "rja-compulsory-1:1", title: "模拟第一章", sections: [
    { id: "rja-compulsory-1:1.1", title: "模拟集合概念" },
    { id: "rja-compulsory-1:1.2", title: "模拟集合关系" },
    { id: "rja-compulsory-1:1.3", title: "模拟无任务小节" },
  ] },
  { id: "rja-compulsory-1:2", title: "模拟第二章", sections: [{ id: "rja-compulsory-1:2.1", title: "模拟不等式" }] },
] }] };
const chapters = [{ id: "rja-compulsory-1:2.1" }, { id: "1.2" }, { id: "1.3" }, { id: "1.1" }];
const tasks = [{ sectionIds: ["1.1", "1.2", "rja-compulsory-1:2.1"] }];

test("simulated scope tree follows actual curriculum hierarchy and retains only configured task identities as choices", () => {
  const nodes = scopeNodes(catalog, chapters, tasks);
  assert.equal(nodes[0].label, "模拟教材");
  assert.deepEqual(nodes[0].children.map(node => node.key), ["chapter:rja-compulsory-1:1", "chapter:rja-compulsory-1:2"]);
  assert.deepEqual(nodes[0].children[0].children.map(node => node.scopeId), ["1.1", "1.2", undefined]);
  assert.deepEqual(nodes[0].selectableIds, ["1.1", "1.2", "rja-compulsory-1:2.1"]);
  assert.deepEqual(scopeNodes({}, chapters, tasks), []);
});

test("simulated search preserves ancestors and parent selection affects matching leaves only", () => {
  const nodes = scopeNodes(catalog, chapters, tasks);
  const result = filterScopeNodes(nodes, "集合概念");
  assert.equal(result[0].label, "模拟教材");
  assert.equal(result[0].children[0].label, "模拟第一章");
  assert.deepEqual(result[0].selectableIds, ["1.1"]);
  assert.deepEqual(toggleScopes(["1.2"], result[0].selectableIds, true), ["1.2", "1.1"]);
  assert.deepEqual(filterScopeNodes(nodes, "模拟第一章")[0].selectableIds, ["1.1", "1.2"]);
  assert.deepEqual(filterScopeNodes(nodes, "不存在"), []);
});

test("simulated bulk checks preserve original IDs, unrelated selections, and documented aliases", () => {
  const current = ["rja-compulsory-1:1.1", "local-extra-scope"];
  assert.deepEqual(scopeCheckState(["1.1", "1.2"], current), { count: 1, checked: false, mixed: true });
  assert.deepEqual(toggleScopes(current, ["1.1", "1.2"], true), [...current, "1.2"]);
  assert.deepEqual(toggleScopes(current, ["1.1"], false), ["local-extra-scope"]);
  assert.deepEqual(current, ["rja-compulsory-1:1.1", "local-extra-scope"]);
  assert.equal(canonicalScope("2.1"), "2.1");
  assert.equal(scopeCheckState([], current).checked, false);
});
