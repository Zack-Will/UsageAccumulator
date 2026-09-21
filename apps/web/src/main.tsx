import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@ua/tokens/theme.css";
import "./styles/app.css";
import { App } from "./App";

const host = document.getElementById("root");
if (!host) throw new Error("#root missing");

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
