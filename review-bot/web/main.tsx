// Entry for the review page. The Worker's shell (src/page.ts) embeds the
// review's API path and PR identity as JSON in #config.

import "@fontsource/hanken-grotesk/latin-400.css";
import "@fontsource/hanken-grotesk/latin-600.css";
import "@fontsource/hanken-grotesk/latin-700.css";
import "@fontsource/hanken-grotesk/latin-800.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./styles.css";
import { render } from "preact";
import { App, type PageConfig } from "./app";

const config: PageConfig = JSON.parse(
  document.getElementById("config")?.textContent ?? "{}",
);
const root = document.getElementById("app");
if (root) render(<App {...config} />, root);
