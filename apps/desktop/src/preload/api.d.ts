import type { FmlApi } from "../shared/ipc";

declare global {
  interface Window {
    fml: FmlApi;
  }
}
