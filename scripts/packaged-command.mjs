import { spawnSync } from "node:child_process";

function commandLabel(command) {
  if (typeof command !== "string" || command === "") return "unknown";
  const candidate = command.replaceAll("\\", "/").split("/").at(-1);
  return typeof candidate === "string" && /^[A-Za-z0-9._+-]{1,128}$/.test(candidate) ? candidate : "unknown";
}

function failureCategory(result) {
  if (result.error?.code === "ETIMEDOUT") return "timeout";
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/failed to move to new namespace|unshare[^\n]*(?:operation not permitted|permission denied)|user namespace[^\n]*(?:operation not permitted|permission denied)/i.test(output)) return "user-namespace-denied";
  if (/--no-sandbox|no usable sandbox|chrome-sandbox[^\n]*(?:4755|root)|suid sandbox helper[^\n]*not configured/i.test(output)) return "sandbox-unavailable";
  if (/xvfb|missing x server|cannot open display|failed to connect to display/i.test(output)) return "display-unavailable";
  return "command-failed";
}

export function runPackagedCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.environment ?? process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout ?? 60_000,
    shell: false
  });
  if (result.error === undefined && result.status === 0) return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const status = Number.isInteger(result.status) ? String(result.status) : "none";
  const errorCode = typeof result.error?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(result.error.code) ? `; error=${result.error.code}` : "";
  throw new Error(`Packaged verification command failed: ${commandLabel(command)}; status=${status}${errorCode}; category=${failureCategory(result)}`);
}
