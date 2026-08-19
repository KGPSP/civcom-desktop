import type { PickerPreloadApi } from "./preload-api.js";
import type { PickerSource } from "./source-catalog.js";
import { runPickerAction, setElementText } from "./picker-view.js";

declare global {
  interface Window { civcomScreenPicker?: PickerPreloadApi }
}

function sourceCard(document: Document, source: PickerSource, choose: (token: string) => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "source";
  button.setAttribute("role", "listitem");
  if (source.thumbnailDataUrl !== undefined) {
    const image = document.createElement("img");
    image.src = source.thumbnailDataUrl;
    image.alt = "";
    button.append(image);
  }
  const kind = document.createElement("span");
  kind.className = "kind";
  setElementText(kind, source.kind === "screen" ? "Ekran" : "Okno");
  const name = document.createElement("span");
  name.className = "name";
  setElementText(name, source.name);
  button.append(kind, name);
  button.addEventListener("click", () => choose(source.token));
  return button;
}

async function start(): Promise<void> {
  const api = window.civcomScreenPicker;
  const list = document.getElementById("sources");
  const empty = document.getElementById("empty");
  const cancel = document.getElementById("cancel") as HTMLButtonElement | null;
  if (api === undefined || list === null || empty === null || cancel === null) return;
  let pending = false;
  const setPending = (value: boolean): void => {
    pending = value;
    cancel.disabled = value;
    for (const button of list.querySelectorAll("button")) button.disabled = value;
  };
  cancel.addEventListener("click", () => {
    if (pending) return;
    void runPickerAction(() => api.cancel(), setPending);
  });
  const sources = await api.getSources().catch(() => Object.freeze([] as PickerSource[]));
  if (sources.length === 0) { empty.hidden = false; return; }
  for (const source of sources) {
    const card = sourceCard(document, source, (token) => {
      if (pending) return;
      void runPickerAction(() => api.choose(token), setPending);
    });
    card.disabled = pending;
    list.append(card);
  }
}

window.addEventListener("DOMContentLoaded", () => { void start(); }, { once: true });
