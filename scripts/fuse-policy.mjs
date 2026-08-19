import { isAbsolute, join, win32 } from "node:path";

export const FUSE_VALUES = Object.freeze({
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: false,
  WasmTrapHandlers: true
});

const FUSE_NAMES = Object.freeze(Object.keys(FUSE_VALUES));

function safeLeaf(value, label) {
  if (typeof value !== "string" || value === "" || value === "." || value === ".." || value.includes("/") || value.includes("\\") || [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) throw new Error(`Invalid ${label}`);
  return value;
}

function validateFuseApi(api, includeState = false) {
  if (api === null || typeof api !== "object" || api.FuseVersion?.V1 !== "1") throw new Error("Unsupported fuse API version");
  const optionNames = Object.keys(api.FuseV1Options ?? {}).filter((key) => Number.isNaN(Number(key)));
  if (optionNames.length !== FUSE_NAMES.length || FUSE_NAMES.some((name) => !optionNames.includes(name))) throw new Error("Unknown or missing V1 fuse option");
  const indexes = FUSE_NAMES.map((name) => api.FuseV1Options[name]);
  if (indexes.some((value) => !Number.isInteger(value)) || new Set(indexes).size !== FUSE_NAMES.length || indexes.some((value, index) => value !== index)) throw new Error("Unexpected V1 fuse indexes");
  if (includeState && (api.FuseState?.ENABLE !== 49 || api.FuseState?.DISABLE !== 48)) throw new Error("Unexpected fuse state encoding");
}

export function createFuseConfig(api) {
  validateFuseApi(api);
  const config = { version: api.FuseVersion.V1, strictlyRequireAllFuses: true, resetAdHocDarwinSignature: true };
  for (const name of FUSE_NAMES) config[api.FuseV1Options[name]] = FUSE_VALUES[name];
  return Object.freeze(config);
}

export function shouldFlipFuses(input) {
  if (input === null || typeof input !== "object" || !Number.isInteger(input.arch)) throw new Error("Invalid fuse pack phase");
  if (input.platform === "darwin") {
    if (input.arch === 1 || input.arch === 3) return false;
    if (input.arch === 4) return true;
  } else if ((input.platform === "win32" || input.platform === "linux") && input.arch === 1) {
    return true;
  }
  throw new Error("Unexpected packaged architecture for fuse hook");
}

export function resolveElectronExecutable(input) {
  if (input === null || typeof input !== "object") throw new Error("Invalid pack context");
  const productFilename = safeLeaf(input.productFilename, "product filename");
  if (input.platform === "win32") {
    if (typeof input.appOutDir !== "string" || !win32.isAbsolute(input.appOutDir)) throw new Error("Invalid Windows output directory");
    return win32.join(input.appOutDir, `${productFilename}.exe`);
  }
  if (input.platform === "darwin" || input.platform === "linux") {
    if (typeof input.appOutDir !== "string" || !isAbsolute(input.appOutDir)) throw new Error("Invalid output directory");
    return input.platform === "darwin"
      ? join(input.appOutDir, `${productFilename}.app`, "Contents", "MacOS", productFilename)
      : join(input.appOutDir, safeLeaf(input.executableName, "executable name"));
  }
  throw new Error("Unsupported packaged platform");
}

export function verifyFuseWire(wire, api) {
  validateFuseApi(api, true);
  if (wire === null || typeof wire !== "object" || wire.version !== api.FuseVersion.V1) throw new Error("Unsupported final fuse wire");
  const numericKeys = Object.keys(wire).filter((key) => /^\d+$/.test(key)).map(Number).sort((left, right) => left - right);
  if (numericKeys.length !== FUSE_NAMES.length || numericKeys.some((value, index) => value !== index)) throw new Error("Unknown or missing final fuse");
  for (const name of FUSE_NAMES) {
    const expected = FUSE_VALUES[name] ? api.FuseState.ENABLE : api.FuseState.DISABLE;
    if (wire[api.FuseV1Options[name]] !== expected) throw new Error(`Unexpected final fuse state: ${name}`);
  }
}
