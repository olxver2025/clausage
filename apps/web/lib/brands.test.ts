import { describe, expect, it } from "vitest";
import { modelOrg } from "./brands";

describe("modelOrg", () => {
  it.each([
    ["claude-opus-5-5", "anthropic"],
    ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "anthropic"],
    ["openrouter/anthropic/claude-haiku-4.5", "anthropic"],
    ["gpt-6.1-sol", "openai"],
    ["o3-mini", "openai"],
    ["grok-code-fast-1", "xai"],
    ["gemini-3-pro-preview", "google"],
    ["deepseek-v3.2", "deepseek"],
    ["qwen3-coder-plus", "qwen"],
    ["kimi-k2-thinking", "moonshot"],
    ["glm-4.6", "zai"],
    ["devstral-medium", "mistral"],
    ["hermes-4-405b", "nous"],
  ])("%s → %s", (model, org) => {
    expect(modelOrg(model)).toBe(org);
  });

  it("falls back to the provider and returns undefined for unknown models", () => {
    expect(modelOrg("big-pickle", "openai")).toBe("openai");
    expect(modelOrg("big-pickle")).toBeUndefined();
  });
});
