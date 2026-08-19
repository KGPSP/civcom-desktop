export type ManualRouteCapability = Readonly<{
  toString(): "[CivCom route]";
  toJSON(): "[CivCom route]";
}>;

export type ManualCredentialResult =
  | Readonly<{ kind: "accepted"; route: ManualRouteCapability }>
  | Readonly<{ kind: "rejected"; code: string }>;

export function parseManualCredentialText(text: string): ManualCredentialResult;
export function readFixedManualCredentialFile(filePath: string): ManualCredentialResult;
export function navigateCredentialRoute(
  route: unknown,
  browser: Readonly<{ navigate(url: string): Promise<void> }>
): Promise<Readonly<{ kind: "accepted" | "rejected"; code: string }>>;
