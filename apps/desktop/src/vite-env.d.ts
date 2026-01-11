/// <reference types="vite/client" />

declare global {
  interface Window {
    desktop?: {
      ping: () => string;
      onMenuAction?: (handler: (payload: any) => void) => () => void;
    };
  }
}

export {};


