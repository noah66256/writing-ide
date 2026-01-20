/// <reference types="vite/client" />

declare global {
  interface Window {
    desktop?: {
      ping: () => string;
      onMenuAction?: (handler: (payload: any) => void) => () => void;
      fs?: {
        pickDirectory: () => Promise<{ ok: boolean; dir?: string; canceled?: boolean; error?: string }>;
        listFiles: (rootDir: string) => Promise<{ ok: boolean; files?: string[]; error?: string }>;
        listEntries: (rootDir: string) => Promise<{ ok: boolean; files?: string[]; dirs?: string[]; error?: string }>;
        readFile: (rootDir: string, relPath: string) => Promise<{ ok: boolean; content?: string; error?: string }>;
        writeFile: (
          rootDir: string,
          relPath: string,
          content: string,
        ) => Promise<{ ok: boolean; error?: string }>;
        deleteFile: (rootDir: string, relPath: string) => Promise<{ ok: boolean; error?: string }>;
        deletePath: (rootDir: string, relPath: string) => Promise<{ ok: boolean; error?: string; detail?: string }>;
        mkdir: (rootDir: string, relDir: string) => Promise<{ ok: boolean; error?: string }>;
        renamePath: (rootDir: string, fromRel: string, toRel: string) => Promise<{ ok: boolean; error?: string }>;
        watchStart: (rootDir: string) => Promise<{ ok: boolean; error?: string; detail?: string }>;
        watchStop: () => Promise<{ ok: boolean; error?: string }>;
        onFsEvent?: (handler: (payload: any) => void) => () => void;
      };
      kb?: {
        pickFiles: (options?: {
          title?: string;
          filters?: Array<{ name: string; extensions: string[] }>;
          multi?: boolean;
        }) => Promise<{ ok: boolean; canceled?: boolean; files?: string[]; error?: string }>;
        extractTextFromFile: (filePath: string) => Promise<{
          ok: boolean;
          error?: string;
          format?: "md" | "mdx" | "txt" | "docx" | "pdf" | "unknown";
          text?: string;
          meta?: any;
        }>;
      };
      workspace?: {
        setRecentProjects: (dirs: string[]) => Promise<{ ok: boolean; error?: string }>;
        clearRecentProjects: () => Promise<{ ok: boolean; error?: string }>;
      };
      history?: {
        getInfo: () => Promise<{ ok: boolean; primaryDir?: string | null; fallbackDir?: string | null; filename?: string; error?: string }>;
        loadConversations: () => Promise<{
          ok: boolean;
          conversations?: any[];
          draftSnapshot?: any | null;
          used?: "primary" | "fallback";
          file?: string;
          error?: string;
          detail?: string;
        }>;
        saveConversations: (payload: any) => Promise<{ ok: boolean; used?: "primary" | "fallback"; file?: string; error?: string }>;
      };
      clipboard?: {
        writeText: (text: string) => Promise<{ ok: boolean; error?: string }>;
        writeRichText: (payload: { html: string; text?: string }) => Promise<{ ok: boolean; error?: string }>;
      };
    };
  }
}

export {};


