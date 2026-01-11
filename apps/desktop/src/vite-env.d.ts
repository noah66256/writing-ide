/// <reference types="vite/client" />

declare global {
  interface Window {
    desktop?: {
      ping: () => string;
    };
  }
}

export {};


