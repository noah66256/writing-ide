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
        readImageDataUrl: (absPath: string) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
        readImageVisionPayload: (
          absPath: string,
          opts?: { maxEdge?: number; maxBytes?: number },
        ) => Promise<{
          ok: boolean;
          mediaType?: string;
          data?: string;
          width?: number;
          height?: number;
          sizeBytes?: number;
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
        applyOperations?: (batch: any) => Promise<{ ok: boolean; used?: "primary" | "fallback"; file?: string; error?: string }>;
        appendEvents?: (batch: any) => Promise<{
          ok: boolean;
          used?: "primary" | "fallback";
          file?: string;
          conversationId?: string;
          eventId?: string;
          appended?: boolean;
          error?: string;
        }>;
        appendEventsSync?: (batch: any) => {
          ok: boolean;
          used?: "primary" | "fallback";
          file?: string;
          conversationId?: string;
          eventId?: string;
          appended?: boolean;
          error?: string;
        };
        applyOperationsSync?: (batch: any) => { ok: boolean; used?: "primary" | "fallback"; file?: string; error?: string };
        materializeConversation?: (conversationId: string) => Promise<{
          ok: boolean;
          used?: "primary" | "fallback";
          file?: string;
          conversationId?: string;
          materialized?: boolean;
          eventCount?: number;
          cleared?: boolean;
          error?: string;
        }>;
        materializeConversationSync?: (conversationId: string) => {
          ok: boolean;
          used?: "primary" | "fallback";
          file?: string;
          conversationId?: string;
          materialized?: boolean;
          eventCount?: number;
          cleared?: boolean;
          error?: string;
        };
        flushWriter?: (conversationId?: string | null) => Promise<{
          ok: boolean;
          conversationId?: string | null;
          error?: string;
        }>;
        flushWriterSync?: (conversationId?: string | null) => {
          ok: boolean;
          conversationId?: string | null;
          error?: string;
        };
        getInfo: () => Promise<{ ok: boolean; primaryDir?: string | null; fallbackDir?: string | null; filename?: string; error?: string }>;
        recoverHistoryIfNeeded?: () => Promise<{
          ok: boolean;
          replayedJournalCount?: number;
          migratedLegacyPendingCount?: number;
          staleIgnoredCount?: number;
          clearedCount?: number;
          error?: string;
        }>;
        loadConversationIndex?: () => Promise<{
          ok: boolean;
          conversations?: any[];
          draftSnapshot?: any | null;
          draftSnapshotOwnerId?: string | null;
          draftRevision?: number;
          activeConvId?: string | null;
          used?: string;
          file?: string | null;
          error?: string;
          detail?: string;
        }>;
        readConversationSnapshot?: (params: {
          conversationId: string;
          includeSteps?: boolean;
        }) => Promise<{
          ok: boolean;
          snapshot?: any | null;
          bodyRevision?: number;
          used?: string;
          error?: string;
          detail?: string;
        }>;
        loadConversationSegment?: (params: {
          conversationId: string;
          beforeStepId?: string;
          limit?: number;
        }) => Promise<{
          ok: boolean;
          steps?: any[];
          hasMoreBefore?: boolean;
          error?: string;
          detail?: string;
        }>;
        /** Legacy compat shell. New renderer hydrate should rely on recoverHistoryIfNeeded + index/body only. */
        loadPendingConversations: () => Promise<{ ok: boolean; payload?: any | null; used?: "primary" | "fallback"; file?: string; error?: string }>;
        /** Legacy compat shell. Retained only for older clients / migration paths. */
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
        setProjectRoots?: (roots: string[]) => Promise<any[]>;
        openDir: () => Promise<{ ok: boolean }>;
        onChange: (handler: (payload: { manifests: any[]; errors: Array<{ dirName: string; error: string; ts: number }> } | any[]) => void) => () => void;
      };
      agents?: {
        list: (options?: { projectRoots?: string[] }) => Promise<any[]>;
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
        searchCatalog?: (args?: { query?: string; baseUrl?: string }) => Promise<any>;
        planInstall?: (args?: { source?: any; baseUrl?: string }) => Promise<any>;
        applyInstall?: (args?: {
          source?: any;
          candidateId?: string;
          configValues?: any;
          confirm?: boolean;
          baseUrl?: string;
          threadId?: string | null;
        }) => Promise<any>;
        resolvePendingRequest?: (args?: { requestId?: string; action?: string; values?: any }) => Promise<any>;
        testServer?: (args?: { serverId?: string; threadId?: string | null }) => Promise<any>;
        planUpgrade?: (args?: { serverId?: string; baseUrl?: string }) => Promise<any>;
        applyUpgrade?: (args?: { serverId?: string; confirm?: boolean; baseUrl?: string; threadId?: string | null }) => Promise<any>;
        uninstallServer?: (args?: { serverId?: string; confirm?: boolean }) => Promise<any>;
        syncCrabImageGatewayGeminiEnv?: (args?: { apiKey?: string; baseUrl?: string }) => Promise<{ ok: boolean; error?: string }>;
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
