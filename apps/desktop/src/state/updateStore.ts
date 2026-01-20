import { create } from "zustand";
import { persist } from "zustand/middleware";

type UpdateState = {
  updateAvailable: boolean;
  latestVersion: string;
  checkedAt: number;
  lastError: string;
  download: { running: boolean; transferred: number; total: number } | null;

  setCheckResult: (args: { updateAvailable: boolean; latestVersion: string; error?: string }) => void;
  setDownload: (d: UpdateState["download"]) => void;
};

export const useUpdateStore = create<UpdateState>()(
  persist(
    (set) => ({
      updateAvailable: false,
      latestVersion: "",
      checkedAt: 0,
      lastError: "",
      download: null,

      setCheckResult: (args) =>
        set({
          updateAvailable: Boolean(args.updateAvailable),
          latestVersion: String(args.latestVersion ?? ""),
          checkedAt: Date.now(),
          lastError: args.error ? String(args.error) : "",
        }),
      setDownload: (download) => set({ download }),
    }),
    { name: "writing-ide.update.v1" },
  ),
);


