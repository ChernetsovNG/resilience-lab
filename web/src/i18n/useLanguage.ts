import { useSyncExternalStore } from "react";
import { currentLanguage, subscribeLanguage } from "./index";

/** A language change rerenders the existing editor rather than replacing its state. */
export function useLanguage() {
  return useSyncExternalStore(subscribeLanguage, currentLanguage);
}
