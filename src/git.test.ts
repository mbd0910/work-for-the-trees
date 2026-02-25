import { describe, expect, test } from "bun:test";
import { extractPlanNamesFromSessionContent } from "./git.ts";

/** Helper to build a JSONL line for an assistant message with tool_use blocks */
function assistantToolUse(
  blocks: Array<{ name: string; input: Record<string, unknown> }>
): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: blocks.map((b) => ({
        type: "tool_use",
        id: "test-id",
        name: b.name,
        input: b.input,
      })),
    },
  });
}

/** Helper to build a JSONL line for a tool_result (human turn returning tool output) */
function toolResult(content: string): string {
  return JSON.stringify({
    type: "human",
    message: {
      content: [{ type: "tool_result", tool_use_id: "test-id", content }],
    },
  });
}

describe("extractPlanNamesFromSessionContent", () => {
  test("extracts plan names from tool_use input (Write)", () => {
    const content = assistantToolUse([
      {
        name: "Write",
        input: {
          file_path: "/home/user/.claude/plans/sunny-running-fox.md",
          content: "# My plan",
        },
      },
    ]);
    expect(extractPlanNamesFromSessionContent(content)).toEqual([
      "sunny-running-fox.md",
    ]);
  });

  test("extracts plan names from tool_use input (Read)", () => {
    const content = assistantToolUse([
      {
        name: "Read",
        input: { file_path: "/home/user/.claude/plans/calm-blue-river.md" },
      },
    ]);
    expect(extractPlanNamesFromSessionContent(content)).toEqual([
      "calm-blue-river.md",
    ]);
  });

  test("extracts plan names from tool_use input (Edit)", () => {
    const content = assistantToolUse([
      {
        name: "Edit",
        input: {
          file_path: "/home/user/.claude/plans/bright-green-leaf.md",
          old_string: "old",
          new_string: "new",
        },
      },
    ]);
    expect(extractPlanNamesFromSessionContent(content)).toEqual([
      "bright-green-leaf.md",
    ]);
  });

  test("ignores plan paths in tool_result output", () => {
    const lines = [
      toolResult(
        [
          "/home/user/.claude/plans/sunny-running-fox.md",
          "/home/user/.claude/plans/calm-blue-river.md",
          "/home/user/.claude/plans/bright-green-leaf.md",
        ].join("\n")
      ),
    ].join("\n");
    expect(extractPlanNamesFromSessionContent(lines)).toEqual([]);
  });

  test("ignores plan paths in non-assistant message types", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        message: {
          content:
            "Please read /home/user/.claude/plans/sneaky-red-herring.md",
        },
      }),
    ].join("\n");
    expect(extractPlanNamesFromSessionContent(lines)).toEqual([]);
  });

  test("deduplicates plan names across multiple tool_use blocks", () => {
    const lines = [
      assistantToolUse([
        {
          name: "Write",
          input: {
            file_path: "/home/user/.claude/plans/sunny-running-fox.md",
            content: "v1",
          },
        },
      ]),
      assistantToolUse([
        {
          name: "Edit",
          input: {
            file_path: "/home/user/.claude/plans/sunny-running-fox.md",
            old_string: "v1",
            new_string: "v2",
          },
        },
      ]),
    ].join("\n");
    expect(extractPlanNamesFromSessionContent(lines)).toEqual([
      "sunny-running-fox.md",
    ]);
  });

  test("extracts multiple distinct plans from one session", () => {
    const lines = [
      assistantToolUse([
        {
          name: "Write",
          input: {
            file_path: "/home/user/.claude/plans/sunny-running-fox.md",
            content: "plan 1",
          },
        },
      ]),
      assistantToolUse([
        {
          name: "Write",
          input: {
            file_path: "/home/user/.claude/plans/calm-blue-river.md",
            content: "plan 2",
          },
        },
      ]),
    ].join("\n");
    const result = extractPlanNamesFromSessionContent(lines);
    expect(result).toContain("sunny-running-fox.md");
    expect(result).toContain("calm-blue-river.md");
    expect(result).toHaveLength(2);
  });

  test("skips malformed JSON lines gracefully", () => {
    const lines = [
      "this is not json",
      "{malformed",
      assistantToolUse([
        {
          name: "Read",
          input: { file_path: "/home/user/.claude/plans/calm-blue-river.md" },
        },
      ]),
      "",
      "null",
    ].join("\n");
    expect(extractPlanNamesFromSessionContent(lines)).toEqual([
      "calm-blue-river.md",
    ]);
  });

  test("returns empty array for empty content", () => {
    expect(extractPlanNamesFromSessionContent("")).toEqual([]);
  });

  test("only extracts from tool_use, not from mixed content with tool_result", () => {
    // Simulates the real bug: a session where a Bash tool listed plan files
    const lines = [
      // Assistant calls Bash to list plans (the tool_use itself doesn't contain plan paths)
      assistantToolUse([
        {
          name: "Bash",
          input: { command: "find /home/user/.claude/plans -name '*.md'" },
        },
      ]),
      // The result contains many plan file paths — these should be IGNORED
      toolResult(
        [
          "/home/user/.claude/plans/alpha-one.md",
          "/home/user/.claude/plans/beta-two.md",
          "/home/user/.claude/plans/gamma-three.md",
          "/home/user/.claude/plans/delta-four.md",
        ].join("\n")
      ),
      // Later, assistant actually writes a plan — this SHOULD be extracted
      assistantToolUse([
        {
          name: "Write",
          input: {
            file_path: "/home/user/.claude/plans/epsilon-five.md",
            content: "# The real plan",
          },
        },
      ]),
    ].join("\n");
    expect(extractPlanNamesFromSessionContent(lines)).toEqual([
      "epsilon-five.md",
    ]);
  });
});
