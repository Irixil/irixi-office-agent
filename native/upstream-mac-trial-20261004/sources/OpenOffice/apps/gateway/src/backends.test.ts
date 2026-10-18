import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getBackend } from "./backends.js";

function matchesSchema(schema: any, value: any): boolean {
  if (schema.anyOf) return schema.anyOf.some((branch: any) => matchesSchema(branch, value));
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (!types.includes(actual) && !(actual === "number" && types.includes("integer"))) return false;
  if (types.includes("integer") && actual === "number" && !Number.isInteger(value)) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (actual === "array") return value.every((item: any) => matchesSchema(schema.items, item));
  if (actual === "object") {
    if (schema.required?.some((key: string) => !(key in value))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
    return Object.entries(value).every(([key, item]) => !schema.properties[key] || matchesSchema(schema.properties[key], item));
  }
  return true;
}

test("Codex planning calls disable delegation and shell execution", () => {
  const backend = getBackend("codex");
  assert.ok(backend);
  assert.equal(backend.supportsStructuredOutput, false);
  const args = backend.buildArgs("plan only", {
    fullAccess: false,
    noTools: true,
    readOnly: true,
    model: "gpt-5.6-sol",
  });
  assert.deepEqual(args.slice(0, 2), ["--ask-for-approval", "on-request"]);
  for (const feature of ["multi_agent", "shell_tool", "skill_search", "tool_suggest", "apps", "browser_use",
    "computer_use", "image_generation", "workspace_dependencies"]) {
    const index = args.indexOf(feature);
    assert.equal(args[index - 1], "--disable");
  }
  assert.deepEqual(args.slice(args.indexOf("mcp_servers={}") - 1, args.indexOf("plugins={}") + 1), [
    "-c", "mcp_servers={}", "-c", "plugins={}",
  ]);
  assert.equal(args[args.indexOf("gpt-5.6-sol") - 1], "--model");
  assert.deepEqual(args.slice(-5), ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-"]);
});

test("Codex product workers keep shell access but cannot spawn unmetered CLI subagents", () => {
  const backend = getBackend("codex");
  assert.ok(backend);
  const args = backend.buildArgs("implement", {
    fullAccess: false, noTools: false, disableMultiAgent: true,
    readOnly: false, model: "gpt-5.6-sol",
  });
  const multiAgent = args.indexOf("multi_agent");
  assert.equal(args[multiAgent - 1], "--disable");
  assert.equal(args.includes("shell_tool"), false);
  assert.deepEqual(args.slice(-5), ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "-"]);
});

test("Codex applies medium only as the explicit bound GPT-6 Luna product effort", () => {
  const backend = getBackend("codex");
  assert.ok(backend);
  const args = backend.buildArgs("implement", {
    fullAccess: false, noTools: false, readOnly: false,
    model: "gpt-6-luna", modelReasoningEffort: "medium",
  });
  const configIndex = args.indexOf("model_reasoning_effort=medium");
  assert.ok(configIndex > 0);
  assert.equal(args[configIndex - 1], "-c");
  assert.ok(configIndex < args.indexOf("exec"));
  assert.equal(args[args.indexOf("gpt-6-luna") - 1], "--model");
  assert.equal(backend.buildArgs("generic", { model: "gpt-6-luna" }).includes("model_reasoning_effort=medium"), false);
  assert.equal(backend.buildArgs("other model", { model: "gpt-5.6-sol", modelReasoningEffort: "medium" }).includes("model_reasoning_effort=medium"), false);
});

test("Codex adds only a fixed learning schema path when selected", () => {
  const backend = getBackend("codex");
  assert.ok(backend);
  const schemaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schemas");
  for (const schema of ["article-learning-explain", "article-learning-assess"] as const) {
    const file = path.join(schemaRoot, `${schema}.json`);
    assert.ok(existsSync(file));
    const source = readFileSync(file, "utf8");
    assert.ok(Buffer.byteLength(source, "utf8") <= 8192, "schema fits the existing protocol reserve upper bound");
    assert.equal(JSON.parse(source).type, "object");
    assert.equal(backend.outputSchemaUtf8Bytes?.(schema), Buffer.byteLength(source, "utf8"));
    const args = backend.buildArgs("registered", { model: "gpt-6-luna", outputSchema: schema });
    const index = args.indexOf("--output-schema");
    assert.ok(index > 0);
    assert.equal(args[index + 1], file);
  }
  assert.equal(backend.buildArgs("ordinary", { model: "gpt-6-luna" }).includes("--output-schema"), false);
});

test("learning schemas accept complete explain and assess response shapes", () => {
  const schemaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schemas");
  const explain = JSON.parse(readFileSync(path.join(schemaRoot, "article-learning-explain.json"), "utf8"));
  const assess = JSON.parse(readFileSync(path.join(schemaRoot, "article-learning-assess.json"), "utf8"));
  assert.equal("purpose" in explain.properties, false);
  assert.equal(explain.required.includes("purpose"), false);
  assert.ok(assess.properties.activityQualification.properties.semanticType.enum.includes("misconception"));
  const explainSample = {
    concepts: [{ id: "c1", title: "相关", location: "P1", sourceQuote: "引文", authorView: "作者观点", aiAnalysis: "分析", plainExplanation: "解释", familiarExample: "例子", relations: [] }],
    coverage: [{ conceptId: "c1", questionTypes: ["cause"], questions: [{ type: "cause", question: "为什么？" }] }],
    plan: { status: "complete", basis: "依据", importantConceptIds: ["c1"], coveredLocations: ["P1"], locationCoverage: [{ location: "P1", conceptIds: ["c1"], sourceQuote: "引文", treatment: "讲解", nonConceptReason: null }] },
  };
  const assessSample = {
    verdict: "partial", correct: [], errors: [], omissions: [], evidence: [], remediation: { explanation: "补充", example: "例子" },
    retest: { question: "新题", unseenWhy: "新场景" }, conceptResults: [{ id: "c1", label: "相关", status: "weak", evidenceIndexes: [], deficiency: { type: "error", index: 0 } }],
    activityQualification: { question: "为什么？", requestedType: "misconception", semanticType: "misconception", supported: true, unseen: false, sourceTurnId: "", rationale: "题目要求识别并解释相关不等于因果的误区" },
  };
  assert.equal(matchesSchema(explain, explainSample), true);
  assert.equal(matchesSchema(assess, assessSample), true);
  assert.equal(matchesSchema(assess, { ...assessSample, conceptResults: [{ ...assessSample.conceptResults[0], deficiency: null }] }), true);
});
