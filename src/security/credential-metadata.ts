export type CredentialMetadata = Readonly<{
  scope: string;
  purpose: string;
  fileMode: number;
}>;

export function validateCredentialMetadata(metadata: CredentialMetadata): boolean {
  return (
    metadata.scope === "local" &&
    metadata.purpose === "interactive-manual-test" &&
    metadata.fileMode === 0o600
  );
}
