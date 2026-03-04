import { create } from "zustand";

export type DialogKind = "alert" | "confirm" | "prompt" | "choice";

export type AlertDialogReq = {
  kind: "alert";
  title?: string;
  message: string;
  okText?: string;
};

export type ConfirmDialogReq = {
  kind: "confirm";
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
};

export type PromptDialogReq = {
  kind: "prompt";
  title?: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
  multiline?: boolean;
};

export type ChoiceDialogOption = {
  id: string;
  label: string;
  danger?: boolean;
};

export type ChoiceDialogReq = {
  kind: "choice";
  title?: string;
  message?: string;
  options: ChoiceDialogOption[];
  cancelText?: string;
};

type DialogReq = (AlertDialogReq | ConfirmDialogReq | PromptDialogReq | ChoiceDialogReq) & {
  id: string;
  // 只有 prompt 会用到 value（由 host 控制）
  value?: string;
};

type DialogStore = {
  current: DialogReq | null;
  openAlert: (req: Omit<AlertDialogReq, "kind">) => Promise<void>;
  openConfirm: (req: Omit<ConfirmDialogReq, "kind">) => Promise<boolean>;
  openPrompt: (req: Omit<PromptDialogReq, "kind">) => Promise<string | null>;
  openChoice: (req: Omit<ChoiceDialogReq, "kind">) => Promise<string | null>;
  close: () => void;
  // host 回调
  _resolveOk?: (value?: any) => void;
  _resolveCancel?: () => void;
  setValue: (value: string) => void;
};

function uid() {
  return `dlg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export const useDialogStore = create<DialogStore>((set, get) => ({
  current: null,
  _resolveOk: undefined,
  _resolveCancel: undefined,
  setValue: (value) =>
    set((s) => {
      if (!s.current) return {};
      if (s.current.kind !== "prompt") return {};
      return { current: { ...s.current, value } };
    }),
  close: () => set({ current: null, _resolveOk: undefined, _resolveCancel: undefined }),

  openAlert: async (req) => {
    return await new Promise<void>((resolve) => {
      set({
        current: { id: uid(), kind: "alert", title: req.title, message: req.message, okText: req.okText ?? "确定" },
        _resolveOk: () => resolve(),
        _resolveCancel: () => resolve(),
      });
    }).finally(() => get().close());
  },

  openConfirm: async (req) => {
    return await new Promise<boolean>((resolve) => {
      set({
        current: {
          id: uid(),
          kind: "confirm",
          title: req.title,
          message: req.message,
          confirmText: req.confirmText ?? "确定",
          cancelText: req.cancelText ?? "取消",
          danger: Boolean(req.danger),
        },
        _resolveOk: () => resolve(true),
        _resolveCancel: () => resolve(false),
      });
    }).finally(() => get().close());
  },

  openPrompt: async (req) => {
    return await new Promise<string | null>((resolve) => {
      const v = String(req.defaultValue ?? "");
      set({
        current: {
          id: uid(),
          kind: "prompt",
          title: req.title,
          message: req.message,
          placeholder: req.placeholder,
          confirmText: req.confirmText ?? "确定",
          cancelText: req.cancelText ?? "取消",
          multiline: Boolean(req.multiline),
          value: v,
        } as DialogReq,
        _resolveOk: (value?: any) => resolve(typeof value === "string" ? value : String(v)),
        _resolveCancel: () => resolve(null),
      });
    }).finally(() => get().close());
  },

  openChoice: async (req) => {
    return await new Promise<string | null>((resolve) => {
      const options = Array.isArray(req.options) ? req.options.filter((x) => String(x?.id ?? "").trim() && String(x?.label ?? "").trim()) : [];
      if (!options.length) {
        resolve(null);
        return;
      }
      set({
        current: {
          id: uid(),
          kind: "choice",
          title: req.title,
          message: req.message,
          options,
          cancelText: req.cancelText ?? "取消",
        } as DialogReq,
        _resolveOk: (value?: any) => resolve(typeof value === "string" ? value : null),
        _resolveCancel: () => resolve(null),
      });
    }).finally(() => get().close());
  },
}));
