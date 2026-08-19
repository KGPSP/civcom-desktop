export type CredentialMetadata = Readonly<{
  scope: string;
  purpose: string;
  fileMode: number;
}>;

export function validateCredentialMetadata(metadata: unknown): metadata is CredentialMetadata {
  if (metadata === null || typeof metadata !== "object") return false;
  try {
    const prototype = Object.getPrototypeOf(metadata);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const scope = Object.getOwnPropertyDescriptor(metadata, "scope");
    const purpose = Object.getOwnPropertyDescriptor(metadata, "purpose");
    const fileMode = Object.getOwnPropertyDescriptor(metadata, "fileMode");
    return scope !== undefined
      && purpose !== undefined
      && fileMode !== undefined
      && "value" in scope
      && "value" in purpose
      && "value" in fileMode
      && scope.value === "local"
      && purpose.value === "interactive-manual-test"
      && fileMode.value === 0o600;
  } catch {
    return false;
  }
}
