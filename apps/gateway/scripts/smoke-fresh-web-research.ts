import assert from "node:assert/strict";
import { looksLikeFreshWebResearchTask, computeIntentRouteDecisionPhase0 } from "../src/agent/runFactory";
import { detectRunIntent } from "@ohmycrab/agent-core";

function ok(name: string) {
  console.log(`ok ${name}`);
}

{
  const prompt = "搜索今天科技和财经圈的热点，多搜几轮，然后找一个大概率会爆的话题，用李叔风格写一篇口播稿并生成文件";
  assert.equal(looksLikeFreshWebResearchTask(prompt), true);
  const mode = "agent" as const;
  const intent = detectRunIntent({ mode, userPrompt: prompt });
  const route = computeIntentRouteDecisionPhase0({ mode, userPrompt: prompt, intent, runTodo: [], mainDoc: null });
  assert.equal(route.routeId, "task_execution");
  ok("fresh_web_research.mixed_search_write_prompt");
}

{
  const prompt = "打开 google 页面搜索 openclaw";
  assert.equal(looksLikeFreshWebResearchTask(prompt), false);
  ok("fresh_web_research.direct_open_is_not_mixed_research");
}

{
  const prompt = "在项目里搜索 web.search 为什么不可用";
  assert.equal(looksLikeFreshWebResearchTask(prompt), false);
  ok("fresh_web_research.project_search_not_web_research");
}
