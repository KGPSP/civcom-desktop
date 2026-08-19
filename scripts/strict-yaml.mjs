function scalar(text) {
  if (text === "{}") return {};
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^(?:0|[1-9][0-9]*)$/.test(text)) return Number(text);
  if (text.startsWith("[") && text.endsWith("]")) {
    const inside = text.slice(1, -1).trim();
    return inside === "" ? [] : inside.split(",").map((value) => scalar(value.trim()));
  }
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch { throw new Error("Invalid quoted YAML scalar"); }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  if (text === "" || text.startsWith("{") || text.startsWith("[") || text.startsWith("&") || text.startsWith("!")) throw new Error("Unsupported or ambiguous YAML scalar");
  return text;
}

function mappingPair(text) {
  const match = /^([A-Za-z0-9_.-]+):(.*)$/.exec(text);
  if (match === null) throw new Error("Invalid strict YAML mapping entry");
  const value = match[2];
  if (value !== "" && !value.startsWith(" ")) throw new Error("YAML mapping values require one separating space");
  return Object.freeze({ key: match[1], value: value === "" ? "" : value.slice(1) });
}

export function parseStrictYaml(source) {
  if (typeof source !== "string" || source === "" || !source.endsWith("\n") || source.includes("\r") || source.includes("\t") || [...source].some((character) => {
    const code = character.charCodeAt(0);
    return (code <= 31 && character !== "\n") || code === 127;
  })) throw new Error("Invalid strict YAML text");
  const lines = [];
  for (const [index, raw] of source.slice(0, -1).split("\n").entries()) {
    if (raw.endsWith(" ")) throw new Error(`Trailing YAML whitespace at line ${index + 1}`);
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent % 2 !== 0) throw new Error(`Invalid YAML indentation at line ${index + 1}`);
    lines.push(Object.freeze({ indent, text: raw.slice(indent), raw, line: index + 1 }));
  }
  if (lines.length === 0 || lines[0].indent !== 0) throw new Error("Strict YAML must have a root mapping");
  let cursor = 0;

  function assign(target, key, value) {
    if (Object.hasOwn(target, key)) throw new Error(`Duplicate YAML key: ${key}`);
    target[key] = value;
  }

  function nestedValue(parentIndent, rawValue) {
    if (rawValue === "|") {
      const contents = [];
      while (cursor < lines.length && lines[cursor].indent > parentIndent) {
        const line = lines[cursor];
        if (line.indent < parentIndent + 2) throw new Error("Invalid YAML block indentation");
        contents.push(line.raw.slice(parentIndent + 2));
        cursor += 1;
      }
      if (contents.length === 0) throw new Error("Empty YAML block scalar");
      return `${contents.join("\n")}\n`;
    }
    if (rawValue !== "") return scalar(rawValue);
    if (cursor >= lines.length || lines[cursor].indent <= parentIndent) return null;
    if (lines[cursor].indent !== parentIndent + 2) throw new Error("YAML nesting must use two spaces");
    return parseBlock(parentIndent + 2);
  }

  function parseMapping(indent, initial) {
    const result = {};
    if (initial !== undefined) assign(result, initial.key, nestedValue(indent, initial.value));
    while (cursor < lines.length && lines[cursor].indent === indent && !lines[cursor].text.startsWith("- ")) {
      const pair = mappingPair(lines[cursor].text);
      cursor += 1;
      assign(result, pair.key, nestedValue(indent, pair.value));
    }
    return result;
  }

  function parseSequence(indent) {
    const result = [];
    while (cursor < lines.length && lines[cursor].indent === indent && lines[cursor].text.startsWith("- ")) {
      const content = lines[cursor].text.slice(2);
      if (content === "") throw new Error("Empty YAML sequence item is unsupported");
      cursor += 1;
      if (/^[A-Za-z0-9_.-]+:/.test(content)) {
        const initial = mappingPair(content);
        const item = parseMapping(indent + 2, initial);
        result.push(item);
      } else {
        result.push(scalar(content));
      }
    }
    return result;
  }

  function parseBlock(indent) {
    if (cursor >= lines.length || lines[cursor].indent !== indent) throw new Error("Missing YAML block");
    return lines[cursor].text.startsWith("- ") ? parseSequence(indent) : parseMapping(indent);
  }

  const value = parseBlock(0);
  if (cursor !== lines.length) throw new Error(`Unexpected YAML structure at line ${lines[cursor]?.line ?? 0}`);
  return value;
}
