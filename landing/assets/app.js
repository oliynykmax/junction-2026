const form = document.getElementById("review");
const input = document.getElementById("pr-url");
const button = form.querySelector("button");
const label = document.getElementById("button-label");
const status = document.getElementById("form-status");
let state = "idle";
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state === "submitting") return;
  state = "submitting";
  button.disabled = true;
  form.setAttribute("aria-busy", "true");
  input.removeAttribute("aria-invalid");
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
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        typeof data.error === "string"
          ? data.error
          : "Could not start the review. Try again later.",
      );
    if (
      typeof data.url !== "string" ||
      !/^\/m\/[a-z0-9-]+\/[a-z0-9_.-]+\/[1-9][0-9]*\?sha=[0-9a-f]{40}$/.test(
        data.url,
      )
    )
      throw new Error("The review returned an invalid link. Please try again.");
    status.textContent = "Review started. Opening the report…";
    window.location.assign(data.url);
  } catch (error) {
    state = "error";
    status.textContent =
      error instanceof Error && error.name === "TimeoutError"
        ? "Starting the review took too long. Try again; the same commit reuses its report."
        : error instanceof Error
          ? error.message
          : "Could not connect. Please try again.";
    input.setAttribute("aria-invalid", "true");
    button.disabled = false;
    form.removeAttribute("aria-busy");
    label.textContent = "Try again";
  }
});
