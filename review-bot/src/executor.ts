// Client for the dedicated, ephemeral free-shell container on the CellD VM.
// The review Worker cannot start OS processes itself; this service is its
// deliberately unrestricted execution boundary.

export type CheckoutInput = {
  session: string;
  owner: string;
  repo: string;
  sha: string;
  githubToken: string;
};

export type CheckoutResult = {
  workspace: string;
  commit: string;
};

export type ShellInput = {
  session: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
};

export type ShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type ExecutorEnv = {
  EXECUTOR_URL?: string;
  EXECUTOR_TOKEN?: string;
};

type Executor = {
  checkout(input: CheckoutInput, signal?: AbortSignal): Promise<CheckoutResult>;
  shell(input: ShellInput, signal?: AbortSignal): Promise<ShellResult>;
};

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

async function call<T>(
  base: string,
  token: string,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(endpoint(base, path), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The status below makes a non-JSON reply useful without exposing input.
  }
  if (!response.ok) {
    const detail =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String(parsed.error)
        : text.slice(0, 500);
    throw new Error(`executor ${path} -> ${response.status}: ${detail}`);
  }
  return parsed as T;
}

/**
 * Returns the intentionally unrestricted shell service, or fails closed when
 * a deployment omitted it. The agent receives no token in a tool result.
 */
export function executor(env: ExecutorEnv): Executor {
  if (!env.EXECUTOR_URL || !env.EXECUTOR_TOKEN)
    throw new Error("Free shell executor is not configured");
  return {
    checkout: (input, signal) =>
      call<CheckoutResult>(
        env.EXECUTOR_URL!,
        env.EXECUTOR_TOKEN!,
        "/v1/checkout",
        input,
        signal,
      ),
    shell: (input, signal) =>
      call<ShellResult>(
        env.EXECUTOR_URL!,
        env.EXECUTOR_TOKEN!,
        "/v1/shell",
        input,
        signal,
      ),
  };
}
