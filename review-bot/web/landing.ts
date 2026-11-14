// Client for the landing page (../landing/index.html), bundled by
// vite.landing.config.ts into ../landing/assets/landing.js. The page's
// controls are @ui-sdk/web elements: a switch for the theme, and a field,
// input and button for the review form.

import { createColorScheme, createLocalStorage } from "@ui-sdk/core";
import "@ui-sdk/web/button";
import "@ui-sdk/web/field";
import "@ui-sdk/web/input";
import "@ui-sdk/web/preferences";
import "@ui-sdk/web/switch";
import { THEME_KEY } from "../src/theme";

function need<T>(value: T | null): T {
  if (value === null) throw new Error("Landing markup changed");
  return value;
}

const REPORT_URL =
  /^\/m\/[a-z0-9-]+\/[a-z0-9_.-]+\/[1-9][0-9]*\?sha=[0-9a-f]{40}$/;

const SUN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 14.5A9 9 0 0 1 9.5 3a9 9 0 1 0 11.5 11.5Z"/></svg>';

const scheme = createColorScheme({
  global: true,
  storage: createLocalStorage(THEME_KEY),
});
const preferences = document.querySelector("ui-preferences");
if (preferences) preferences.preferences = [scheme];

const themeSwitch = document.querySelector("ui-switch");
const thumb = document.querySelector("ui-switch-thumb");
if (themeSwitch && thumb) {
  const dark = () => scheme.get().resolved === "dark";
  const show = () => {
    themeSwitch.checked = dark();
    thumb.innerHTML = dark() ? MOON : SUN;
  };
  show();
  scheme.subscribe(show);
  themeSwitch.addEventListener("checkedchange", (event) => {
    if (event.detail.value !== dark())
      scheme.set(event.detail.value ? "dark" : "light");
  });
}

const form = need(document.querySelector<HTMLFormElement>("#review"));
const input = need(document.querySelector<HTMLInputElement>("#pr-url"));
const field = need(form.querySelector("ui-field"));
const submit = need(form.querySelector("ui-button"));
const label = need(document.getElementById("button-label"));
const status = need(document.getElementById("form-status"));

const serverError = document.createElement("ui-field-error");
serverError.setAttribute("match", "true");

function fail(message: string) {
  serverError.textContent = message;
  field.appendChild(serverError);
  field.invalid = true;
  status.textContent = "";
  status.classList.remove("error");
  submit.disabled = false;
  form.removeAttribute("aria-busy");
  label.textContent = "Try again";
}

input.addEventListener("input", () => {
  serverError.remove();
  field.invalid = undefined;
});

let submitting = false;
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submitting) return;
  submitting = true;
  serverError.remove();
  field.invalid = undefined;
  submit.disabled = true;
  form.setAttribute("aria-busy", "true");
  label.textContent = "Starting…";
  status.textContent =
    "Checking the public PR and opening your review. This may take a moment.";
  try {
    const response = await fetch("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: input.value.trim() }),
      signal: AbortSignal.timeout(60000),
    });
    const data = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      url?: unknown;
    };
    if (!response.ok)
      throw new Error(
        typeof data.error === "string"
          ? data.error
          : "Could not start the review. Try again later.",
      );
    if (typeof data.url !== "string" || !REPORT_URL.test(data.url))
      throw new Error("The review returned an invalid link. Please try again.");
    status.textContent = "Review started. Opening the report…";
    window.location.assign(data.url);
  } catch (error) {
    fail(
      error instanceof Error && error.name === "TimeoutError"
        ? "Starting the review took too long. Try again; the same commit reuses its report."
        : error instanceof Error
          ? error.message
          : "Could not connect. Please try again.",
    );
    submitting = false;
  }
});
