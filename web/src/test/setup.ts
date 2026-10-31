import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { initializeLanguage, language, setLanguage } from "../i18n";

// Component tests can exercise both languages synchronously; the browser loads only its selection.
const initialLanguage = language;
await initializeLanguage();
await setLanguage("ru");
await setLanguage("en");
await setLanguage(initialLanguage);
localStorage.clear();

afterEach(cleanup);
