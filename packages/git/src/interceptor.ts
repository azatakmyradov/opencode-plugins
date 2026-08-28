export const NO_VERIFY_RE = /--no-verify\b/

export const BLOCK_REASON =
  "BLOCKED: --no-verify is not allowed. Git hooks exist for a reason. " +
  "Do not attempt to bypass them. Instead: fix the underlying issue that " +
  "is causing the hook to fail, or ask the user for help."

export function shouldBlockNoVerify(resources: readonly string[]): boolean {
  return resources.some((resource) => NO_VERIFY_RE.test(resource))
}

export function applyGitEditorEnv(
  command: string,
  env: Record<string, string | undefined>,
): void {
  if (!command.includes("git")) return
  env.GIT_EDITOR = "true"
  env.GIT_SEQUENCE_EDITOR = "true"
  env.GIT_MERGE_AUTOEDIT = "no"
}
