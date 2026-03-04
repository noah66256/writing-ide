export type FileOpConfirmChoice = "deny" | "allow_once" | "always_allow";

type PendingConfirm = {
  settle: (choice: FileOpConfirmChoice) => void;
  timer: number | null;
};

let pending: PendingConfirm | null = null;

function clearPending() {
  if (!pending) return;
  if (pending.timer !== null) {
    try {
      window.clearTimeout(pending.timer);
    } catch {
      // ignore
    }
  }
  pending = null;
}

export function requestInlineFileOpConfirm(timeoutMs = 120_000): Promise<FileOpConfirmChoice> {
  if (pending) {
    pending.settle("deny");
    clearPending();
  }
  return new Promise<FileOpConfirmChoice>((resolve) => {
    const settle = (choice: FileOpConfirmChoice) => {
      resolve(choice);
    };
    const timer =
      timeoutMs > 0
        ? window.setTimeout(() => {
            if (!pending || pending.settle !== settle) return;
            pending.settle("deny");
            clearPending();
          }, timeoutMs)
        : null;
    pending = { settle, timer };
  });
}

export function resolveInlineFileOpConfirm(choice: FileOpConfirmChoice): boolean {
  if (!pending) return false;
  pending.settle(choice);
  clearPending();
  return true;
}

export function cancelInlineFileOpConfirm() {
  if (!pending) return;
  pending.settle("deny");
  clearPending();
}
