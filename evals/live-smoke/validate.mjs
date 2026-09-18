// Independent final-output validator for the live-smoke trajectory.
//
// Runs the fixture golden checks in a FRESH node process against the workdir
// on disk. It never reads the controller journal, so a lying log cannot
// produce a VALID verdict. Returns { status, casesChecked, detail } and
// never throws for a genuinely invalid artifact (only for harness errors
// such as a missing workdir).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

export async function validateWorkdir(workdir, { taskPath } = {}) {
  const task = taskPath ?? join(HERE, "task.json");
  const script = join(workdir, ".auto", "check-transform.mjs");
  if (!existsSync(script)) {
    return { status: "INVALID", casesChecked: 0, detail: `missing check script: ${script}` };
  }
  const child = spawnSync(process.execPath, ["--experimental-strip-types", script], {
    encoding: "utf-8",
    env: { ...process.env, SMOKE_WORKDIR: workdir, SMOKE_TASK: task },
  });
  const verdict = parseVerdict(child.stdout);
  if (child.status === 0 && verdict?.status === "VALID") {
    return { status: "VALID", casesChecked: verdict.casesChecked ?? 0, detail: "golden cases pass in a fresh process" };
  }
  return {
    status: "INVALID",
    casesChecked: verdict?.casesChecked ?? 0,
    detail: `exit=${child.status} stdout=${truncate(child.stdout)} stderr=${truncate(child.stderr)}`,
  };
}

function parseVerdict(stdout) {
  for (const line of String(stdout ?? "").split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.status === "string") return parsed;
    } catch {
      // Keep scanning older lines.
    }
  }
  return undefined;
}

function truncate(text, cap = 2000) {
  const value = String(text ?? "");
  return value.length <= cap ? value : value.slice(0, cap);
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const workdir = process.argv[2];
  if (!workdir) {
    console.error("usage: node validate.mjs <workdir>");
    process.exit(2);
  }
  console.log(JSON.stringify(await validateWorkdir(workdir), null, 2));
}
