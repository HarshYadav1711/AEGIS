import type { AegisBridge } from './shared/contracts';

declare global {
  interface Window {
    /** Provided by the preload script. Absent if the page runs outside Electron. */
    readonly aegis?: AegisBridge;
  }
}

export {};
