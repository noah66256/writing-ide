/// <reference types="vite/client" />

declare global {
  interface Window {
    desktop?: {
      ping: () => string;
      onMenuAction?: (handler: (payload: any) => void) => () => void;
      fs?: {
        pickDirectory: () => Promise<{ ok: boolean; dir?: string; canceled?: boolean; error?: string }>;
        listFiles: (rootDir: string) => Promise<{ ok: boolean; files?: string[]; error?: string }>;
        readFile: (rootDir: string, relPath: string) => Promise<{ ok: boolean; content?: string; error?: string }>;
        writeFile: (
          rootDir: string,
          relPath: string,
          content: string,
        ) => Promise<{ ok: boolean; error?: string }>;
        deleteFile: (rootDir: string, relPath: string) => Promise<{ ok: boolean; error?: string }>;
      };
    };
  }
}

export {};


