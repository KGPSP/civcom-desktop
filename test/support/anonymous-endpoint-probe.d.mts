export type AnonymousEndpointProbeResult =
  | Readonly<{ kind: "accepted"; code: "ANONYMOUS_ENDPOINTS_OK"; checks: readonly string[]; warnings: readonly string[] }>
  | Readonly<{ kind: "rejected"; code: string }>;

export function runAnonymousEndpointProbe(): Promise<AnonymousEndpointProbeResult>;
