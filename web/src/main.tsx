import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { language, t } from "./i18n";
import "./styles.css";

document.documentElement.lang = language;
document.title = t("app.name");
document.querySelector('meta[name="description"]')?.setAttribute("content", t("app.description"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
