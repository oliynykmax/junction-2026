// A frame-driven loader in the spirit of fframes: every scene is a pure
// function of time that returns SVG, sampled on requestAnimationFrame so the
// motion runs at the display's refresh rate instead of CSS keyframe steps.

import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";

type Ease = (x: number) => number;
type SpringConfig = { mass?: number; stiffness: number; damping: number };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const easeOut: Ease = (x) => 1 - (1 - x) ** 3;
const easeIn: Ease = (x) => x ** 3;
const easeInOut: Ease = (x) =>
  x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2;

const SNAPPY: SpringConfig = { stiffness: 400, damping: 22 };
const SOFT: SpringConfig = { stiffness: 170, damping: 15 };
const BOUNCY: SpringConfig = { stiffness: 260, damping: 11 };

const tween = (t: number, start: number, dur: number, ease: Ease = easeOut) =>
  ease(clamp01((t - start) / dur));

// Closed-form damped spring from 0 to 1, so any frame can be sampled directly.
function spring(t: number, start: number, cfg: SpringConfig) {
  const x = t - start;
  if (x <= 0) return 0;
  const m = cfg.mass ?? 1;
  const w0 = Math.sqrt(cfg.stiffness / m);
  const zeta = cfg.damping / (2 * Math.sqrt(cfg.stiffness * m));
  if (zeta >= 1) return 1 - Math.exp(-w0 * x) * (1 + w0 * x);
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  return (
    1 -
    Math.exp(-zeta * w0 * x) *
      (Math.cos(wd * x) + ((zeta * w0) / wd) * Math.sin(wd * x))
  );
}

const deg = (rad: number) => (rad * 180) / Math.PI;

type Scene = {
  duration: number;
  draw: (t: number) => JSX.Element;
};

// ---------- Gears ----------

const MODULE = 4.4;

function gearPath(teeth: number) {
  const r = (teeth * MODULE) / 2;
  const outer = r + MODULE * 0.95;
  const root = r - MODULE * 1.15;
  const step = (2 * Math.PI) / teeth;
  const pts: string[] = [];
  for (let k = 0; k < teeth; k++) {
    const a = k * step;
    for (const [rad, off] of [
      [root, -0.5],
      [root, -0.31],
      [outer, -0.15],
      [outer, 0.15],
      [root, 0.31],
    ] as const) {
      const ang = a + off * step;
      pts.push(
        `${(rad * Math.cos(ang)).toFixed(2)} ${(rad * Math.sin(ang)).toFixed(2)}`,
      );
    }
  }
  return `M${pts.join("L")}Z`;
}

type Gear = {
  teeth: number;
  x: number;
  y: number;
  path: string;
  phase: number;
  ratio: number;
  tone: "ink" | "accent" | "dim";
};

// A driven gear meshes with its driver when its gap faces the driver's tooth
// along the line between centres; ratio flips direction and scales speed.
function meshWith(
  driver: Gear,
  teeth: number,
  theta: number,
  tone: Gear["tone"],
): Gear {
  const dist = ((driver.teeth + teeth) * MODULE) / 2;
  const ratio = (-driver.ratio * driver.teeth) / teeth;
  const phase =
    theta +
    Math.PI +
    Math.PI / teeth -
    ((driver.phase - theta) * driver.teeth) / teeth;
  return {
    teeth,
    x: driver.x + dist * Math.cos(theta),
    y: driver.y + dist * Math.sin(theta),
    path: gearPath(teeth),
    phase,
    ratio,
    tone,
  };
}

const BIG: Gear = {
  teeth: 12,
  x: 70,
  y: 92,
  path: gearPath(12),
  phase: 0,
  ratio: 1,
  tone: "ink",
};
const MESH_ANGLE = (-38 * Math.PI) / 180;
const GEARS = [
  BIG,
  meshWith(BIG, 8, MESH_ANGLE, "accent"),
  meshWith(BIG, 6, (200 * Math.PI) / 180, "dim"),
];
const MESH_POINT = {
  x: BIG.x + ((BIG.teeth * MODULE) / 2) * Math.cos(MESH_ANGLE),
  y: BIG.y + ((BIG.teeth * MODULE) / 2) * Math.sin(MESH_ANGLE),
};
const CLICK = 0.42;

function drawGears(t: number) {
  const k = Math.floor(t / CLICK);
  const turn = ((2 * Math.PI) / BIG.teeth) * (k + spring(t, k * CLICK, SNAPPY));
  const since = t - k * CLICK;
  const spark = 1 - tween(since, 0, 0.28);
  return (
    <g>
      {GEARS.map((g) => {
        const r = (g.teeth * MODULE) / 2;
        return (
          <g
            key={g.teeth}
            transform={`translate(${g.x} ${g.y}) rotate(${deg(g.phase + turn * g.ratio)})`}
          >
            <path d={g.path} class={`pl-${g.tone}`} />
            <circle r={r * 0.32} class="pl-bg" />
            <circle cx={r * 0.62} r={MODULE * 0.45} class="pl-bg" />
          </g>
        );
      })}
      <g
        transform={`translate(${MESH_POINT.x} ${MESH_POINT.y})`}
        opacity={spark}
      >
        {[-70, -25, 20].map((a) => {
          const rad = ((a - 38) * Math.PI) / 180;
          const r0 = 7 + since * 30;
          return (
            <line
              key={a}
              x1={r0 * Math.cos(rad)}
              y1={r0 * Math.sin(rad)}
              x2={(r0 + 5) * Math.cos(rad)}
              y2={(r0 + 5) * Math.sin(rad)}
              class="pl-stroke-accent"
              stroke-width="2.5"
            />
          );
        })}
      </g>
    </g>
  );
}

// ---------- Derivation ----------

function Drop(props: {
  t: number;
  at: number;
  x: number;
  y: number;
  size?: number;
  cls?: string;
  children: string;
}) {
  const p = spring(props.t, props.at, SOFT);
  return (
    <text
      x={props.x}
      y={props.y - 12 * (1 - p)}
      opacity={clamp01(p * 1.6)}
      class={`pl-text ${props.cls ?? ""}`}
      font-size={props.size ?? 13}
    >
      {props.children}
    </text>
  );
}

function Rule(props: {
  t: number;
  at: number;
  x1: number;
  x2: number;
  y: number;
  name: string;
}) {
  const p = tween(props.t, props.at, 0.28, easeInOut);
  return (
    <g>
      <line
        x1={props.x1}
        x2={lerp(props.x1, props.x2, p)}
        y1={props.y}
        y2={props.y}
        class="pl-stroke-accent"
        stroke-width="2.5"
        opacity={p > 0 ? 1 : 0}
      />
      <text
        x={props.x2 + 3}
        y={props.y + 3.5}
        opacity={tween(props.t, props.at + 0.2, 0.2)}
        class="pl-text pl-dim-text"
        font-size="8"
        text-anchor="start"
      >
        {props.name}
      </text>
    </g>
  );
}

function drawDerivation(t: number) {
  const goal = spring(t, 1.55, BOUNCY);
  const glow = tween(t, 1.55, 0.5);
  return (
    <g>
      <Drop t={t} at={0.05} x={30} y={38}>
        A
      </Drop>
      <Drop t={t} at={0.14} x={70} y={38}>
        A→B
      </Drop>
      <Rule t={t} at={0.45} x1={14} x2={92} y={47} name="→E" />
      <Drop t={t} at={0.75} x={53} y={66}>
        B
      </Drop>
      <Drop t={t} at={0.84} x={118} y={66}>
        B→C
      </Drop>
      <Rule t={t} at={1.15} x1={30} x2={140} y={76} name="→E" />
      <g
        transform={`translate(85 106) scale(${lerp(0.6, 1, goal)})`}
        opacity={clamp01(goal * 2)}
      >
        <rect
          x={-26}
          y={-17}
          width={52}
          height={26}
          rx={5}
          class="pl-accent"
          opacity={glow}
        />
        <text y={2} class="pl-text pl-goal" font-size="19">
          ⊢ C
        </text>
      </g>
    </g>
  );
}

// ---------- State space ----------

const NODES = [
  { x: 80, y: 22, level: 0, at: 0.2 },
  { x: 38, y: 60, level: 1, at: 0 },
  { x: 80, y: 60, level: 1, at: 0 },
  { x: 122, y: 60, level: 1, at: 0 },
  { x: 22, y: 98, level: 2, at: 0 },
  { x: 60, y: 98, level: 2, at: 0 },
  { x: 100, y: 98, level: 2, at: 0 },
  { x: 138, y: 98, level: 2, at: 0 },
  { x: 80, y: 136, level: 3, at: 0 },
];
NODES.forEach((n, i) => {
  const firstInLevel = NODES.findIndex((m) => m.level === n.level);
  n.at = 0.2 + n.level * 0.38 + (i - firstInLevel) * 0.08;
});
const EDGES: [number, number][] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 4],
  [1, 5],
  [2, 5],
  [2, 6],
  [3, 6],
  [3, 7],
  [5, 8],
  [6, 8],
];
const NODE_R = 7;
const GOAL = NODES.length - 1;

function drawStates(t: number) {
  return (
    <g>
      {EDGES.map(([a, b]) => {
        const from = NODES[a];
        const to = NODES[b];
        const len = Math.hypot(to.x - from.x, to.y - from.y);
        const ux = (to.x - from.x) / len;
        const uy = (to.y - from.y) / len;
        const x1 = from.x + ux * NODE_R;
        const y1 = from.y + uy * NODE_R;
        const p = tween(t, to.at - 0.26, 0.26, easeInOut);
        return (
          <g key={`${a}-${b}`}>
            <line
              x1={x1}
              y1={y1}
              x2={to.x - ux * NODE_R}
              y2={to.y - uy * NODE_R}
              class="pl-stroke-dim"
              stroke-width="1.5"
            />
            <line
              x1={x1}
              y1={y1}
              x2={lerp(x1, to.x - ux * NODE_R, p)}
              y2={lerp(y1, to.y - uy * NODE_R, p)}
              class="pl-stroke-ink"
              stroke-width="2"
              opacity={p > 0 ? 1 : 0}
            />
          </g>
        );
      })}
      {NODES.map((n, i) => {
        const pop = spring(t, n.at, BOUNCY);
        const ring = tween(t, n.at, 0.45);
        const isGoal = i === GOAL;
        return (
          <g key={i} transform={`translate(${n.x} ${n.y})`}>
            <circle r={NODE_R} class="pl-hollow" />
            {ring > 0 && ring < 1 && (
              <circle
                r={lerp(NODE_R, NODE_R * 2.4, ring)}
                class="pl-stroke-accent"
                stroke-width="1.5"
                fill="none"
                opacity={1 - ring}
              />
            )}
            <circle r={NODE_R * pop} class={isGoal ? "pl-ink" : "pl-accent"} />
            {isGoal && (
              <path
                d="M-3.4 0.2 L-0.8 2.8 L3.6 -2.4"
                class="pl-check-small"
                stroke-dasharray="1"
                stroke-dashoffset={1 - tween(t, n.at + 0.15, 0.25)}
                pathLength={1}
              />
            )}
          </g>
        );
      })}
    </g>
  );
}

// ---------- Induction ----------

const DOMINO = { w: 9, h: 44, gap: 22, x0: 12, base: 106 };
const DOMINO_LABELS = ["0", "1", "2", "…", "n", "n+1"];
const BLOCK = { x: 138, size: 15 };
const LEAN = deg(Math.asin((DOMINO.gap - DOMINO.w) / DOMINO.h));
const LAST_LEAN = deg(
  Math.atan((BLOCK.x - (DOMINO.x0 + 5 * DOMINO.gap + DOMINO.w)) / BLOCK.size),
);
const FALL = 0.2;

function drawDominoes(t: number) {
  const n = DOMINO_LABELS.length;
  const hitBlock = 0.35 + n * FALL;
  const blockPop = spring(t, hitBlock, BOUNCY);
  return (
    <g>
      <line
        x1={4}
        x2={156}
        y1={DOMINO.base + 0.75}
        y2={DOMINO.base + 0.75}
        class="pl-stroke-dim"
        stroke-width="1.5"
      />
      {DOMINO_LABELS.map((label, i) => {
        const start = 0.35 + i * FALL;
        const p = clamp01((t - start) / FALL);
        const rest = i === n - 1 ? LAST_LEAN : LEAN;
        const after = t - start - FALL;
        const bounce =
          after > 0 ? -0.12 * Math.exp(-14 * after) * Math.sin(30 * after) : 0;
        const angle = rest * (p * p + bounce);
        const x = DOMINO.x0 + i * DOMINO.gap;
        const lit = t >= start;
        return (
          <g key={label}>
            <g transform={`rotate(${angle} ${x + DOMINO.w} ${DOMINO.base})`}>
              <rect
                x={x}
                y={DOMINO.base - DOMINO.h}
                width={DOMINO.w}
                height={DOMINO.h}
                rx={1.5}
                class={lit ? "pl-accent" : "pl-ink"}
              />
            </g>
            <text
              x={x + DOMINO.w / 2}
              y={DOMINO.base + 14}
              class={`pl-text ${lit ? "" : "pl-dim-text"}`}
              font-size="8.5"
            >
              {label}
            </text>
          </g>
        );
      })}
      <g
        transform={`translate(${BLOCK.x + BLOCK.size / 2} ${DOMINO.base - BLOCK.size / 2}) scale(${1 + 0.18 * Math.sin(Math.PI * clamp01(blockPop))})`}
      >
        <rect
          x={-BLOCK.size / 2}
          y={-BLOCK.size / 2}
          width={BLOCK.size}
          height={BLOCK.size}
          class={t >= hitBlock ? "pl-accent" : "pl-ink"}
        />
      </g>
    </g>
  );
}

// ---------- Q.E.D. ----------

const SPARKS = Array.from({ length: 10 }, (_, i) => (i / 10) * 2 * Math.PI);

function drawQed(t: number) {
  const enter = spring(t, 0, SOFT);
  const fill = tween(t, 0.35, 0.55, easeInOut);
  const check = tween(t, 0.95, 0.3);
  const burst = tween(t, 1.2, 0.6);
  const breathe = 1 + 0.015 * Math.sin(Math.max(0, t - 1.4) * 4);
  const size = 60;
  return (
    <g
      transform={`translate(80 78) rotate(${lerp(-10, 0, enter)}) scale(${lerp(0.5, 1, enter) * breathe})`}
    >
      {burst > 0 &&
        burst < 1 &&
        SPARKS.map((a) => {
          const r0 = lerp(40, 58, burst);
          return (
            <line
              key={a}
              x1={r0 * Math.cos(a)}
              y1={r0 * Math.sin(a)}
              x2={(r0 + 7 * (1 - burst)) * Math.cos(a)}
              y2={(r0 + 7 * (1 - burst)) * Math.sin(a)}
              class="pl-stroke-accent"
              stroke-width="2.5"
            />
          );
        })}
      <rect
        x={-size / 2}
        y={size / 2 - size * fill}
        width={size}
        height={Math.max(0.5, size * fill)}
        class="pl-accent"
      />
      <rect
        x={-size / 2}
        y={-size / 2}
        width={size}
        height={size}
        rx={2}
        class="pl-hollow-ink"
      />
      <path
        d="M-15 1 L-4 12 L16 -11"
        class="pl-check"
        pathLength={1}
        stroke-dasharray="1"
        stroke-dashoffset={1 - check}
      />
    </g>
  );
}

const SCENES: Scene[] = [
  { duration: 2.6, draw: drawGears },
  { duration: 2.7, draw: drawDerivation },
  { duration: 2.6, draw: drawStates },
  { duration: 2.5, draw: drawDominoes },
  { duration: 2.2, draw: drawQed },
];
const OVERLAP = 0.35;
const STARTS = SCENES.reduce<number[]>(
  (acc, s, i) => [...acc, acc[i] + s.duration],
  [0],
);
const LOOP = STARTS[SCENES.length];

type Visible = { index: number; local: number; opacity: number; lift: number };

function visibleScenes(clock: number): Visible[] {
  const out: Visible[] = [];
  SCENES.forEach((scene, index) => {
    for (const wrap of [0, LOOP]) {
      const local = clock + wrap - STARTS[index];
      if (local < 0 || local >= scene.duration + OVERLAP) continue;
      const fadeIn = tween(local, 0, OVERLAP);
      const fadeOut = 1 - tween(local, scene.duration, OVERLAP * 0.8, easeIn);
      out.push({
        index,
        local,
        opacity: Math.min(fadeIn, fadeOut),
        lift: (1 - fadeOut) * -8 + (1 - fadeIn) * 8,
      });
    }
  });
  return out;
}

function useClock(reduced: boolean) {
  const [clock, setClock] = useState(0);
  useEffect(() => {
    if (reduced) {
      let i = 0;
      const id = setInterval(() => {
        i = (i + 1) % SCENES.length;
        setClock(STARTS[i] + SCENES[i].duration * 0.5);
      }, 2400);
      setClock(SCENES[0].duration * 0.5);
      return () => clearInterval(id);
    }
    let frame = 0;
    const origin = performance.now();
    const tick = (now: number) => {
      setClock(((now - origin) / 1000 + OVERLAP) % LOOP);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reduced]);
  return clock;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function ProofLoader() {
  const reduced = usePrefersReducedMotion();
  const clock = useClock(reduced);
  const scenes = reduced
    ? visibleScenes(clock).map((v) => ({ ...v, opacity: 1, lift: 0 }))
    : visibleScenes(clock);
  // In reduced motion each scene is shown settled, not mid-animation.
  const settle = (v: Visible) =>
    reduced ? SCENES[v.index].duration - 0.05 : v.local;
  return (
    <div class="proof-loader" aria-hidden="true">
      <svg viewBox="0 0 160 160" class="proof-canvas">
        {scenes.map((v) => (
          <g
            key={`${v.index}`}
            opacity={v.opacity}
            transform={`translate(0 ${v.lift})`}
          >
            {SCENES[v.index].draw(settle(v))}
          </g>
        ))}
      </svg>
    </div>
  );
}
