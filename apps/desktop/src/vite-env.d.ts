/// <reference types="vite/client" />

declare global {
  interface Window {
    desktop?: {
      ping: () => string;
      platform?: "darwin" | "win32" | "linux" | string;
      arch?: string;
      window?: {
        focusMain: () => Promise<{ ok: boolean; error?: string }>;
      };
      onMenuAction?: (handler: (payload: any) => void) => () => void;
      app?: {
        getVersion: () => Promise<{ ok: boolean; version?: string; error?: string }>;
        getTempPath: () => Promise<{ ok: boolean; path?: string; error?: string }>;
      };
      update?: {
        check: (opts?: { baseUrl?: string }) => Promise<{
          ok: boolean;
          error?: string;
          currentVersion?: string;
          latestVersion?: string;
          updateAvailable?: boolean;
          nsisUrl?: string;
          notes?: string;
          baseUrl?: string;
          latestUrl?: string;
        }>;
        checkInteractive: (opts?: { baseUrl?: string }) => Promise<any>;
        silentDownload: (opts?: { baseUrl?: string }) => Promise<{
          ok: boolean;
          error?: string;
          updateAvailable?: boolean;
          downloaded?: boolean;
          version?: string;
          supported?: boolean;
        }>;
        installPending: () => Promise<{ ok: boolean; error?: string }>;
        onEvent?: (handler: (payload: any) => void) => () => void;
      };
      exec?: {
        run: (params: {
          projectDir: string;
          runtime?: string;
          code?: string;
          entryFile?: string;
          args?: string[];
          requirements?: string[];
          timeoutMs?: number;
          artifactGlobs?: string[];
        }) => Promise<{
          ok: boolean;
          runId?: string;
          exitCode?: number;
          stdout?: string;
          stderr?: string;
          stdoutTruncated?: boolean;
          stderrTruncated?: boolean;
          timedOut?: boolean;
          durationMs?: number;
          artifacts?: Array<{
            name: string;
            ext: string;
            absPath: string;
            relPath: string;
            sizeBytes: number;
          }>;
          error?: string;
          detail?: string;
        }>;
        openFile: (absPath: string) => Promise<{ ok: boolean; error?: string; detail?: string }>;
        showInFolder: (absPath: string) => Promise<{ ok: boolean; error?: string }>;
        saveArtifact: (opts: {
          absPath: string;
          defaultName?: string;
        }) => Promise<{ ok: boolean; canceled?: boolean; savedPath?: string; error?: string }>;
      };
      memory?: {
        readProject: (rootDir: string) => Promise<{ ok: boolean; content?: string; error?: string }>;
        writeProject: (rootDir: string, content: string) => Promise<{ ok: boolean; error?: string }>;
        readGlobal: () => Promise<{ ok: boolean; content?: string; error?: string }>;
        writeGlobal: (content: string) => Promise<{ ok: boolean; error?: string }>;
      };
      fs?: {
        pickDirectory: () => Promise<{ ok: boolean; dir?: string; canceled?: boolean; error?: string }>;
        listFiles: (rootDir: string) => Promise<{ ok: boolean; files?: string[]; error?: string }>;
        listEntries: (rootDir: string) => Promise<{ ok: boolean; files?: string[]; dirs?: string[]; error?: string }>;
        listAllEntries: (rootDir: string) => Promise<{
          ok: boolean;
          files?: Array<{ path: string; size: number; mtime: number; type: "text" | "binary" | "other" }>;
          dirs?: string[];
          error?: string;
        }>;
        readIndex: (rootDir: string) => Promise<{ ok: boolean; data?: any; error?: string }>;
        writeIndex: (rootDir: string, data: any) => Promise<{ ok: boolean; error?: string }>;
        readFile: (rootDir: string, relPath: string) => Promise<{ ok: boolean; content?: string; error?: string }>;
        writeFile: (
          rootDir: string,
          relPath: string,
          content: string,
        ) => Promise<{ ok: boolean; error?: string }>;
        appendFile: (
          rootDir: string,
          relPath: string,
          content: string,
        ) => Promise<{ ok: boolean; error?: string }>;
        deleteFile: (rootDir: string, relPath: string) => Promise<{ ok: boolean; error?: string }>;
        deletePath: (rootDir: string, relPath: string) => Promise<{ ok: boolean; error?: string; detail?: string }>;
        mkdir: (rootDir: string, relDir: string) => Promise<{ ok: boolean; error?: string }>;
        renamePath: (
          rootDir: string,
          fromRel: string,
          toRel: string,
        ) => Promise<{ ok: boolean; error?: string; detail?: string }>;
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
          activeConvId?: string | null;
          used?: "primary" | "fallback";
          file?: string;
          error?: string;
          detail?: string;
        }>;
        saveConversations: (payload: any) => Promise<{ ok: boolean; used?: "primary" | "fallback"; file?: string; error?: string }>;
        loadPendingConversations: () => Promise<{ ok: boolean; payload?: any | null; used?: "primary" | "fallback"; file?: string; error?: string }>;
        savePendingConversations: (payload: any) => Promise<{ ok: boolean; used?: "primary" | "fallback"; file?: string; error?: string }>;
        clearPendingConversations: () => Promise<{ ok: boolean; error?: string }>;
      };
      clipboard?: {
        writeText: (text: string) => Promise<{ ok: boolean; error?: string }>;
        writeRichText: (payload: { html: string; text?: string }) => Promise<{ ok: boolean; error?: string }>;
      };
      skills?: {
        list: () => Promise<any[]>;
        errors: () => Promise<Array<{ dirName: string; error: string; ts: number }>>;
        reload: () => Promise<any[]>;
        openDir: () => Promise<{ ok: boolean }>;
        onChange: (handler: (payload: { manifests: any[]; errors: Array<{ dirName: string; error: string; ts: number }> } | any[]) => void) => () => void;
      };
      mcp?: {
        getServers: () => Promise<any[]>;
        addServer: (config: any) => Promise<{ ok: boolean; id?: string; error?: string }>;
        updateServer: (id: string, config: any) => Promise<{ ok: boolean; error?: string }>;
        removeServer: (id: string) => Promise<{ ok: boolean; error?: string }>;
        connect: (id: string) => Promise<{ ok: boolean; error?: string }>;
        disconnect: (id: string) => Promise<{ ok: boolean; error?: string }>;
        getTools: (id: string) => Promise<any[]>;
        callTool: (serverId: string, toolName: string, args?: any) => Promise<any>;
        getRuntimeHealth?: (opts?: { commands?: string[] }) => Promise<any>;
        repairRuntime?: (opts?: { commands?: string[] }) => Promise<any>;
        onStatusChange: (handler: (payload: any) => void) => () => void;
      };
      marketplace?: {
        getInstalled: () => Promise<{ ok: boolean; installed?: any[]; error?: string }>;
        getLogs: () => Promise<{ ok: boolean; logs?: any[]; error?: string }>;
        install: (pkg: { manifest: any; payload: any }) => Promise<{ ok: boolean; installed?: any; error?: string }>;
        uninstall: (itemId: string) => Promise<{ ok: boolean; removed?: boolean; error?: string }>;
      };
      cron?: {
        create: (params: any) => Promise<any>;
        list: (params?: any) => Promise<any>;
      };
      automation?: {
        onCronDue?: (handler: (payload: any) => void) => () => void;
      };
    };
  }
}

export {};
