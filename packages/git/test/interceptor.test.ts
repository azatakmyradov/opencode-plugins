import { describe, expect, test } from "vite-plus/test";
import { applyGitEditorEnv, BLOCK_REASON, shouldBlockNoVerify } from "../src/interceptor.ts";

describe("shouldBlockNoVerify", () => {
  test("blocks resources containing --no-verify", () => {
    expect(shouldBlockNoVerify(["git commit --no-verify -m hi"])).toBe(true);
    expect(shouldBlockNoVerify(["echo hello", "git -c x=y commit --no-verify"])).toBe(true);
  });

  test("allows commands without --no-verify", () => {
    expect(shouldBlockNoVerify(["git commit -m hi"])).toBe(false);
    expect(shouldBlockNoVerify([])).toBe(false);
  });

  test("matches word boundary only", () => {
    expect(shouldBlockNoVerify(["git commit --no-verifyx"])).toBe(false);
  });
});

describe("applyGitEditorEnv", () => {
  test("neutralizes editors for git commands", () => {
    const env: Record<string, string | undefined> = {};
    applyGitEditorEnv("git rebase -i HEAD~3", env);
    expect(env.GIT_EDITOR).toBe("true");
    expect(env.GIT_SEQUENCE_EDITOR).toBe("true");
    expect(env.GIT_MERGE_AUTOEDIT).toBe("no");
  });

  test("ignores non-git commands", () => {
    const env: Record<string, string | undefined> = {};
    applyGitEditorEnv("ls -la", env);
    expect(env.GIT_EDITOR).toBeUndefined();
  });
});

describe("BLOCK_REASON", () => {
  test("explains the block", () => {
    expect(BLOCK_REASON).toContain("--no-verify");
  });
});
