import type { Context } from "@earendil-works/chord/context";
import type { HarnessOptions, Wake } from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

type Telemetry = NonNullable<HarnessOptions["telemetry"]>;
type Span = Parameters<Parameters<Telemetry["startSpan"]>[1]>[0];

export type InterruptedTask = {
  taskId: number;
  taskName: string;
  taskPhase: string | null;
  restarts: number;
};

type Ids = { objectId: string; bootId: string };

export type LifecycleEvent = Ids &
  (
    | {
        event: "review.boot";
        interruptedTasks: number;

        scanComplete: boolean;
      }
    | {
        event: "review.recovery_detected";
        tasks: InterruptedTask[];
        scanComplete: boolean;
      }
    | {
        event: "review.recovery_phase";
        taskId: number;
        taskName: string;
        taskPhase: string;
        outcome: string | null;
        status: "ok" | "error";
      }
    | {
        event: "review.recovery_task_ended";
        taskId: number;
        taskName: string;
        outcome: string;
        status: "ok" | "error";
      }
    | {
        event: "review.finished";
        decision: string;
        findings: number;
      }
    | {
        event: "review.alarm";
        workActive: boolean;
        sleepAt: number | null;
      }
  );

const SCAN_LIMIT = 50;
const TERMINAL = new Set(["done", "faulted", "aborted"]);

export function logLifecycle(event: LifecycleEvent) {
  console.log(event);
}

function phaseOf(checkpoint: unknown): string | null {
  if (typeof checkpoint !== "object" || checkpoint === null) return null;
  const phase = "phase" in checkpoint ? checkpoint.phase : undefined;
  return typeof phase === "string" ? phase : null;
}

/** Tasks a dead process left running. Read-only; call before Harness.open. */
export async function interruptedTasks(
  storage: SqliteStorage,
  context: Context,
): Promise<{ tasks: InterruptedTask[]; scanComplete: boolean }> {
  const page = await storage.scanTasks(
    { status: "running" },
    SCAN_LIMIT,
    undefined,
    context,
  );
  return {
    tasks: page.items.map((t) => ({
      taskId: Number(t.id),
      taskName: t.kind,
      taskPhase: phaseOf(t.state.checkpoint),
      restarts: t.restarts ?? 0,
    })),
    scanComplete: page.next === undefined,
  };
}

export class Lifecycle {
  readonly #ids: Ids;
  readonly #interrupted: Set<number>;

  constructor(
    objectId: string,
    scan: { tasks: InterruptedTask[]; scanComplete: boolean },
  ) {
    this.#ids = { objectId, bootId: crypto.randomUUID() };
    this.#interrupted = new Set(scan.tasks.map((t) => t.taskId));
    logLifecycle({
      ...this.#ids,
      event: "review.boot",
      interruptedTasks: scan.tasks.length,
      scanComplete: scan.scanComplete,
    });
    if (scan.tasks.length)
      logLifecycle({
        ...this.#ids,
        event: "review.recovery_detected",
        tasks: scan.tasks,
        scanComplete: scan.scanComplete,
      });
  }

  finished(decision: string, findings: number) {
    logLifecycle({
      ...this.#ids,
      event: "review.finished",
      decision,
      findings,
    });
  }

  alarm(wake: Wake) {
    logLifecycle({
      ...this.#ids,
      event: "review.alarm",
      workActive: wake.active,
      sleepAt: wake.at ?? null,
    });
  }

  #phase(
    attributes: Record<string, unknown>,
    outcome: string | null,
    status: "ok" | "error",
  ) {
    const taskId = Number(attributes["task.id"]);
    const taskName = String(attributes["task.name"]);
    if (!this.#interrupted.has(taskId)) return;
    if (attributes.resumed === true)
      logLifecycle({
        ...this.#ids,
        event: "review.recovery_phase",
        taskId,
        taskName,
        taskPhase: String(attributes.phase),
        outcome,
        status,
      });
    if (outcome !== null && TERMINAL.has(outcome)) {
      this.#interrupted.delete(taskId);
      logLifecycle({
        ...this.#ids,
        event: "review.recovery_task_ended",
        taskId,
        taskName,
        outcome,
        status,
      });
    }
  }

  readonly telemetry: Telemetry = {
    startSpan: async (options, callback) => {
      const attributes: Record<string, unknown> = { ...options.attributes };
      let status: "ok" | "error" = "ok";
      const span: Span = {
        startSpan: (o, c) => this.telemetry.startSpan(o, c),
        addLink: () => {},
        addEvent: () => {},
        setAttributes: (a) => Object.assign(attributes, a),
        setStatus: (s) => {
          status = s.status;
        },
      };
      if (options.name !== "pi.durable.phase") return callback(span);
      try {
        return await callback(span);
      } catch (error) {
        status = "error";
        throw error;
      } finally {
        const outcome = attributes.outcome;
        this.#phase(
          attributes,
          typeof outcome === "string" ? outcome : null,
          status,
        );
      }
    },
  };
}
