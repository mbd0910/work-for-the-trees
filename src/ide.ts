const IDE_PRESETS: Record<string, string> = {
  code: "code {path}",
  cursor: "cursor {path}",
  zed: "zed {path}",
  subl: "subl {path}",
  webstorm: "webstorm {path}",
  idea: "idea {path}",
};

export function getIdeName(specifier: string): string {
  return specifier in IDE_PRESETS ? specifier : "custom";
}

export function resolveIdeCommand(
  specifier: string,
  worktreePath: string
): string[] {
  const template = IDE_PRESETS[specifier] ?? specifier;
  const parts = template.split(/\s+/);

  if (parts.includes("{path}")) {
    return parts.map((p) => (p === "{path}" ? worktreePath : p));
  }
  return [...parts, worktreePath];
}
