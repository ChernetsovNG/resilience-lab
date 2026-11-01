import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";
import { initializeLanguage, language, setLanguage } from "../i18n";

// Validation debounces for 500 ms; coverage and parallel App renders can exceed RTL's 1 s default.
configure({ asyncUtilTimeout: 5_000 });

// Component tests can exercise both languages synchronously; the browser loads only its selection.
const initialLanguage = language;
await initializeLanguage();
await setLanguage("ru");
await setLanguage("en");
await setLanguage(initialLanguage);
localStorage.clear();

afterEach(cleanup);
