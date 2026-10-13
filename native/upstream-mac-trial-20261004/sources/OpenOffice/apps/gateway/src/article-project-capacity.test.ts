import assert from "node:assert/strict";
import test from "node:test";
import { ARTICLE_PROJECT_CAPACITY as gatewayCapacity } from "./article-project-capacity.js";
import { ARTICLE_PROJECT_CAPACITY as authorityCapacity } from "../../../../../integration-slice-20261004/authority/article-project-capacity.mjs";

test("article project capacity definitions do not drift across authority and gateway", () => {
  assert.deepEqual(gatewayCapacity, authorityCapacity);
});
