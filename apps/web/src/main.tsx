import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// 字体自托管（打进产物）：Google Fonts 在国内经常拉不下来，手机不走代理时整页回退成系统字体
import "@fontsource-variable/inter";
import "@fontsource-variable/source-serif-4/opsz.css";
import "@ua/tokens/theme.css";
import "./styles/app.css";
// Claude 风格实验层（分支 style/claude-web）。删掉这一行就回到原样
import "./styles/claude.css";
import { App } from "./App";

const host = document.getElementById("root");
if (!host) throw new Error("#root missing");

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
