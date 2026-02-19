import { homedir } from "node:os";
import { join } from "node:path";

export interface AppConfig {
  ide?: string;
}

const CONFIG_PATH = join(
  homedir(),
  ".config",
  "work-for-the-trees",
  "config.json"
);

export async function loadConfig(): Promise<AppConfig> {
  try {
    return await Bun.file(CONFIG_PATH).json();
  } catch {
    return {};
  }
}
