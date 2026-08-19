export type CaptureSourceCandidate<T> = Readonly<{
  source: T;
  id: unknown;
  name: unknown;
  thumbnailDataUrl: unknown;
}>;

export type PickerSource = Readonly<{
  token: string;
  name: string;
  kind: "screen" | "window";
  thumbnailDataUrl?: string;
}>;

export type OpaqueSourceCatalog<T> = Readonly<{
  generation: number;
  sources: readonly PickerSource[];
  resolve(selection: unknown): CaptureSourceCandidate<T> | undefined;
  clear(): void;
}>;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_NAME_CODE_POINTS = 120;
const MAX_THUMBNAIL_LENGTH = 512_000;

function readOwnData(input: unknown, fields: readonly string[]): ReadonlyMap<string, unknown> | undefined {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const values = new Map<string, unknown>();
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      values.set(field, descriptor.value);
    }
    return values;
  } catch {
    return undefined;
  }
}

function sanitizedName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const normalized = value.normalize("NFC");
    const safe = [...normalized].map((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 31 || (point >= 127 && point <= 159) ? "�" : character;
    }).slice(0, MAX_NAME_CODE_POINTS).join("");
    return safe === "" ? undefined : safe;
  } catch {
    return undefined;
  }
}

function sourceKind(value: unknown): "screen" | "window" | undefined {
  if (typeof value !== "string" || value.length > 1024) return undefined;
  if (value.startsWith("screen:")) return "screen";
  if (value.startsWith("window:")) return "window";
  return undefined;
}

function sanitizedThumbnail(value: unknown): string | undefined {
  if (
    typeof value !== "string" || value.length > MAX_THUMBNAIL_LENGTH ||
    !/^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) return undefined;
  return value;
}

function safeArray(input: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(input)) return [];
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > 100) return [];
    const values: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (descriptor === undefined || !("value" in descriptor)) return [];
      values.push(descriptor.value);
    }
    return values;
  } catch {
    return [];
  }
}

export function createOpaqueSourceCatalog<T>(
  generation: number,
  candidates: unknown,
  createToken: () => string
): OpaqueSourceCatalog<T> {
  const mapping = new Map<string, CaptureSourceCandidate<T>>();
  const sources: PickerSource[] = [];
  if (Number.isSafeInteger(generation) && generation > 0) {
    for (const input of safeArray(candidates)) {
      const values = readOwnData(input, ["source", "id", "name", "thumbnailDataUrl"]);
      if (values === undefined) continue;
      const source = values.get("source");
      const id = values.get("id");
      const name = sanitizedName(values.get("name"));
      const kind = sourceKind(id);
      if (source === null || typeof source !== "object" || name === undefined || kind === undefined) continue;
      let token: string | undefined;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          const candidate = createToken();
          if (TOKEN_PATTERN.test(candidate) && !mapping.has(candidate)) { token = candidate; break; }
        } catch {
          break;
        }
      }
      if (token === undefined) continue;
      const original = Object.freeze({ source: source as T, id, name: values.get("name"), thumbnailDataUrl: values.get("thumbnailDataUrl") });
      mapping.set(token, original);
      const thumbnailDataUrl = sanitizedThumbnail(values.get("thumbnailDataUrl"));
      sources.push(Object.freeze({ token, name, kind, ...(thumbnailDataUrl === undefined ? {} : { thumbnailDataUrl }) }));
    }
  }
  let active = true;
  let visibleSources: readonly PickerSource[] = Object.freeze(sources);
  const emptySources: readonly PickerSource[] = Object.freeze([]);
  return Object.freeze({
    generation,
    get sources(): readonly PickerSource[] { return visibleSources; },
    resolve(selection: unknown): CaptureSourceCandidate<T> | undefined {
      if (!active) return undefined;
      const values = readOwnData(selection, ["generation", "token"]);
      if (values === undefined || values.get("generation") !== generation) return undefined;
      const token = values.get("token");
      return typeof token === "string" && TOKEN_PATTERN.test(token) ? mapping.get(token) : undefined;
    },
    clear(): void {
      active = false;
      mapping.clear();
      visibleSources = emptySources;
    }
  });
}
