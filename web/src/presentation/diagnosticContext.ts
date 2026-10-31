import { createContext } from "react";
import type { DiagnosticPresentationContext } from "./labels";

/** Labels from the document snapshot whose diagnostics are being displayed. */
export const DiagnosticLabelContext = createContext<DiagnosticPresentationContext>({ variants: [] });
