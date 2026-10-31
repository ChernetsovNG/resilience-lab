import { writeFile } from "node:fs/promises";
import { blockGeometry, minimumBlockHeight } from "../src/canvas/blockGeometry.ts";

const blocks = [
  { type: "client", title: "Клиент / Person", name: "Клиент", lines: ["Нагрузка: 30/s", "Дедлайн: 10s"], ports: ["OUT"] },
  { type: "service", title: "Сервис", name: "Сервис", lines: ["Обработчики: 4", "Очередь: 16"], ports: ["IN", "OUT"] },
  { type: "database", title: "База данных / цилиндр", name: "База данных", lines: ["Соединения: 3", "Очередь: 4"], ports: ["IN"] },
  { type: "pooler", title: "Пулер / двойная рамка", name: "Пулер", lines: ["Пул: 20", "Ожидание: 50ms"], ports: ["IN", "OUT"] },
  { type: "router", title: "Маршрутизатор / круг", name: "router", lines: ["По очереди"], ports: ["IN", "OUT"] },
  { type: "service", replicas: 3, title: "Группа реплик / стопка", name: "Сервис", lines: ["Обработчики: 4", "Очередь: 16"], ports: ["IN", "OUT"] },
];
const pathElements = paths => paths.map(d => `<path d="${d}"/>`).join("");
const cells = blocks.flatMap((block, row) => {
  const sizes = block.type === "router" ? [[120, 180], [144, 144], [144, 280]]
    : block.replicas ? [[180, 220], [264, 188], [264, 280]] : [[150, 220], [192, 180], [192, 280]];
  return sizes.map(([width, requestedHeight], column) => {
    const height = Math.max(requestedHeight, minimumBlockHeight(block.type, width, 72, block.replicas));
    const shape = blockGeometry(block.type, width, height, block.replicas);
    const x = 24 + column * 340 + (300 - width) / 2;
    const y = 92 + row * 340;
    const textX = shape.content.x;
    const textY = shape.content.y + 14;
    const stroke = block.type === "client" ? "#0ea5e9" : "#9aa5b1";
    return `<g>
      <svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <g fill="#fff" stroke="${stroke}" stroke-width="1">${pathElements(shape.back)}${pathElements(shape.paths)}</g>
        <g fill="none" stroke="${stroke}">${pathElements(shape.details)}</g>
        <text x="${textX}" y="${textY}" font-weight="600" fill="#1f2933">${block.name}</text>
        ${block.lines.map((line, index) => `<text x="${textX}" y="${textY + 20 * (index + 1)}" font-size="12" fill="#52606d">${line}</text>`).join("")}
        ${block.replicas ? `<text x="${shape.content.x + shape.content.width}" y="${textY}" text-anchor="end" fill="#52606d">×${block.replicas}</text>` : ""}
        ${block.ports.map(port => `<circle cx="${shape.ports[port].x}" cy="${shape.ports[port].y}" r="3" fill="#64748b"/>`).join("")}
      </svg>
      <text x="${x + width / 2}" y="${y + height + 18}" text-anchor="middle" font-size="11" fill="#64748b">${width} × ${height}</text>
    </g>`;
  });
});
const labels = blocks.map((block, row) => `<text x="24" y="${80 + row * 340}" font-size="14" font-weight="600">${block.title}</text>`);
await writeFile(new URL("../../docs/design/block-shapes.svg", import.meta.url), `<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="2120" viewBox="0 0 1040 2120" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">
  <title>Фигуры блоков: узкий, обычный и высокий размеры</title>
  <desc>Сгенерировано из web/src/canvas/blockGeometry.ts. Точки показывают порты на видимом контуре.</desc>
  <rect width="1040" height="2120" fill="#f5f7fa"/>
  <text x="24" y="28" font-size="20" font-weight="600">Геометрия блоков</text>
  ${["Узкий", "Обычный", "Высокий"].map((label, index) => `<text x="${174 + index * 340}" y="54" text-anchor="middle">${label}</text>`).join("")}
  ${labels.join("\n  ")}
  ${cells.join("\n  ")}
</svg>\n`.replace(/[ \t]+$/gm, ""));
