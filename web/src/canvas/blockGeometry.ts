export type Point = { x: number; y: number };
export type ContentBounds = Point & { width: number; height: number };

/** Model coordinates, never scaled SVG view boxes: fixed details keep their proportions. */
export interface BlockGeometry {
  shape: "card" | "person" | "cylinder" | "double" | "circle";
  paths: string[];
  details: string[];
  back: string[];
  content: ContentBounds;
  ports: { IN: Point; OUT: Point };
}

const horizontalPadding = 13.8;
const routerHorizontalPadding = 8;
const verticalPadding = 10.6;
const stackOffset = (type: string, replicas: number) => type === "service" && replicas > 1 ? 8 : 0;
const personContentTop = (width: number) => 2 + 2 * 0.38 * width / 3 + 0.25 * width + 8;

/** Minimum outer height for the measured HTML content, including the replica stack. */
export function minimumBlockHeight(type: string, width: number, contentHeight: number, replicas = 1): number {
  const offset = stackOffset(type, replicas);
  if (type === "client") return Math.ceil(personContentTop(width) + contentHeight + 10);
  if (type === "router") return Math.max(144, Math.ceil(2 * contentHeight / 0.9 + 2));
  return Math.ceil(contentHeight + (type === "database" ? 22 + verticalPadding : 2 * verticalPadding) + offset);
}

/** Fits the measured content rectangle inside the router's circular contour. */
export function minimumRouterDiameter(contentWidth: number, contentHeight: number): number {
  return Math.max(144, Math.ceil(contentWidth + 2 * routerHorizontalPadding), Math.ceil(Math.hypot(contentWidth, contentHeight) + 6));
}

function roundedCard(x: number, y: number, width: number, height: number): string {
  return `M ${x + 9} ${y + 1} H ${x + width - 9} A 8 8 0 0 1 ${x + width - 1} ${y + 9} V ${y + height - 9} A 8 8 0 0 1 ${x + width - 9} ${y + height - 1} H ${x + 9} A 8 8 0 0 1 ${x + 1} ${y + height - 9} V ${y + 9} A 8 8 0 0 1 ${x + 9} ${y + 1} Z`;
}

function circlePath(cx: number, cy: number, radius: number): string {
  return `M ${cx - radius} ${cy} a ${radius} ${radius} 0 1 0 ${2 * radius} 0 a ${radius} ${radius} 0 1 0 ${-2 * radius} 0 Z`;
}

/** Silhouette, content rectangle and visible-contour ports for an actual outer node size. */
export function blockGeometry(type: string, width: number, height: number, replicas = 1, routerContent?: { width: number; height: number }): BlockGeometry {
  const offset = stackOffset(type, replicas);
  const w = width - offset;
  const h = height - offset;
  const top = type === "database" ? 22 : verticalPadding;
  const geometry: BlockGeometry = {
    shape: "card",
    paths: [roundedCard(0, offset, w, h)],
    details: [],
    back: offset === 0 ? [] : [roundedCard(8, 0, w, h), roundedCard(4, 4, w, h)],
    content: { x: horizontalPadding, y: offset + top, width: w - 2 * horizontalPadding,
      height: Math.max(0, h - top - verticalPadding) },
    ports: { IN: { x: 1, y: offset + h / 2 }, OUT: { x: w - 1, y: offset + h / 2 } },
  };
  switch (type) {
    case "client": {
      const diameter = 0.38 * w;
      const bodyTop = 2 + 2 * diameter / 3;
      const shoulder = 0.25 * w;
      const bodyShoulder = bodyTop + shoulder;
      geometry.shape = "person";
      geometry.paths = [
        circlePath(w / 2, 2 + diameter / 2, diameter / 2),
        `M ${2 + shoulder} ${bodyTop} H ${w - 2 - shoulder} A ${shoulder} ${shoulder} 0 0 1 ${w - 2} ${bodyShoulder} V ${h - 10} A 8 8 0 0 1 ${w - 10} ${h - 2} H 10 A 8 8 0 0 1 2 ${h - 10} V ${bodyShoulder} A ${shoulder} ${shoulder} 0 0 1 ${2 + shoulder} ${bodyTop} Z`,
      ];
      geometry.content.y = personContentTop(w);
      geometry.content.height = Math.max(0, h - geometry.content.y - 10);
      const portY = (bodyShoulder + h - 10) / 2;
      geometry.ports = { IN: { x: 2, y: portY }, OUT: { x: w - 2, y: portY } };
      break;
    }
    case "database": {
      const rx = (w - 2) / 2;
      geometry.shape = "cylinder";
      geometry.paths = [`M 1 9 A ${rx} 8 0 0 1 ${w - 1} 9 V ${h - 9} A ${rx} 8 0 0 1 1 ${h - 9} Z`];
      geometry.details = [`M 1 9 A ${rx} 8 0 0 0 ${w - 1} 9`];
      break;
    }
    case "pooler":
      geometry.shape = "double";
      geometry.paths = [`M 1 1 H ${w - 1} V ${h - 1} H 1 Z`];
      geometry.details = [`M 7 7 H ${w - 7} V ${h - 7} H 7 Z`];
      break;
    case "router": {
      const radius = (Math.min(w, h) - 2) / 2;
      geometry.shape = "circle";
      geometry.paths = [circlePath(w / 2, h / 2, radius)];
      geometry.content = { x: w / 2 - 0.85 * radius, y: h / 2 - 0.45 * radius,
        width: 1.7 * radius, height: 0.9 * radius };
      if (routerContent !== undefined && routerContent.width > 0 && routerContent.height > 0) {
        const scale = Math.max(0, Math.min(2 * (radius - 2) / Math.hypot(routerContent.width, routerContent.height),
          (w - 2 * routerHorizontalPadding) / routerContent.width));
        const contentWidth = routerContent.width * scale;
        const contentHeight = routerContent.height * scale;
        geometry.content = { x: (w - contentWidth) / 2, y: (h - contentHeight) / 2, width: contentWidth, height: contentHeight };
      }
      geometry.ports = { IN: { x: w / 2 - radius, y: h / 2 }, OUT: { x: w / 2 + radius, y: h / 2 } };
      break;
    }
  }
  return geometry;
}
