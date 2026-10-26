import { createContext } from "react";

type DraftValidityListener = (id: string, valid: boolean) => void;

export const DraftValidityContext = createContext<DraftValidityListener | null>(null);
