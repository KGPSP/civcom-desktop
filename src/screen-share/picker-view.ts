export function setElementText(element: unknown, text: string): void {
  if (element === null || typeof element !== "object") return;
  try { (element as { textContent: string }).textContent = text; } catch { /* inert rendering failure */ }
}

export async function runPickerAction(
  action: () => Promise<boolean>,
  setPending: (pending: boolean) => void
): Promise<boolean> {
  setPending(true);
  try {
    if (await action() === true) return true;
  } catch { /* keep the user in control after a failed IPC action */ }
  setPending(false);
  return false;
}
