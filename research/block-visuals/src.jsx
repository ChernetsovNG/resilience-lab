import React, { memo, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  ReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  useNodesInitialized,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import fontUrl from "@fortawesome/fontawesome-free/webfonts/fa-solid-900.woff2?url";
import "./style.css";
const css = document.createElement("style");
css.textContent = `@font-face{font-family:BenchIcons;src:url(${fontUrl});font-weight:900;font-display:block}`;
document.head.append(css);
const q = new URLSearchParams(location.search),
  mode = q.get("mode") || "parametric",
  N = Number(q.get("n") || 50),
  cull = q.get("cull") === "1";
const types = ["Person", "Service", "Database", "Pooler", "Router", "Replicas"];
const glyphs = ["\uf007", "\uf233", "\uf1c0", "\uf0c2", "\uf0e8", "\uf5fd"];
const colors = [
  "#d6eaf8",
  "#def1e1",
  "#ffe1c5",
  "#efe0fa",
  "#ffe7a8",
  "#ffd6d6",
];
const cols = Math.ceil(Math.sqrt(N)),
  rows = Math.ceil(N / cols),
  stepX = 244,
  stepY = 172;
const nodes = Array.from({ length: N }, (_, i) => ({
  id: String(i),
  type: "block",
  position: { x: (i % cols) * stepX, y: Math.floor(i / cols) * stepY },
  data: { kind: i % 6, w: 180 + (i % 3) * 12, h: 126 + (i % 2) * 10 },
}));
const edges = nodes.slice(1).map((n, i) => ({
  id: `e${i}`,
  source: String(i),
  target: n.id,
  type: "straight",
}));
const center = {
  x: ((cols - 1) * stepX + 204) / 2,
  y: ((rows - 1) * stepY + 136) / 2,
};
const viewport = (z) => ({
  x: innerWidth / 2 - center.x * z,
  y: innerHeight / 2 - center.y * z,
  zoom: z,
});
// All geometry is own work. Fixed details retain pixel dimensions as the body stretches.
function geometryVariables(w, h) {
  const d = Math.min(0.38 * w, 0.35 * h);
  return {
    w,
    h,
    cx: w / 2,
    cy: h / 2,
    r: (Math.min(w, h) - 4) / 2,
    rx: (w - 4) / 2,
    headR: d / 2,
    headCy: 2 + d / 2,
    headL: w / 2 - d / 2,
    bodyTop: 2 + (d * 2) / 3,
    bodyShoulder: 24 + (d * 2) / 3,
  };
}
function shapePaths(k, w, h) {
  const { cx, cy, r, rx, headR, headCy, headL, bodyTop, bodyShoulder } =
    geometryVariables(w, h);
  switch (k) {
    case 0:
      return [
        `M ${headL} ${headCy} a ${headR} ${headR} 0 1 0 ${2 * headR} 0 a ${headR} ${headR} 0 1 0 ${-2 * headR} 0`,
        `M 2 ${h - 2} V ${bodyShoulder} Q 2 ${bodyTop} ${cx} ${bodyTop} Q ${w - 2} ${bodyTop} ${w - 2} ${bodyShoulder} V ${h - 2} Z`,
      ];
    case 1:
      return [
        `M 12 2 H ${w - 12} Q ${w - 2} 2 ${w - 2} 12 V ${h - 12} Q ${w - 2} ${h - 2} ${w - 12} ${h - 2} H 12 Q 2 ${h - 2} 2 ${h - 12} V 12 Q 2 2 12 2 Z`,
      ];
    case 2:
      return [
        `M 2 18 A ${rx} 16 0 0 1 ${w - 2} 18 V ${h - 18} A ${rx} 16 0 0 1 2 ${h - 18} Z`,
        `M 2 18 A ${rx} 16 0 0 0 ${w - 2} 18`,
      ];
    case 3:
      return [
        `M 2 2 H ${w - 2} V ${h - 2} H 2 Z`,
        `M 8 8 H ${w - 8} V ${h - 8} H 8 Z`,
      ];
    case 4:
      return [
        `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`,
      ];
    default:
      return [
        `M 16 2 H ${w - 2} V ${h - 16} H 16 Z`,
        `M 9 9 H ${w - 9} V ${h - 9} H 9 Z`,
        `M 2 16 H ${w - 16} V ${h - 2} H 2 Z`,
      ];
  }
}
// A deliberately small XML path-template interpreter, not the mxGraph/mxStencil runtime.
const xmlTemplates = [
  '<shape><path d="M @headL @headCy a @headR @headR 0 1 0 @headDiameter 0 a @headR @headR 0 1 0 @negativeHeadDiameter 0"/><path d="M 2 @h-2 V @bodyShoulder Q 2 @bodyTop @cx @bodyTop Q @w-2 @bodyTop @w-2 @bodyShoulder V @h-2 Z"/></shape>',
  '<shape><path d="M 12 2 H @w-12 Q @w-2 2 @w-2 12 V @h-12 Q @w-2 @h-2 @w-12 @h-2 H 12 Q 2 @h-2 2 @h-12 V 12 Q 2 2 12 2 Z"/></shape>',
  '<shape><path d="M 2 18 A @rx 16 0 0 1 @w-2 18 V @h-18 A @rx 16 0 0 1 2 @h-18 Z"/><path d="M 2 18 A @rx 16 0 0 0 @w-2 18"/></shape>',
  '<shape><path d="M 2 2 H @w-2 V @h-2 H 2 Z"/><path d="M 8 8 H @w-8 V @h-8 H 8 Z"/></shape>',
  '<shape><path d="M @circleL @cy a @r @r 0 1 0 @diameter 0 a @r @r 0 1 0 @negativeDiameter 0"/></shape>',
  '<shape><path d="M 16 2 H @w-2 V @h-16 H 16 Z"/><path d="M 9 9 H @w-9 V @h-9 H 9 Z"/><path d="M 2 16 H @w-16 V @h-2 H 2 Z"/></shape>',
].map((xml) =>
  [
    ...new DOMParser()
      .parseFromString(xml, "application/xml")
      .querySelectorAll("path"),
  ].map((p) => p.getAttribute("d")),
);
function stencilPaths(k, w, h) {
  const v = geometryVariables(w, h);
  Object.assign(v, {
    headDiameter: 2 * v.headR,
    negativeHeadDiameter: -2 * v.headR,
    circleL: v.cx - v.r,
    diameter: 2 * v.r,
    negativeDiameter: -2 * v.r,
  });
  return xmlTemplates[k].map((p) =>
    p.replace(
      /@([A-Za-z]\w*)([+-]\d+(?:\.\d+)?)?/g,
      (_, name, delta) => v[name] + Number(delta || 0),
    ),
  );
}
for (let k = 0; k < 6; k++) {
  for (const [w, h] of [
    [180, 126],
    [300, 180],
    [150, 220],
  ]) {
    if (
      JSON.stringify(shapePaths(k, w, h)) !==
      JSON.stringify(stencilPaths(k, w, h))
    )
      throw Error(`Geometry mismatch: ${k}`);
  }
}
function ports(kind, w, h) {
  if (kind !== 4 || ["react-icon", "symbol", "font"].includes(mode))
    return { left: 0, right: w, y: h / 2 };
  if (mode === "fixed-svg")
    return { left: (w * 29) / 180, right: (w * 151) / 180, y: h / 2 };
  const r = (Math.min(w, h) - 4) / 2;
  return { left: w / 2 - r, right: w / 2 + r, y: h / 2 };
}
const iconPaths = [
  ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8", "M4 22v-3c0-7 16-7 16 0v3"],
  ["M3 3h18v8H3z M3 14h18v7H3z", "M6 7h1 M6 18h1"],
  [
    "M3 6c0-5 18-5 18 0v12c0 5-18 5-18 0z",
    "M3 6c0 5 18 5 18 0 M3 12c0 5 18 5 18 0",
  ],
  ["M4 5h16v14H4z", "M8 9h8 M8 13h8"],
  [
    "M3 12h18 M12 3v18",
    "M3 8l-3 4 3 4 M21 8l3 4-3 4 M8 3l4-3 4 3 M8 21l4 3 4-3",
  ],
  ["M7 2h15v16H7z", "M2 7h15v16H2z"],
];
const Icon = memo(({ kind }) => (
  <svg
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
  >
    {iconPaths[kind].map((d, i) => (
      <path key={i} d={d} />
    ))}
  </svg>
));
function Symbols() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }}>
      <defs>
        {iconPaths.map((paths, k) => (
          <symbol key={k} id={`icon-${k}`} viewBox="0 0 24 24">
            {paths.map((d, i) => (
              <path key={i} d={d} />
            ))}
          </symbol>
        ))}
      </defs>
    </svg>
  );
}
function Silhouette({ kind, w, h }) {
  const fixed = mode === "fixed-svg";
  const paths =
    mode === "stencil"
      ? stencilPaths(kind, w, h)
      : shapePaths(kind, fixed ? 180 : w, fixed ? 126 : h);
  return (
    <svg
      className="silhouette"
      width={w}
      height={h}
      viewBox={`0 0 ${fixed ? 180 : w} ${fixed ? 126 : h}`}
      preserveAspectRatio="none"
      fill={colors[kind]}
      stroke="#365269"
      strokeWidth="1.7"
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
const Block = memo(({ data, selected }) => {
  const { kind, w, h } = data;
  const iconMode = ["react-icon", "symbol", "font"].includes(mode);
  return (
    <div
      className={`block ${!iconMode && kind === 0 ? "person" : !iconMode && kind === 4 ? "router" : ""}`}
      style={{ width: w, height: h }}
    >
      {iconMode ? (
        <div className="card" style={{ background: colors[kind] }} />
      ) : (
        <Silhouette kind={kind} w={w} h={h} />
      )}
      <div className="content">
        <div className="title">
          {iconMode &&
            (mode === "font" ? (
              <span className="fontIcon">{glyphs[kind]}</span>
            ) : mode === "symbol" ? (
              <svg
                width="24"
                height="24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <use href={`#icon-${kind}`} />
              </svg>
            ) : (
              <Icon kind={kind} />
            ))}
          <b>{types[kind]}</b>
        </div>
        <input
          aria-label={`${types[kind]} capacity`}
          defaultValue="capacity: 32"
        />
        <div className="metric">p99: 48 ms · 72%</div>
      </div>
      {kind === 1 && <span className="override">↗</span>}
      {kind === 4 && <span className="selected" />}
      <Handle
        type="target"
        position={Position.Left}
        style={{ left: ports(kind, w, h).left }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{ right: w - ports(kind, w, h).right }}
      />
    </div>
  );
});
let controller, initialResolve;
const initialized = new Promise((resolve) => (initialResolve = resolve));
function Ready() {
  const ready = useNodesInitialized(),
    flow = useReactFlow();
  useEffect(() => {
    if (ready) {
      controller = flow;
      initialResolve();
    }
  }, [ready, flow]);
  return null;
}
function Flow() {
  return (
    <ReactFlowProvider>
      <Symbols />
      <ReactFlow
        defaultNodes={nodes}
        defaultEdges={edges}
        nodeTypes={{ block: Block }}
        defaultViewport={viewport(0.05)}
        minZoom={0.05}
        maxZoom={2}
        onlyRenderVisibleElements={cull}
        nodesDraggable={true}
        nodesConnectable={true}
        elementsSelectable={true}
        proOptions={{ hideAttribution: true }}
      >
        <Ready />
      </ReactFlow>
    </ReactFlowProvider>
  );
}
const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
let draw,
  rendererInfo = null;
async function atlas() {
  const a = document.createElement("canvas");
  a.width = 6 * 216;
  a.height = 148;
  const ctx = a.getContext("2d");
  for (let k = 0; k < 6; k++) {
    const w = 180 + (k % 3) * 12,
      h = 126 + (k % 2) * 10;
    ctx.save();
    ctx.translate(k * 216 + 4, 4);
    ctx.fillStyle = colors[k];
    ctx.strokeStyle = "#365269";
    ctx.lineWidth = 1.7;
    for (const d of shapePaths(k, w, h)) {
      const p = new Path2D(d);
      ctx.fill(p);
      ctx.stroke(p);
    }
    ctx.fillStyle = "#163047";
    const tx = k === 4 ? w / 2 - 51 : 26,
      titleY = k === 0 ? 65 : k === 4 ? h / 2 - 16 : 49;
    ctx.font = "bold 14px Arial";
    ctx.fillText(types[k], tx, titleY);
    ctx.strokeStyle = "#36526944";
    ctx.beginPath();
    ctx.moveTo(tx, titleY + 26);
    ctx.lineTo(k === 4 ? tx + 102 : w - 20, titleY + 26);
    ctx.stroke();
    ctx.font = k === 4 ? "11px Arial" : "13px Arial";
    ctx.fillText("capacity: 32", tx, titleY + 22);
    ctx.fillText("p99: 48 ms · 72%", tx, titleY + 44);
    if (k === 1) {
      ctx.fillStyle = "#8a4914";
      ctx.fillText("↗", w - 24, 24);
    }
    if (k === 4) {
      ctx.strokeStyle = "#2463eb";
      ctx.lineWidth = 3;
      ctx.strokeRect(1, 1, w - 2, h - 2);
    }
    for (const x of [ports(k, w, h).left, ports(k, w, h).right]) {
      ctx.fillStyle = "#355269";
      ctx.beginPath();
      ctx.arc(x, h / 2, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  return a;
}
async function setupRaster() {
  const canvas = document.createElement("canvas");
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  document.getElementById("root").append(canvas);
  const a = await atlas();
  if (mode === "canvas2d") {
    const ctx = canvas.getContext("2d", { alpha: false });
    rendererInfo = { api: "Canvas2D", atlas: "6 cached tiles" };
    draw = (v) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#f3f7fa";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(v.zoom, 0, 0, v.zoom, v.x, v.y);
      ctx.strokeStyle = "#8aa0b2";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < N; i++) {
        const p = nodes[i - 1],
          n = nodes[i];
        ctx.moveTo(
          p.position.x + ports(p.data.kind, p.data.w, p.data.h).right,
          p.position.y + p.data.h / 2,
        );
        ctx.lineTo(
          n.position.x + ports(n.data.kind, n.data.w, n.data.h).left,
          n.position.y + n.data.h / 2,
        );
      }
      ctx.stroke();
      for (const n of nodes) {
        const { kind, w, h } = n.data;
        ctx.drawImage(
          a,
          kind * 216,
          0,
          w + 8,
          h + 8,
          n.position.x - 4,
          n.position.y - 4,
          w + 8,
          h + 8,
        );
      }
    };
  } else {
    const gl = canvas.getContext("webgl", { alpha: false, antialias: true });
    if (!gl) throw Error("WebGL unavailable");
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    rendererInfo = {
      api: gl.getParameter(gl.VERSION),
      vendor: ext
        ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)
        : gl.getParameter(gl.VENDOR),
      renderer: ext
        ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),
      atlas: "6 cached tiles",
    };
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw Error(gl.getShaderInfoLog(s));
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(
      program,
      shader(
        gl.VERTEX_SHADER,
        "attribute vec2 p;attribute vec2 uv;uniform vec3 v;uniform vec2 size;varying vec2 t;void main(){vec2 q=(p*v.z+v.xy)/size*2.-1.;gl_Position=vec4(q.x,-q.y,0.,1.);t=uv;}",
      ),
    );
    gl.attachShader(
      program,
      shader(
        gl.FRAGMENT_SHADER,
        "precision mediump float;varying vec2 t;uniform sampler2D tex;uniform bool edges;void main(){gl_FragColor=edges?vec4(.54,.63,.70,1.):texture2D(tex,t);}",
      ),
    );
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const verts = [],
      lines = [];
    for (let i = 0; i < N; i++) {
      const n = nodes[i],
        { kind, w, h } = n.data,
        x = n.position.x - 4,
        y = n.position.y - 4,
        u = (kind * 216) / a.width,
        U = (kind * 216 + w + 8) / a.width,
        V = (h + 8) / a.height;
      for (const [X, Y, s, t] of [
        [x, y, u, 0],
        [x + w + 8, y, U, 0],
        [x, y + h + 8, u, V],
        [x, y + h + 8, u, V],
        [x + w + 8, y, U, 0],
        [x + w + 8, y + h + 8, U, V],
      ])
        verts.push(X, Y, s, t);
      if (i) {
        const p = nodes[i - 1];
        lines.push(
          p.position.x + ports(p.data.kind, p.data.w, p.data.h).right,
          p.position.y + p.data.h / 2,
          0,
          0,
          n.position.x + ports(n.data.kind, n.data.w, n.data.h).left,
          n.position.y + n.data.h / 2,
          0,
          0,
        );
      }
    }
    const buffer = (data) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      return b;
    };
    const vb = buffer(verts),
      lb = buffer(lines);
    const p = gl.getAttribLocation(program, "p"),
      uv = gl.getAttribLocation(program, "uv");
    gl.enableVertexAttribArray(p);
    gl.enableVertexAttribArray(uv);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, a);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(
      gl.getUniformLocation(program, "size"),
      canvas.width,
      canvas.height,
    );
    const loc = gl.getUniformLocation(program, "v"),
      edgeLoc = gl.getUniformLocation(program, "edges");
    const bind = (b) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 16, 0);
      gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);
    };
    draw = (v) => {
      gl.clearColor(0.953, 0.969, 0.98, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform3f(loc, v.x, v.y, v.zoom);
      gl.uniform1i(edgeLoc, 1);
      bind(lb);
      gl.drawArrays(gl.LINES, 0, lines.length / 4);
      gl.uniform1i(edgeLoc, 0);
      bind(vb);
      gl.drawArrays(gl.TRIANGLES, 0, verts.length / 4);
    };
  }
  controller = {
    setViewport: (v) => {
      draw(v);
      controller.current = v;
    },
    getViewport: () => controller.current,
  };
  controller.setViewport(viewport(0.05));
  initialResolve();
}
function visible(v) {
  return nodes.reduce(
    (sum, n) =>
      sum +
      Number(
        (n.position.x + n.data.w) * v.zoom + v.x >= 0 &&
          n.position.x * v.zoom + v.x < innerWidth &&
          (n.position.y + n.data.h) * v.zoom + v.y >= 0 &&
          n.position.y * v.zoom + v.y < innerHeight,
      ),
    0,
  );
}
if (q.has("gallery")) {
  createRoot(document.getElementById("root")).render(
    <main className="gallery">
      <h1>Own silhouettes: {mode}</h1>
      <nav>
        {["parametric", "stencil", "fixed-svg"].map((m) => (
          <a key={m} href={`?gallery=1&mode=${m}`}>
            {m}
          </a>
        ))}
      </nav>
      <p>
        Normal 180×126 · wide 300×180 · tall 150×220; own icons at 16/24 px.
        Same illustration functions as benchmark.
      </p>
      <Symbols />
      {types.map((name, kind) => (
        <section key={kind}>
          <h2>{name}</h2>
          <div className="samples">
            {[
              [180, 126],
              [300, 180],
              [150, 220],
            ].map(([w, h]) => (
              <div
                key={w}
                style={{ width: w, height: h, position: "relative" }}
              >
                <Silhouette kind={kind} w={w} h={h} />
                <div
                  style={{
                    position: "absolute",
                    left: kind === 4 ? w / 2 - 51 : 26,
                    fontSize: kind === 4 ? 11 : 13,
                    top:
                      kind === 0
                        ? geometryVariables(w, h).bodyTop + 18
                        : kind === 4
                          ? h / 2 - 31
                          : 35,
                  }}
                >
                  <b>{name}</b>
                  <p>capacity: 32</p>
                  <p>p99: 48 ms · 72%</p>
                </div>
              </div>
            ))}
            <span style={{ display: "flex", gap: 20 }}>
              {[16, 24].map((size) => (
                <svg
                  key={size}
                  width={size}
                  height={size}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                >
                  {iconPaths[kind].map((d, i) => (
                    <path key={i} d={d} />
                  ))}
                </svg>
              ))}
            </span>
          </div>
        </section>
      ))}
    </main>,
  );
  await new Promise(() => {});
}
if (["canvas2d", "webgl"].includes(mode)) await setupRaster();
else createRoot(document.getElementById("root")).render(<Flow />);
await initialized;
if (mode === "font") await document.fonts.load("900 24px BenchIcons");
await document.fonts.ready;
await raf();
await raf();
const firstReadyMs = performance.now() - window.bootstrapStart;
const initialDom = document.querySelectorAll("*").length;
const qtile = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.ceil(s.length * p) - 1] || 0;
};
window.benchPreview = async (z = 0.6) => {
  controller.setViewport(viewport(z));
  await raf();
  await raf();
};
window.benchReady = true;
window.bench = {
  metadata: {
    mode,
    N,
    cull,
    edges: edges.length,
    geometryChecks: 18,
    stencilShapes: xmlTemplates.length,
    rendererInfo,
    firstReadyMs,
    initialDom,
    initialMountedNodes: document.querySelectorAll(".react-flow__node").length,
    initialVisibleNodes: visible(viewport(0.05)),
    devicePixelRatio,
    viewport: { width: innerWidth, height: innerHeight },
  },
  async run({ warmupMs = 2000, durationMs = 4000 } = {}) {
    const gaps = [],
      zooms = [],
      visibleSamples = [];
    let previous;
    const animate = async (duration, record) => {
      const start = performance.now();
      let elapsed = 0;
      while (elapsed < duration) {
        const t = await raf();
        elapsed = t - start;
        const phase = Math.min(1, elapsed / duration);
        const z =
          0.05 * Math.pow(40, 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI));
        controller.setViewport(viewport(z));
        if (record) {
          if (previous !== undefined) gaps.push(t - previous);
          previous = t;
          zooms.push(controller.getViewport().zoom);
        }
      }
      return performance.now() - start;
    };
    await animate(warmupMs, false);
    await raf();
    const actualDurationMs = await animate(durationMs, true);
    await raf();
    await raf();
    for (const z of [0.05, 0.1, 0.2, 0.5, 1, 2])
      visibleSamples.push({ zoom: z, count: visible(viewport(z)) });
    // Untimed probe distinguishes geometric visibility from actual DOM culling.
    await window.benchPreview(2);
    const detailDom = document.querySelectorAll("*").length;
    const detailMountedNodes =
      document.querySelectorAll(".react-flow__node").length;
    await window.benchPreview(0.05);
    return {
      ...this.metadata,
      detailDom,
      detailMountedNodes,
      detailVisibleNodes: visible(viewport(2)),
      actualDurationMs,
      frames: gaps.length + 1,
      fps: (1000 / gaps.reduce((s, x) => s + x, 0)) * gaps.length,
      p50FrameGapMs: qtile(gaps, 0.5),
      p95FrameGapMs: qtile(gaps, 0.95),
      maxFrameGapMs: Math.max(...gaps),
      frameGapsMs: gaps,
      realizedZoomRange: [Math.min(...zooms), Math.max(...zooms)],
      visibleSamples,
      finalDom: document.querySelectorAll("*").length,
      finalMountedNodes: document.querySelectorAll(".react-flow__node").length,
      renderedEdges: document.querySelectorAll(".react-flow__edge").length,
      fontLoaded:
        mode === "font" ? document.fonts.check("900 24px BenchIcons") : null,
    };
  },
};
