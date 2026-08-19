type RuntimeSandboxInput = Readonly<{
  platform: unknown;
  argv: unknown;
  noSandboxSwitch: unknown;
}>;

function ownDataValue(record: object, key: keyof RuntimeSandboxInput): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor)) throw new Error("Invalid runtime sandbox input");
  return descriptor.value;
}

function commandLineArguments(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > 4096) return undefined;
  const argumentsList: string[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string" || descriptor.value.length > 4096) return undefined;
    if ([...descriptor.value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })) return undefined;
    argumentsList.push(descriptor.value);
  }
  return Object.freeze(argumentsList);
}

/**
 * Refuses Linux launches where an outer AppImage runtime disabled Chromium's
 * sandbox. Other platforms retain their existing native startup behavior.
 */
export function shouldRejectRuntimeSandbox(input: unknown): boolean {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return true;
    const platform = ownDataValue(input, "platform");
    const argv = commandLineArguments(ownDataValue(input, "argv"));
    const noSandboxSwitch = ownDataValue(input, "noSandboxSwitch");
    if ((platform !== "linux" && platform !== "darwin" && platform !== "win32") || argv === undefined || typeof noSandboxSwitch !== "boolean") return true;
    if (platform !== "linux") return false;
    return noSandboxSwitch || argv.some((argument) => /^--no-sandbox(?:=.*)?$/.test(argument));
  } catch {
    return true;
  }
}
