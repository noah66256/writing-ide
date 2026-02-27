import { create } from "zustand";
import { persist } from "zustand/middleware";

type UpdateState = {
  updateAvailable: boolean;
  latestVersion: string;
  checkedAt: number;
  lastError: string;
  download: { running: boolean; transferred: number; total: number } | null;
  downloadReady: boolean;
  readyVersion: string;

  setCheckResult: (args: { updateAvailable: boolean; latestVersion: string; error?: string }) => void;
  setDownload: (d: UpdateState["download"]) => void;
  setDownloadReady: (version: string) => void;
};

export const useUpdateStore = create<UpdateState>()(
  persist(
    (set) => ({
      updateAvailable: false,
      latestVersion: "",
      checkedAt: 0,
      lastError: "",
      download: null,
      downloadReady: false,
      readyVersion: "",

      setCheckResult: (args) =>
        set({
          updateAvailable: Boolean(args.updateAvailable),
          latestVersion: String(args.latestVersion ?? ""),
          checkedAt: Date.now(),
          lastError: args.error ? String(args.error) : "",
        }),
      setDownload: (download) => set({ download }),
      setDownloadReady: (version) =>
        set({ downloadReady: true, readyVersion: String(version ?? ""), download: null }),
    }),
    { name: "writing-ide.update.v1" },
  ),
);
