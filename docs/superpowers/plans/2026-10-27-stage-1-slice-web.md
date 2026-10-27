# Срез этапа 1: web — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить интерфейс MVP каркасом этапа 1 на API этапа 1: один экран без прокрутки, холст модели, инспектор параметров из каталога с сохранением, страницы вариантов для просмотра, запуск задания и сводка по вариантам.

**Architecture:** Типы API генерируются `openapi-typescript` из `apps/server/openapi.json`; тонкий клиент на `fetch` использует только их. Состояние — два хука: `useWorkspace` (каталог, документы, правки модели, сохранение с `If-Match`) и `useRun` (задание, опрос, сводка). Компоненты — холст React Flow без правки структуры, инспектор из описаний каталога, панели. Старый интерфейс и его E2E удаляются; после этого плана ручки MVP на сервере не используются и уходят в плане 4.

**Tech Stack:** React 19.3.1, `@xyflow/react` 12.12.0, Vite 8.3.5, TypeScript 6 (`tsc -b`), Vitest 5 + Testing Library, Playwright 1.64.1, openapi-typescript 7.13.0.

---

## Источники

- Дизайн этапа 1: `docs/superpowers/specs/2026-10-27-stage-1-design.md` — §6 (UI), §7.1 (срез).
- Продуктовое видение: `docs/product/2026-10-27-product-vision.md`, §5.5 (интерфейс: draw.io, светлая тема).
- ADR 0004 (холст React Flow), ADR 0010 (контракт API) — `docs/architecture/adr/`.
- План 2 — `docs/superpowers/plans/2026-10-27-stage-1-slice-server-cli.md`: ручки, `apps/server/openapi.json`, правила JSON (все поля присутствуют, отсутствующее значение — `null`).

## Предусловие

Планы 1 и 2 выполнены и смержены в `main`: есть `apps/server/openapi.json`, ручки `/api/v1/catalog`, `/workspace/...`, `/jobs`, `/runs`, пример `examples/retry-storm/`.

## Проверено пробой (2026-10-27)

На копии `web/` с текущим `package-lock.json`:

- `npm install -D openapi-typescript@7.13.0` падает с `ERESOLVE`: генератор требует `typescript ^5.x`, а в проекте `typescript` — псевдоним `@typescript/typescript6@6.0.2`. С `"overrides": { "openapi-typescript": { "typescript": "$typescript" } }` установка проходит, генератор использует TypeScript проекта.
- По схеме в стиле springdoc (OpenAPI 3.1, `type: ["string", "null"]`, `additionalProperties: true`, `$ref`, enum) генератор даёт ожидаемые типы: необязательные поля `?: T | null`, параметры `{ [key: string]: unknown }`; `tsc -b` и ESLint проекта проходят; флаг `--check` сверяет файл с схемой.

## Правила для кода web

- Типы API берутся только из `src/api/schema.d.ts` через псевдонимы в `src/api/apiTypes.ts`; руками типы API не пишутся.
- Сервер пишет отсутствующее значение как `null`, а сгенерированный тип для полей-ссылок может быть просто необязательным. Проверять отсутствие через `== null` или `??`, а не через `=== undefined`.
- Если `tsc` требует в тестовой фикстуре поле, которого в плане нет, значит, схема отличается от ожиданий плана: дополнить фикстуру по сгенерированному типу.
- Поля `JsonElement` в API описаны схемой «любой JSON» (план сервера), поэтому `ParamDescriptor["default"]` и значения `overrides` — объединение JSON-типов, а не `unknown`.
- Состояние не теряет правки и не смешивает документы: переключение эксперимента ждёт загрузки, сохранения и запуска и спрашивает перед отбрасыванием несохранённых правок; сохранение и запуск ждут исправления ошибочных черновиков; итог сохранения применяется только к тому открытию документа, для которого оно отправлено; результаты показываются только для эксперимента, для которого посчитаны.

## Границы плана

- **Входит:** каркас (верхняя панель, палитра со списком типов каталога, холст, страницы вариантов, инспектор, панель результатов со вкладкой Summary), сохранение модели, перечитывание при конфликте версий, запуск и опрос задания, сводка, светлая тема, E2E на копии рабочей области, удаление интерфейса MVP.
- **Не входит (дорожка T3):** перетаскивание из палитры, правка структуры и раскладки на холсте, undo/redo, правка переопределений на страницах вариантов, правка параметров прогона и отказов, диагностика `POST /validate` на схеме и вкладка Problems, отслеживание внешних правок.
- **Не входит (дорожка T4):** Timeline, результаты на схеме, воспроизведение, вывод, Map.
- **Пропадает до дорожек:** sweep, графики, импорт и экспорт JSON, скачивание результата (дизайн этапа 1, §7.1).
- **Страница варианта редактируема,** если у варианта нет переопределений (это сама модель); остальные страницы только для просмотра, переопределённые значения отмечены.

## Карта файлов

| Файл | Ответственность |
|---|---|
| `apps/server/build.gradle.kts` | Задача `bootRunE2e`: сервер на свежей копии `examples/` |
| `web/playwright.config.ts` | Запуск `bootRunE2e` |
| `web/package.json`, `web/package-lock.json` | openapi-typescript, `overrides`, скрипты `api:types` и `api:check` |
| `.github/workflows/ci.yml` | Шаг проверки сгенерированных типов |
| `web/src/api/schema.d.ts` | Сгенерированные типы |
| `web/src/api/apiTypes.ts`, `apiClient.ts` | Псевдонимы типов и клиент API |
| `web/src/workspace/paths.ts`, `quantities.ts`, `params.ts` | Ссылки между документами, величины, параметры и переопределения |
| `web/src/workspace/useWorkspace.ts` | Каталог, документы, правки, сохранение |
| `web/src/run/useRun.ts` | Задание, опрос, сводка |
| `web/src/canvas/Canvas.tsx`, `BlockNode.tsx`, `VariantTabs.tsx` | Холст и страницы вариантов |
| `web/src/inspector/Inspector.tsx`, `ParamField.tsx` | Инспектор из каталога |
| `web/src/layout/TopBar.tsx`, `Palette.tsx`, `ResultsPanel.tsx`, `SummaryTable.tsx`, `ProblemList.tsx` | Панели каркаса |
| `web/src/components/useHealth.ts` | Состояние backend |
| `web/src/App.tsx`, `web/src/styles.css` | Каркас и светлая тема |
| `web/src/test/fixtures.ts`, `stubFetch.ts`, `reactFlow.ts` | Тестовые данные и заглушки |
| `web/e2e/workspace.spec.ts` | Сквозной сценарий среза |

Все команды web выполняются из каталога `web`.

---

### Task 1: Сервер для E2E на копии рабочей области

Сохранение из UI меняет документы рабочей области. Чтобы E2E не трогали `examples/` в репозитории, Playwright запускает сервер на свежей копии.

**Files:**
- Modify: `apps/server/build.gradle.kts`, `web/playwright.config.ts`

- [ ] **Step 1: Задача Gradle**

В конец `apps/server/build.gradle.kts` добавить:

```kotlin
val e2eWorkspace = layout.buildDirectory.dir("e2e-workspace")

val prepareE2eWorkspace =
    tasks.register<Sync>("prepareE2eWorkspace") {
        description = "Copies examples/ into a scratch workspace for browser tests."
        from(rootProject.file("examples")) { exclude("**/.results/**") }
        into(e2eWorkspace)
        outputs.upToDateWhen { false }
    }

tasks.register<org.springframework.boot.gradle.tasks.run.BootRun>("bootRunE2e") {
    description = "Runs the server on a fresh copy of examples/, so browser tests never change the repository."
    group = "application"
    dependsOn(prepareE2eWorkspace)
    mainClass.set(application.mainClass)
    classpath = sourceSets["main"].runtimeClasspath
    workingDir = rootProject.projectDir
    systemProperty("resilience-lab.workspace", e2eWorkspace.get().asFile.absolutePath)
}
```

`Sync` при каждом запуске возвращает копию к содержимому `examples/` и удаляет лишнее, включая `.results/` прошлых прогонов. Без `upToDateWhen { false }` Gradle считает задачу актуальной, если в копию только добавились файлы, и оставляет их.

- [ ] **Step 2: Playwright**

В `web/playwright.config.ts` в первом `webServer` заменить команды:

```ts
      command: process.platform === "win32"
        ? "gradlew.bat :apps:server:bootRunE2e"
        : "./gradlew :apps:server:bootRunE2e",
```

- [ ] **Step 3: Проверка**

Run (из корня): `./gradlew :apps:server:prepareE2eWorkspace && ls apps/server/build/e2e-workspace/retry-storm`
Expected: три файла `retry-storm.{model,layout,experiment}.json`.

Run (из `web`): `npm run test:e2e`
Expected: PASS — старые E2E работают на ручках MVP, сервер стартует из новой задачи.

- [ ] **Step 4: Commit**

```bash
./gradlew :apps:server:ktlintFormat
git add apps/server/build.gradle.kts web/playwright.config.ts
git commit -m "test(e2e): run the server on a scratch copy of examples"
```

---

### Task 2: Генерация типов API

**Files:**
- Modify: `web/package.json`, `web/package-lock.json`, `.github/workflows/ci.yml`
- Create: `web/src/api/schema.d.ts` (генерируется)

- [ ] **Step 1: Зависимость и скрипты**

В `web/package.json`:

- в `devDependencies` добавить `"openapi-typescript": "7.13.0"` (по алфавиту, после `"jsdom"`);
- в `scripts` добавить:

```json
    "api:types": "openapi-typescript ../apps/server/openapi.json -o src/api/schema.d.ts",
    "api:check": "openapi-typescript ../apps/server/openapi.json -o src/api/schema.d.ts --check",
```

- после `devDependencies` добавить:

```json
  "overrides": {
    "openapi-typescript": {
      "typescript": "$typescript"
    }
  }
```

Сначала правится `package.json`, потом выполняется установка: без `overrides` npm падает с `ERESOLVE`.

Run: `npm install`
Expected: установка без ошибок; `npm ls openapi-typescript` показывает `openapi-typescript@7.13.0` с `typescript@npm:@typescript/typescript6@6.0.2 deduped`.

- [ ] **Step 2: Сгенерировать типы**

Run: `npm run api:types && npm run api:check`
Expected: появился `src/api/schema.d.ts`; проверка проходит. В файле есть `components["schemas"]` с `Catalog`, `ParamDescriptor`, `ModelFile`, `DocumentView`, `JobView`, `RunSummary`, `ApiProblem`.

- [ ] **Step 3: CI**

В `.github/workflows/ci.yml` в job `build` после шага «Lint frontend» добавить:

```yaml
      - name: Check generated API types
        working-directory: web
        run: npm run api:check
```

- [ ] **Step 4: Проверка**

Run: `npm run lint && npm run build`
Expected: PASS — сгенерированный файл проходит ESLint и `tsc -b`.

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/package-lock.json web/src/api/schema.d.ts .github/workflows/ci.yml
git commit -m "build(web): generate API types from the OpenAPI document"
```

---

### Task 3: Клиент API

**Files:**
- Create: `web/src/api/apiTypes.ts`, `web/src/api/apiClient.ts`, `web/src/test/stubFetch.ts`
- Test: `web/src/api/apiClient.test.ts`

- [ ] **Step 1: Заглушка `fetch` для тестов — `src/test/stubFetch.ts`**

```ts
import { vi } from "vitest";

export interface StubResponse {
  status?: number;
  body?: unknown;
}

/** Replaces `fetch` with [handler]; returns the mock to inspect calls. An async handler delays the response. */
export function stubFetch(handler: (url: string, init: RequestInit | undefined) => StubResponse | Promise<StubResponse>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status = 200, body } = await handler(String(input), init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === undefined) throw new SyntaxError("Unexpected end of JSON input");
        return body;
      },
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
```

- [ ] **Step 2: Написать падающий тест — `src/api/apiClient.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubFetch } from "../test/stubFetch";
import { ApiError, api } from "./apiClient";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API client", () => {
  it("reads documents by encoded path", async () => {
    const fetchMock = stubFetch(() => ({ body: { path: "a/b.model.json" } }));

    await api.document("a/b.model.json");

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/workspace/document?path=a%2Fb.model.json", undefined);
  });

  it("saves a document with its version in If-Match", async () => {
    const fetchMock = stubFetch(() => ({ body: { path: "m.model.json", kind: "MODEL", version: "v2" } }));

    await api.saveDocument("m.model.json", { model: { schemaVersion: 1, blocks: {}, connections: [] } }, "v1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/workspace/document?path=m.model.json");
    expect(init?.method).toBe("PUT");
    expect((init?.headers as Record<string, string>)["If-Match"]).toBe('"v1"');
    expect(JSON.parse(String(init?.body))).toEqual({ model: { schemaVersion: 1, blocks: {}, connections: [] } });
  });

  it("creates a document without If-Match", async () => {
    const fetchMock = stubFetch(() => ({ body: {} }));

    await api.saveDocument("new.layout.json", { layout: { schemaVersion: 1, positions: {} } }, null);

    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>)["If-Match"]).toBeUndefined();
  });

  it("submits jobs and reads runs", async () => {
    const fetchMock = stubFetch(() => ({ body: {} }));

    await api.submitJob("e.experiment.json");
    await api.job("job 1");
    await api.runSummary("run-1");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/jobs",
      "/api/v1/jobs/job%201",
      "/api/v1/runs/run-1/summary",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ experiment: "e.experiment.json" });
  });

  it("turns error bodies into ApiError", async () => {
    stubFetch(() => ({ status: 409, body: { code: "VERSION_CONFLICT", message: "stale", diagnostics: [] } }));

    const error = await api.catalog().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).problem.code).toBe("VERSION_CONFLICT");
  });

  it("keeps the status when an error has no JSON body", async () => {
    stubFetch(() => ({ status: 502 }));

    const error = (await api.health().catch((reason: unknown) => reason)) as ApiError;

    expect(error.problem).toEqual({ code: "HTTP_502", message: "Request failed with status 502", diagnostics: [] });
  });
});
```

- [ ] **Step 3: Тест падает**

Run: `npm test -- --run src/api/apiClient.test.ts`
Expected: FAIL — нет модуля `./apiClient`.

- [ ] **Step 4: Реализация**

`src/api/apiTypes.ts`:

```ts
import type { components } from "./schema";

type Schemas = components["schemas"];

export type ApiProblem = Schemas["ApiProblem"];
export type BlockInstance = Schemas["BlockInstance"];
export type Catalog = Schemas["Catalog"];
export type ConnectionInstance = Schemas["ConnectionInstance"];
export type Diagnostic = Schemas["Diagnostic"];
export type DocumentContent = Schemas["DocumentContent"];
export type DocumentEntry = Schemas["DocumentEntry"];
export type DocumentView = Schemas["DocumentView"];
export type ExperimentFile = Schemas["ExperimentFile"];
export type HealthView = Schemas["HealthView"];
export type JobView = Schemas["JobView"];
export type LayoutFile = Schemas["LayoutFile"];
export type MetricSummary = Schemas["MetricSummary"];
export type ModelFile = Schemas["ModelFile"];
export type ParamDescriptor = Schemas["ParamDescriptor"];
export type RunSummary = Schemas["RunSummary"];
export type TypeDescriptor = Schemas["TypeDescriptor"];
export type Variant = Schemas["Variant"];
```

`src/api/apiClient.ts`:

```ts
import type {
  ApiProblem,
  Catalog,
  DocumentContent,
  DocumentEntry,
  DocumentView,
  HealthView,
  JobView,
  RunSummary,
} from "./apiTypes";

/** A failed API call with the server's problem body, or a generic one when the body is not JSON. */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: ApiProblem;

  constructor(status: number, problem: ApiProblem) {
    super(problem.message);
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw new ApiError(response.status, await problemOf(response));
  }
  return (await response.json()) as T;
}

async function problemOf(response: Response): Promise<ApiProblem> {
  try {
    return (await response.json()) as ApiProblem;
  } catch {
    return { code: `HTTP_${response.status}`, message: `Request failed with status ${response.status}`, diagnostics: [] };
  }
}

function json(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) };
}

const documentUrl = (path: string) => `/api/v1/workspace/document?path=${encodeURIComponent(path)}`;

/** Stage 1 API (ADR 0010); paths and types come from `apps/server/openapi.json`. */
export const api = {
  health: () => request<HealthView>("/api/v1/health"),
  catalog: () => request<Catalog>("/api/v1/catalog"),
  documents: () => request<DocumentEntry[]>("/api/v1/workspace/documents"),
  document: (path: string) => request<DocumentView>(documentUrl(path)),
  /** Writes a document; [version] is the one it was read with, or null for a new document. */
  saveDocument: (path: string, content: DocumentContent, version: string | null) =>
    request<DocumentEntry>(documentUrl(path), json("PUT", content, version === null ? {} : { "If-Match": `"${version}"` })),
  submitJob: (experiment: string) => request<JobView>("/api/v1/jobs", json("POST", { experiment })),
  job: (id: string) => request<JobView>(`/api/v1/jobs/${encodeURIComponent(id)}`),
  runSummary: (runId: string) => request<RunSummary>(`/api/v1/runs/${encodeURIComponent(runId)}/summary`),
};
```

- [ ] **Step 5: Тест проходит**

Run: `npm test -- --run src/api/apiClient.test.ts && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/api/apiTypes.ts web/src/api/apiClient.ts web/src/api/apiClient.test.ts web/src/test/stubFetch.ts
git commit -m "feat(web): add typed client for the stage 1 API"
```

---

### Task 4: Ссылки, величины и параметры

**Files:**
- Create: `web/src/workspace/paths.ts`, `quantities.ts`, `params.ts`, `web/src/test/fixtures.ts`
- Test: `web/src/workspace/paths.test.ts`, `quantities.test.ts`, `params.test.ts`

- [ ] **Step 1: Фикстуры — `src/test/fixtures.ts`**

Каталог повторяет `Stage1Catalog` ядра в части, нужной тестам; модель, раскладка и эксперимент — пример `examples/retry-storm/`.

```ts
import type {
  Catalog,
  DocumentView,
  ExperimentFile,
  LayoutFile,
  ModelFile,
  ParamDescriptor,
  RunSummary,
} from "../api/apiTypes";

/** Units the server catalog lists for each dimension. */
const unitsOf: Record<string, string[]> = { DURATION: ["ms", "s", "min"], RATE: ["/ms", "/s", "/min"], PROBABILITY: ["%"] };

function param(partial: Partial<ParamDescriptor> & Pick<ParamDescriptor, "name" | "kind" | "title">): ParamDescriptor {
  const units = partial.dimension == null ? [] : unitsOf[partial.dimension];
  return { description: "", required: false, options: [], fields: [], sweepable: false, units, ...partial };
}

function distribution(name: string, title: string, fallback?: ParamDescriptor["default"]): ParamDescriptor {
  return param({
    name,
    kind: "OBJECT",
    title,
    required: fallback === undefined,
    default: fallback,
    fields: [
      param({ name: "kind", kind: "CHOICE", title: "Distribution", required: true, options: ["fixed", "exponential", "lognormal"] }),
      param({ name: "mean", kind: "QUANTITY", title: "Mean", required: true, dimension: "DURATION" }),
      param({ name: "stdDev", kind: "QUANTITY", title: "Standard deviation", dimension: "DURATION" }),
    ],
  });
}

export const catalog: Catalog = {
  schemaVersion: 1,
  types: [
    {
      id: "client",
      version: 1,
      category: "BLOCK",
      title: "Client",
      description: "Open Poisson stream of original requests with an end-to-end deadline.",
      ports: [{ id: "out", direction: "OUT" }],
      params: [
        param({ name: "rate", kind: "QUANTITY", title: "Arrival rate", required: true, dimension: "RATE" }),
        param({ name: "deadline", kind: "QUANTITY", title: "Deadline", required: true, dimension: "DURATION" }),
      ],
    },
    {
      id: "service",
      version: 1,
      category: "BLOCK",
      title: "Service",
      description: "Blocking service.",
      ports: [
        { id: "in", direction: "IN" },
        { id: "out", direction: "OUT" },
      ],
      params: [
        param({ name: "handlers", kind: "INTEGER", title: "Handlers", required: true, minimum: 1 }),
        param({ name: "queue", kind: "INTEGER", title: "Queue capacity", default: 0, minimum: 0 }),
        distribution("processing", "Processing time"),
        param({ name: "failureRate", kind: "QUANTITY", title: "Failure rate", default: "0%", dimension: "PROBABILITY" }),
      ],
    },
    {
      id: "request",
      version: 1,
      category: "CONNECTION",
      title: "Request",
      description: "Delivers original requests to the entry service.",
      ports: [],
      connects: { fromType: "client", toType: "service" },
      params: [],
    },
    {
      id: "call",
      version: 1,
      category: "CONNECTION",
      title: "Call",
      description: "Synchronous call with timeout, retries and backoff.",
      ports: [],
      connects: { fromType: "service", toType: "service" },
      params: [
        distribution("network", "Network delay", { kind: "fixed", mean: "0ms" }),
        param({ name: "timeout", kind: "QUANTITY", title: "Timeout", required: true, dimension: "DURATION" }),
        param({ name: "attempts", kind: "INTEGER", title: "Attempts", default: 1, minimum: 1 }),
        param({
          name: "backoff",
          kind: "OBJECT",
          title: "Backoff",
          default: { kind: "none" },
          fields: [
            param({ name: "kind", kind: "CHOICE", title: "Kind", required: true, options: ["none", "fixed", "exponential-full-jitter"] }),
            param({ name: "base", kind: "QUANTITY", title: "Base delay", default: "0ms", dimension: "DURATION" }),
            param({ name: "max", kind: "QUANTITY", title: "Maximum delay", default: "0ms", dimension: "DURATION" }),
            param({ name: "multiplier", kind: "NUMBER", title: "Multiplier", default: 2 }),
          ],
        }),
      ],
    },
  ],
};

const backoff = { base: "2ms", kind: "exponential-full-jitter", max: "20ms", multiplier: 2 };
const service = (handlers: number, queue: number, mean: string) => ({
  type: "service",
  params: { handlers, processing: { kind: "fixed", mean }, queue },
});

export const model: ModelFile = {
  schemaVersion: 1,
  blocks: {
    client: { type: "client", params: { deadline: "250ms", rate: "120/s" } },
    dependency: service(2, 8, "8ms"),
    gateway: service(4, 16, "1ms"),
    middle: service(4, 12, "2ms"),
  },
  connections: [
    { id: "client-to-gateway", type: "request", from: "client", to: "gateway", params: {} },
    {
      id: "gateway-to-middle",
      type: "call",
      from: "gateway",
      to: "middle",
      params: { attempts: 3, backoff, network: { kind: "fixed", mean: "0.5ms" }, timeout: "80ms" },
    },
    {
      id: "middle-to-dependency",
      type: "call",
      from: "middle",
      to: "dependency",
      params: { attempts: 3, backoff, network: { kind: "fixed", mean: "0.5ms" }, timeout: "60ms" },
    },
  ],
};

export const layout: LayoutFile = {
  schemaVersion: 1,
  positions: {
    client: { x: 0, y: 100 },
    dependency: { x: 780, y: 100 },
    gateway: { x: 260, y: 100 },
    middle: { x: 520, y: 100 },
  },
};

export const experimentPath = "retry-storm/retry-storm.experiment.json";
export const modelPath = "retry-storm/retry-storm.model.json";
export const layoutPath = "retry-storm/retry-storm.layout.json";

export const experiment: ExperimentFile = {
  schemaVersion: 1,
  modelRef: "retry-storm.model.json",
  layoutRef: "retry-storm.layout.json",
  execution: { replications: 2, warmup: "0ms", measurement: "1s", seed: 20261025, maxRealTime: "30s" },
  faults: [{ target: "dependency", from: "200ms", to: "700ms", processingMultiplier: 6, failureRate: "5%" }],
  variants: [
    { id: "baseline", label: "Baseline", overrides: {} },
    { id: "no-retries", label: "No retries", overrides: { "gateway-to-middle.attempts": 1, "middle-to-dependency.attempts": 1 } },
  ],
};

/** Server views of the example documents by path. */
export const documentViews: Record<string, DocumentView> = {
  [experimentPath]: { path: experimentPath, kind: "EXPERIMENT", version: "v-experiment", content: { experiment } },
  [modelPath]: { path: modelPath, kind: "MODEL", version: "v-model", content: { model } },
  [layoutPath]: { path: layoutPath, kind: "LAYOUT", version: "v-layout", content: { layout } },
};

export const summary: RunSummary = {
  schemaVersion: 1,
  experiment: experimentPath,
  variants: [
    {
      id: "baseline",
      label: "Baseline",
      replications: 2,
      aggregate: {
        pooledLatency: {},
        successRate: { mean: 0.975, stdDev: 0.01, ci95Low: 0.95, ci95High: 1, min: 0.97, max: 0.98 },
        p95LatencyMs: { mean: 41.25, min: 40, max: 42.5 },
        p99LatencyMs: { mean: 80, min: 79, max: 81 },
        services: { gateway: { admittedAmplification: { mean: 1.2, min: 1.1, max: 1.3 } } },
      },
    },
    {
      id: "no-retries",
      label: "No retries",
      replications: 2,
      aggregate: { pooledLatency: {}, services: {} },
    },
  ],
};
```

- [ ] **Step 2: Написать падающие тесты**

`src/workspace/paths.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveRef } from "./paths";

describe("resolveRef", () => {
  it("resolves references against the document directory", () => {
    expect(resolveRef("a/b.experiment.json", "m.model.json")).toBe("a/m.model.json");
    expect(resolveRef("a/b.experiment.json", "../m.model.json")).toBe("m.model.json");
    expect(resolveRef("b.experiment.json", "./x/m.model.json")).toBe("x/m.model.json");
  });

  it("rejects references that leave the workspace or are not relative", () => {
    expect(resolveRef("b.experiment.json", "../m.model.json")).toBeNull();
    expect(resolveRef("b.experiment.json", "/m.model.json")).toBeNull();
    expect(resolveRef("b.experiment.json", "https://x/m.model.json")).toBeNull();
  });
});
```

`src/workspace/quantities.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isQuantity } from "./quantities";

const duration = ["ms", "s", "min"];
const rate = ["/ms", "/s", "/min"];
const probability = ["%"];

describe("isQuantity", () => {
  it("accepts the listed units", () => {
    expect(isQuantity("250ms", duration)).toBe(true);
    expect(isQuantity("1.5min", duration)).toBe(true);
    expect(isQuantity("120/s", rate)).toBe(true);
    expect(isQuantity("0.5%", probability)).toBe(true);
  });

  it("rejects missing, foreign and malformed units", () => {
    for (const text of ["250", "250 ms", "-1ms", "1h", "1e999ms", "1.ms"]) {
      expect(isQuantity(text, duration)).toBe(false);
    }
    expect(isQuantity("120/s", duration)).toBe(false);
    expect(isQuantity("5ms", probability)).toBe(false);
  });
});
```

`src/workspace/params.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { catalog, model } from "../test/fixtures";
import { applyOverrides, elementOf, isOverridden, withParam } from "./params";

describe("withParam", () => {
  it("sets and removes parameters of blocks and connections without changing the source", () => {
    const changed = withParam(model, "gateway", "handlers", 6);
    expect(changed.blocks.gateway.params.handlers).toBe(6);
    expect(model.blocks.gateway.params.handlers).toBe(4);

    expect("queue" in withParam(model, "gateway", "queue", undefined).blocks.gateway.params).toBe(false);
    expect(elementOf(withParam(model, "gateway-to-middle", "attempts", 1), "gateway-to-middle")?.params.attempts).toBe(1);
    expect(elementOf(model, "missing")).toBeNull();
  });
});

describe("applyOverrides", () => {
  it("applies top-level and nested overrides; a missing object starts from its catalog default", () => {
    const withoutNetwork = withParam(model, "middle-to-dependency", "network", undefined);

    const effective = applyOverrides(
      withoutNetwork,
      { "gateway-to-middle.attempts": 1, "middle-to-dependency.network.mean": "3ms", "unknown.attempts": 1 },
      catalog,
    );

    expect(elementOf(effective, "gateway-to-middle")?.params.attempts).toBe(1);
    expect(elementOf(effective, "middle-to-dependency")?.params.network).toEqual({ kind: "fixed", mean: "3ms" });
    expect(applyOverrides(model, {}, catalog)).toBe(model);
  });
});

describe("isOverridden", () => {
  it("marks an overridden parameter, the object that holds it and its fields", () => {
    const overrides = { "gateway-to-middle.backoff.base": "5ms", "gateway-to-middle.attempts": 1 };

    expect(isOverridden(overrides, "gateway-to-middle", "attempts")).toBe(true);
    expect(isOverridden(overrides, "gateway-to-middle", "backoff")).toBe(true);
    expect(isOverridden(overrides, "gateway-to-middle", "backoff.base")).toBe(true);
    expect(isOverridden(overrides, "gateway-to-middle", "backoff.max")).toBe(false);
    expect(isOverridden(overrides, "middle-to-dependency", "attempts")).toBe(false);
  });
});
```

- [ ] **Step 3: Тесты падают**

Run: `npm test -- --run src/workspace`
Expected: FAIL — нет модулей `./paths`, `./quantities`, `./params`.

- [ ] **Step 4: Реализация**

`src/workspace/paths.ts`:

```ts
/** Resolves [ref] against the directory of [documentPath] like the core `Lab.resolveRef`; null when it leaves the workspace. */
export function resolveRef(documentPath: string, ref: string): string | null {
  if (ref.startsWith("/") || ref.includes("\\") || ref.includes("://")) return null;
  const slash = documentPath.lastIndexOf("/");
  const base = slash < 0 ? "" : documentPath.slice(0, slash);
  const segments: string[] = [];
  for (const segment of (base === "" ? ref : `${base}/${ref}`).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.length === 0 ? null : segments.join("/");
}
```

`src/workspace/quantities.ts`:

```ts
const pattern = /^([0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)(.+)$/;

/**
 * True when [text] is a finite non-negative number followed by one of [units], such as `250ms` or `120/s`. The units
 * come from the catalog descriptor of the parameter (ADR 0001), the same list the core parser accepts.
 */
export function isQuantity(text: string, units: readonly string[]): boolean {
  const match = pattern.exec(text);
  return match !== null && units.includes(match[2]) && Number.isFinite(Number(match[1]));
}
```

`src/workspace/params.ts`:

```ts
import type { Catalog, ModelFile } from "../api/apiTypes";

export type Params = Record<string, unknown>;

export function isObject(value: unknown): value is Params {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Type and parameters of block or connection [id]; null when the model has no such element. */
export function elementOf(model: ModelFile, id: string): { type: string; params: Params } | null {
  const block = model.blocks[id];
  if (block !== undefined) return { type: block.type, params: block.params };
  const connection = model.connections.find((candidate) => candidate.id === id);
  return connection === undefined ? null : { type: connection.type, params: connection.params };
}

/** Copy of [model] with parameter [name] of element [id] set to [value]; undefined removes it so its default applies. */
export function withParam(model: ModelFile, id: string, name: string, value: unknown): ModelFile {
  const update = (params: Params): Params => {
    const next = { ...params };
    if (value === undefined) delete next[name];
    else next[name] = value;
    return next;
  };
  const block = model.blocks[id];
  if (block !== undefined) {
    return { ...model, blocks: { ...model.blocks, [id]: { ...block, params: update(block.params) } } };
  }
  return {
    ...model,
    connections: model.connections.map((connection) =>
      connection.id === id ? { ...connection, params: update(connection.params) } : connection,
    ),
  };
}

/**
 * The model as a variant sees it (ADR 0002): overrides are `id.param[.field]` paths, and a missing object starts from
 * its catalog default, as in the core compiler.
 */
export function applyOverrides(model: ModelFile, overrides: Params, catalog: Catalog): ModelFile {
  let result = model;
  for (const [key, value] of Object.entries(overrides)) {
    const [id, name, ...fields] = key.split(".");
    const element = elementOf(result, id);
    const descriptor = catalog.types
      .find((type) => type.id === element?.type)
      ?.params.find((param) => param.name === name);
    if (element === null || descriptor === undefined) continue;
    const next = fields.length === 0 ? value : setField(objectOr(element.params[name], descriptor.default), fields, value);
    result = withParam(result, id, name, next);
  }
  return result;
}

/** True when the variant overrides [path] of element [id], the object holding it, or a field inside it. */
export function isOverridden(overrides: Params, id: string, path: string): boolean {
  const prefix = `${id}.`;
  return Object.keys(overrides)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .some((overridden) => overridden === path || overridden.startsWith(`${path}.`) || path.startsWith(`${overridden}.`));
}

function setField(target: Params, path: string[], value: unknown): Params {
  const [head, ...rest] = path;
  return { ...target, [head]: rest.length === 0 ? value : setField(objectOr(target[head], undefined), rest, value) };
}

function objectOr(value: unknown, fallback: unknown): Params {
  if (isObject(value)) return value;
  return isObject(fallback) ? fallback : {};
}
```

- [ ] **Step 5: Тесты проходят**

Run: `npm test -- --run src/workspace && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/workspace web/src/test/fixtures.ts
git commit -m "feat(web): resolve references, check quantities and apply variant overrides"
```

---

### Task 5: Состояние рабочей области

**Files:**
- Create: `web/src/workspace/useWorkspace.ts`
- Test: `web/src/workspace/useWorkspace.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalog, documentViews, experimentPath, modelPath } from "../test/fixtures";
import { stubFetch } from "../test/stubFetch";
import { useWorkspace } from "./useWorkspace";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubWorkspace(options: { putStatus?: number; putGate?: Promise<void> } = {}) {
  return stubFetch(async (url, init) => {
    if (url === "/api/v1/catalog") return { body: catalog };
    if (url === "/api/v1/workspace/documents") {
      return { body: Object.values(documentViews).map(({ path, kind, version }) => ({ path, kind, version })) };
    }
    if (init?.method === "PUT") {
      await options.putGate;
      return options.putStatus === 409
        ? { status: 409, body: { code: "VERSION_CONFLICT", message: "stale", diagnostics: [] } }
        : { body: { path: modelPath, kind: "MODEL", version: "v-model-2" } };
    }
    const document = documentViews[decodeURIComponent(url.split("path=")[1] ?? "")];
    return document === undefined
      ? { status: 404, body: { code: "DOCUMENT_NOT_FOUND", message: "missing", diagnostics: [] } }
      : { body: document };
  });
}

async function loaded() {
  const hook = renderHook(() => useWorkspace());
  await waitFor(() => expect(hook.result.current.loaded).not.toBeNull());
  return hook;
}

describe("useWorkspace", () => {
  it("loads the catalog and opens the first experiment with its model and layout", async () => {
    stubWorkspace();

    const { result } = await loaded();

    expect(result.current.catalog).toEqual(catalog);
    expect(result.current.experiments).toEqual([experimentPath]);
    expect(result.current.loaded?.modelPath).toBe(modelPath);
    expect(result.current.loaded?.layout?.positions.gateway).toEqual({ x: 260, y: 100 });
    expect(result.current.dirty).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it("saves edits with If-Match and clears the unsaved state", async () => {
    const fetchMock = stubWorkspace();
    const { result } = await loaded();

    act(() => result.current.setParam("gateway", "handlers", 6));
    expect(result.current.dirty).toBe(true);
    await act(async () => {
      await result.current.save();
    });

    const [url, init] = fetchMock.mock.calls.find(([, call]) => call?.method === "PUT")!;
    expect(url).toBe(`/api/v1/workspace/document?path=${encodeURIComponent(modelPath)}`);
    expect((init?.headers as Record<string, string>)["If-Match"]).toBe('"v-model"');
    expect(JSON.parse(String(init?.body)).model.blocks.gateway.params.handlers).toBe(6);
    expect(result.current.dirty).toBe(false);
    expect(result.current.loaded?.modelVersion).toBe("v-model-2");
  });

  it("reports a version conflict and reloads the stored model", async () => {
    stubWorkspace({ putStatus: 409 });
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 6));

    await act(async () => {
      await result.current.save();
    });
    expect(result.current.conflict).toBe(true);
    expect(result.current.dirty).toBe(true);

    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.conflict).toBe(false);
    expect(result.current.dirty).toBe(false);
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(4);
  });

  it("reports documents that cannot be opened", async () => {
    stubWorkspace();
    const { result } = await loaded();

    await act(async () => {
      await result.current.open("missing.experiment.json");
    });

    expect(result.current.problem?.code).toBe("DOCUMENT_NOT_FOUND");
  });

  it("keeps unsaved edits unless opening discards them", async () => {
    stubWorkspace();
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 6));

    let opened = true;
    await act(async () => {
      opened = await result.current.open(experimentPath);
    });
    expect(opened).toBe(false);
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(6);

    await act(async () => {
      opened = await result.current.open(experimentPath, true);
    });
    expect(opened).toBe(true);
    expect(result.current.dirty).toBe(false);
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(4);
  });

  it("reports loading while an experiment opens", async () => {
    stubWorkspace();
    const { result } = await loaded();

    let opening: Promise<boolean> = Promise.resolve(false);
    act(() => {
      opening = result.current.open(experimentPath);
    });
    expect(result.current.loading).toBe(true);
    await act(async () => {
      await opening;
    });
    expect(result.current.loading).toBe(false);
  });

  it("does not open another experiment while saving", async () => {
    let release: () => void = () => {};
    const putGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubWorkspace({ putGate });
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 6));

    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = result.current.save();
    });
    expect(result.current.saving).toBe(true);
    let opened = true;
    await act(async () => {
      opened = await result.current.open(experimentPath, true);
    });
    expect(opened).toBe(false);

    release();
    await act(async () => {
      await saving;
    });
    expect(result.current.saving).toBe(false);
    expect(result.current.dirty).toBe(false);
  });
});
```

- [ ] **Step 2: Тест падает**

Run: `npm test -- --run src/workspace/useWorkspace.test.ts`
Expected: FAIL — нет модуля `./useWorkspace`.

- [ ] **Step 3: Реализация**

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api/apiClient";
import type { ApiProblem, Catalog, ExperimentFile, LayoutFile, ModelFile } from "../api/apiTypes";
import { withParam } from "./params";
import { resolveRef } from "./paths";

/** An experiment with its model and layout; [model] holds unsaved edits, [savedModel] what is stored. */
export interface LoadedExperiment {
  experimentPath: string;
  experiment: ExperimentFile;
  modelPath: string;
  model: ModelFile;
  savedModel: ModelFile;
  modelVersion: string;
  layout: LayoutFile | null;
}

export interface Workspace {
  catalog: Catalog | null;
  experiments: string[];
  loaded: LoadedExperiment | null;
  /** An experiment is being opened; editing, saving and running wait for it. */
  loading: boolean;
  dirty: boolean;
  saving: boolean;
  /** The stored model changed since it was read; only a reload continues. */
  conflict: boolean;
  problem: ApiProblem | null;
  /**
   * Opens [experimentPath] and resolves to true. Does nothing and resolves to false while saving, or while the model has
   * unsaved edits unless [discardChanges] is set.
   */
  open: (experimentPath: string, discardChanges?: boolean) => Promise<boolean>;
  setParam: (id: string, name: string, value: unknown) => void;
  save: () => Promise<void>;
  /** Rereads the open experiment from storage, discarding unsaved edits. */
  reload: () => Promise<void>;
}

export function problemOf(error: unknown): ApiProblem {
  if (error instanceof ApiError) return error.problem;
  return { code: "CLIENT_ERROR", message: error instanceof Error ? error.message : "Request failed", diagnostics: [] };
}

async function loadExperiment(experimentPath: string): Promise<LoadedExperiment> {
  const experiment = (await api.document(experimentPath)).content.experiment;
  if (experiment == null) throw new Error(`${experimentPath} is not an experiment`);
  const modelPath = resolveRef(experimentPath, experiment.modelRef);
  if (modelPath === null) throw new Error(`modelRef of ${experimentPath} leaves the workspace`);
  const modelView = await api.document(modelPath);
  const model = modelView.content.model;
  if (model == null) throw new Error(`${modelPath} is not a model`);
  const layoutPath = experiment.layoutRef == null ? null : resolveRef(experimentPath, experiment.layoutRef);
  const layoutView = layoutPath === null ? null : await api.document(layoutPath).catch(() => null);
  return {
    experimentPath,
    experiment,
    modelPath,
    model,
    savedModel: model,
    modelVersion: modelView.version,
    layout: layoutView?.content.layout ?? null,
  };
}

/** Catalog and documents of the workspace, edits of the model and saving with `If-Match` (stage 1 design §6.2). */
export function useWorkspace(): Workspace {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [experiments, setExperiments] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<LoadedExperiment | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  /** Increments on every open, so responses for an earlier document are ignored. */
  const generation = useRef(0);
  const dirty = loaded !== null && loaded.model !== loaded.savedModel;

  const load = useCallback(async (experimentPath: string) => {
    const current = ++generation.current;
    setLoading(true);
    setProblem(null);
    setConflict(false);
    try {
      const next = await loadExperiment(experimentPath);
      if (current === generation.current) setLoaded(next);
    } catch (error) {
      if (current === generation.current) setProblem(problemOf(error));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);

  const open = useCallback(
    async (experimentPath: string, discardChanges = false) => {
      if (saving || (dirty && !discardChanges)) return false;
      await load(experimentPath);
      return true;
    },
    [dirty, saving, load],
  );

  useEffect(() => {
    let active = true;
    void Promise.all([api.catalog(), api.documents()])
      .then(async ([nextCatalog, documents]) => {
        if (!active) return;
        const paths = documents
          .filter((document) => document.kind === "EXPERIMENT")
          .map((document) => document.path)
          .sort();
        setCatalog(nextCatalog);
        setExperiments(paths);
        if (paths.length > 0) await load(paths[0]);
      })
      .catch((error: unknown) => {
        if (active) setProblem(problemOf(error));
      });
    return () => {
      active = false;
    };
  }, [load]);

  const setParam = useCallback((id: string, name: string, value: unknown) => {
    setLoaded((current) => (current === null ? current : { ...current, model: withParam(current.model, id, name, value) }));
  }, []);

  /** Saves the model; the outcome applies only to the document generation it was sent for. */
  const save = useCallback(async () => {
    if (loaded === null || !dirty || loading) return;
    const saved = loaded;
    const current = generation.current;
    setSaving(true);
    setProblem(null);
    try {
      const entry = await api.saveDocument(saved.modelPath, { model: saved.model }, saved.modelVersion);
      if (current === generation.current) {
        setLoaded((now) => (now === null ? now : { ...now, savedModel: saved.model, modelVersion: entry.version }));
      }
    } catch (error) {
      if (current !== generation.current) return;
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      else setProblem(problemOf(error));
    } finally {
      setSaving(false);
    }
  }, [loaded, dirty, loading]);

  const reload = useCallback(async () => {
    if (loaded !== null && !saving) await load(loaded.experimentPath);
  }, [loaded, saving, load]);

  return {
    catalog,
    experiments,
    loaded,
    loading,
    dirty,
    saving,
    conflict,
    problem,
    open,
    setParam,
    save,
    reload,
  };
}
```

- [ ] **Step 4: Тест проходит**

Run: `npm test -- --run src/workspace/useWorkspace.test.ts && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/workspace/useWorkspace.ts web/src/workspace/useWorkspace.test.ts
git commit -m "feat(web): load workspace documents and save the model with If-Match"
```

---

### Task 6: Запуск и опрос задания

**Files:**
- Create: `web/src/run/useRun.ts`
- Test: `web/src/run/useRun.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobView } from "../api/apiTypes";
import { experimentPath, summary } from "../test/fixtures";
import { stubFetch } from "../test/stubFetch";
import { useRun } from "./useRun";

afterEach(() => {
  vi.unstubAllGlobals();
});

function job(status: JobView["status"], extra: Partial<JobView> = {}): JobView {
  return {
    id: "job-1",
    experiment: experimentPath,
    runId: "run-1",
    status,
    completedTasks: status === "COMPLETED" ? 4 : 0,
    totalTasks: 4,
    error: null,
    diagnostics: [],
    ...extra,
  };
}

async function run(pollMs = 1) {
  const hook = renderHook(() => useRun(pollMs));
  await act(async () => {
    await hook.result.current.run(experimentPath);
  });
  return hook.result;
}

describe("useRun", () => {
  it("submits a job, polls it to completion and loads the summary", async () => {
    const statuses: JobView["status"][] = ["RUNNING", "COMPLETED"];
    const fetchMock = stubFetch((url, init) => {
      if (url === "/api/v1/jobs" && init?.method === "POST") return { status: 202, body: job("QUEUED") };
      if (url === "/api/v1/jobs/job-1") return { body: job(statuses.shift() ?? "COMPLETED") };
      if (url === "/api/v1/runs/run-1/summary") return { body: summary };
      return { status: 404, body: { code: "NOT_FOUND", message: url, diagnostics: [] } };
    });

    const result = await run();

    expect(result.current.job?.status).toBe("COMPLETED");
    expect(result.current.summary).toEqual(summary);
    expect(result.current.experiment).toBe(experimentPath);
    expect(result.current.problem).toBeNull();
    expect(result.current.running).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/v1/jobs/job-1")).toHaveLength(2);
  });

  it("shows the diagnostics of a rejected experiment", async () => {
    const diagnostic = { code: "PARAM_MISSING", severity: "ERROR", message: "Required parameter 'handlers' is missing" };
    stubFetch(() => ({ status: 400, body: { code: "EXPERIMENT_INVALID", message: "Experiment has errors", diagnostics: [diagnostic] } }));

    const result = await run();

    expect(result.current.problem?.code).toBe("EXPERIMENT_INVALID");
    expect(result.current.problem?.diagnostics).toHaveLength(1);
    expect(result.current.running).toBe(false);
  });

  it("reports a failed job", async () => {
    stubFetch(() => ({ status: 202, body: job("FAILED", { error: "Experiment execution failed" }) }));

    const result = await run();

    expect(result.current.problem?.message).toBe("Experiment execution failed");
    expect(result.current.summary).toBeNull();
  });

  it("clears the state on reset", async () => {
    stubFetch(() => ({ status: 202, body: job("FAILED", { error: "boom" }) }));
    const result = await run();

    act(() => result.current.reset());

    expect(result.current.job).toBeNull();
    expect(result.current.problem).toBeNull();
    expect(result.current.experiment).toBeNull();
  });
});
```

- [ ] **Step 2: Тест падает**

Run: `npm test -- --run src/run/useRun.test.ts`
Expected: FAIL — нет модуля `./useRun`.

- [ ] **Step 3: Реализация**

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/apiClient";
import type { ApiProblem, JobView, RunSummary } from "../api/apiTypes";
import { problemOf } from "../workspace/useWorkspace";

export interface Run {
  /** The experiment the state below belongs to. */
  experiment: string | null;
  job: JobView | null;
  summary: RunSummary | null;
  problem: ApiProblem | null;
  running: boolean;
  run: (experimentPath: string) => Promise<void>;
  reset: () => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Submits a job, polls it every [pollMs] until it finishes and loads the run summary (ADR 0010, item 4). */
export function useRun(pollMs = 500): Run {
  const [experiment, setExperiment] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [running, setRunning] = useState(false);
  const generation = useRef(0);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const reset = useCallback(() => {
    generation.current += 1;
    setExperiment(null);
    setJob(null);
    setSummary(null);
    setProblem(null);
    setRunning(false);
  }, []);

  const run = useCallback(
    async (experimentPath: string) => {
      const current = ++generation.current;
      const live = () => current === generation.current;
      setExperiment(experimentPath);
      setJob(null);
      setSummary(null);
      setProblem(null);
      setRunning(true);
      try {
        let next = await api.submitJob(experimentPath);
        while (next.status === "QUEUED" || next.status === "RUNNING") {
          if (!live()) return;
          setJob(next);
          await sleep(pollMs);
          next = await api.job(next.id);
        }
        if (!live()) return;
        setJob(next);
        if (next.status === "COMPLETED") {
          const loaded = await api.runSummary(next.runId);
          if (live()) setSummary(loaded);
        } else {
          setProblem({ code: "JOB_FAILED", message: next.error ?? "Job failed", diagnostics: next.diagnostics });
        }
      } catch (error) {
        if (live()) setProblem(problemOf(error));
      } finally {
        if (live()) setRunning(false);
      }
    },
    [pollMs],
  );

  return { experiment, job, summary, problem, running, run, reset };
}
```

- [ ] **Step 4: Тест проходит**

Run: `npm test -- --run src/run/useRun.test.ts && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/run
git commit -m "feat(web): submit jobs, poll them and load run summaries"
```

---

### Task 7: Холст и страницы вариантов

**Files:**
- Create: `web/src/canvas/Canvas.tsx`, `BlockNode.tsx`, `VariantTabs.tsx`, `web/src/test/reactFlow.ts`
- Test: `web/src/canvas/Canvas.test.tsx`

- [ ] **Step 1: Заглушки DOM для React Flow — `src/test/reactFlow.ts`**

```ts
/** jsdom lacks layout; React Flow needs sizes, SVG text boxes, ResizeObserver and DOMMatrixReadOnly to render. */
export function mockReactFlowDom(): void {
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect,
  });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 180, height: 80, top: 0, left: 0, right: 180, bottom: 80, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 180 },
    offsetHeight: { configurable: true, get: () => 80 },
  });
  Object.defineProperty(window, "DOMMatrixReadOnly", {
    configurable: true,
    value: class DOMMatrixReadOnly {
      m22: number;

      constructor(transform: string) {
        this.m22 = Number(transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1);
      }
    },
  });
  globalThis.ResizeObserver = class ResizeObserver {
    private callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element) {
      queueMicrotask(() => {
        this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this);
      });
    }

    unobserve() {}

    disconnect() {}
  };
}
```

- [ ] **Step 2: Написать падающий тест — `src/canvas/Canvas.test.tsx`**

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { experiment, layout, model } from "../test/fixtures";
import { mockReactFlowDom } from "../test/reactFlow";
import { Canvas } from "./Canvas";
import { VariantTabs } from "./VariantTabs";

beforeAll(mockReactFlowDom);

describe("Canvas", () => {
  it("draws blocks with key parameters and reports the selection", async () => {
    const onSelect = vi.fn();
    render(<Canvas model={model} layout={layout} selected={null} onSelect={onSelect} />);

    expect(await screen.findAllByTestId("block-node")).toHaveLength(4);
    expect(screen.getByText("4 handlers · queue 16")).toBeTruthy();
    expect(screen.getByText("120/s · deadline 250ms")).toBeTruthy();

    fireEvent.click(screen.getByTestId("rf__node-gateway"));
    expect(onSelect).toHaveBeenCalledWith("gateway");
  });
});

describe("VariantTabs", () => {
  it("marks the active variant and switches pages", () => {
    const onSelect = vi.fn();
    render(<VariantTabs variants={experiment.variants} active="baseline" onSelect={onSelect} />);

    expect(screen.getByRole("tab", { name: "Baseline" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
    expect(onSelect).toHaveBeenCalledWith("no-retries");
  });
});
```

- [ ] **Step 3: Тест падает**

Run: `npm test -- --run src/canvas`
Expected: FAIL — нет модулей `./Canvas`, `./VariantTabs`.

- [ ] **Step 4: Реализация**

`src/canvas/BlockNode.tsx`:

```tsx
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import type { BlockInstance } from "../api/apiTypes";

export type BlockNodeType = Node<{ id: string; block: BlockInstance }, "block">;

function summaryOf(block: BlockInstance): string {
  const params = block.params;
  if (block.type === "client") return `${String(params.rate)} · deadline ${String(params.deadline)}`;
  if (block.type === "service") return `${String(params.handlers)} handlers · queue ${String(params.queue ?? 0)}`;
  return block.type;
}

/** A block of the model with its key parameters; ports follow the catalog (client has an output only). */
export function BlockNode({ data }: NodeProps<BlockNodeType>) {
  return (
    <div className={`block-node block-node--${data.block.type}`} data-testid="block-node">
      {data.block.type === "client" ? null : <Handle type="target" position={Position.Left} isConnectable={false} />}
      <strong>{data.id}</strong>
      <span>{summaryOf(data.block)}</span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
```

`src/canvas/Canvas.tsx`:

```tsx
import { Background, Controls, ReactFlow } from "@xyflow/react";
import type { Edge } from "@xyflow/react";
import type { ConnectionInstance, LayoutFile, ModelFile } from "../api/apiTypes";
import { BlockNode } from "./BlockNode";
import type { BlockNodeType } from "./BlockNode";
import "@xyflow/react/dist/style.css";

const nodeTypes = { block: BlockNode };

export interface CanvasProps {
  /** The model as the active variant page sees it. */
  model: ModelFile;
  layout: LayoutFile | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
}

function labelOf(connection: ConnectionInstance): string | undefined {
  if (connection.type !== "call") return undefined;
  return `${String(connection.params.timeout)} · ${String(connection.params.attempts ?? 1)}×`;
}

/** The model on a React Flow canvas (ADR 0004); structure is read-only in the stage 1 slice. */
export function Canvas({ model, layout, selected, onSelect }: CanvasProps) {
  const nodes: BlockNodeType[] = Object.entries(model.blocks).map(([id, block], index) => ({
    id,
    type: "block",
    position: layout?.positions[id] ?? { x: index * 260, y: 100 },
    data: { id, block },
    selected: selected === id,
    ariaLabel: id,
  }));
  const edges: Edge[] = model.connections.map((connection) => ({
    id: connection.id,
    source: connection.from,
    target: connection.to,
    label: labelOf(connection),
    selected: selected === connection.id,
    ariaLabel: connection.id,
  }));

  return (
    <ReactFlow
      aria-label="Model canvas"
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      nodesDraggable={false}
      nodesConnectable={false}
      onNodeClick={(_, node) => onSelect(node.id)}
      onEdgeClick={(_, edge) => onSelect(edge.id)}
      onPaneClick={() => onSelect(null)}
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
```

`src/canvas/VariantTabs.tsx`:

```tsx
import type { Variant } from "../api/apiTypes";

export interface VariantTabsProps {
  variants: Variant[];
  active: string;
  onSelect: (id: string) => void;
}

/** Variant pages below the canvas, as in draw.io (product vision §5.5). */
export function VariantTabs({ variants, active, onSelect }: VariantTabsProps) {
  return (
    <div className="variant-tabs" role="tablist" aria-label="Variants">
      {variants.map((variant) => (
        <button
          key={variant.id}
          type="button"
          role="tab"
          aria-selected={variant.id === active}
          onClick={() => onSelect(variant.id)}
        >
          {variant.label ?? variant.id}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Тест проходит**

Run: `npm test -- --run src/canvas && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/canvas web/src/test/reactFlow.ts
git commit -m "feat(web): show the model on the canvas with variant pages"
```

---

### Task 8: Инспектор из каталога

**Files:**
- Create: `web/src/inspector/Inspector.tsx`, `ParamField.tsx`
- Test: `web/src/inspector/Inspector.test.tsx`

- [ ] **Step 1: Написать падающий тест**

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { catalog, experiment, model } from "../test/fixtures";
import { applyOverrides } from "../workspace/params";
import { Inspector } from "./Inspector";
import type { InspectorProps } from "./Inspector";

function renderInspector(props: Partial<InspectorProps> = {}) {
  const onParam = vi.fn();
  render(
    <Inspector
      catalog={catalog}
      model={model}
      experiment={experiment}
      selected="gateway"
      editable
      overrides={{}}
      onParam={onParam}
      onValidity={vi.fn()}
      {...props}
    />,
  );
  return onParam;
}

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

function commit(label: string, value: string) {
  fireEvent.change(input(label), { target: { value } });
  fireEvent.blur(input(label));
}

describe("Inspector", () => {
  it("renders catalog fields with values and defaults and commits edits", () => {
    const onParam = renderInspector();

    expect(input("Handlers").value).toBe("4");
    expect(input("Failure rate").placeholder).toBe("0%");
    commit("Handlers", "6");

    expect(onParam).toHaveBeenCalledWith("gateway", "handlers", 6);
  });

  it("rejects invalid values and removes cleared optional ones", () => {
    const onParam = renderInspector();

    commit("Failure rate", "5 percent");
    expect(screen.getByRole("alert").textContent).toContain("%");
    commit("Handlers", "4.5");
    expect(onParam).not.toHaveBeenCalled();

    commit("Queue capacity", "");
    expect(onParam).toHaveBeenCalledWith("gateway", "queue", undefined);
  });

  it("reports invalid drafts so that saving and running can wait for them", () => {
    const onValidity = vi.fn();
    renderInspector({ onValidity });

    fireEvent.change(input("Handlers"), { target: { value: "4.5" } });
    expect(onValidity).toHaveBeenLastCalledWith("gateway.handlers", false);

    fireEvent.change(input("Handlers"), { target: { value: "5" } });
    expect(onValidity).toHaveBeenLastCalledWith("gateway.handlers", true);
  });

  it("edits a field of an object parameter as a whole object", () => {
    const onParam = renderInspector({ selected: "gateway-to-middle" });

    expect(input("Base delay").value).toBe("2ms");
    commit("Base delay", "4ms");

    expect(onParam).toHaveBeenCalledWith("gateway-to-middle", "backoff", {
      kind: "exponential-full-jitter",
      base: "4ms",
      max: "20ms",
      multiplier: 2,
    });
  });

  it("shows a variant page read-only with overridden values marked", () => {
    const overrides = { "gateway-to-middle.attempts": 1 };
    renderInspector({
      selected: "gateway-to-middle",
      editable: false,
      overrides,
      model: applyOverrides(model, overrides, catalog),
    });

    expect(input("Attempts").value).toBe("1");
    expect(input("Attempts").readOnly).toBe(true);
    expect(input("Attempts").closest(".param-field")?.textContent).toContain("overridden");
    expect((screen.getByLabelText("Kind") as HTMLSelectElement).disabled).toBe(true);
  });

  it("shows run settings and faults without a selection", () => {
    renderInspector({ selected: null });

    expect(screen.getByText("Replications").nextElementSibling?.textContent).toBe("2");
    expect(screen.getByText(/dependency: 200ms–700ms/).textContent).toContain("processing ×6");
  });
});
```

- [ ] **Step 2: Тест падает**

Run: `npm test -- --run src/inspector`
Expected: FAIL — нет модуля `./Inspector`.

- [ ] **Step 3: Реализация**

`src/inspector/ParamField.tsx`:

```tsx
import { useEffect, useId, useRef, useState } from "react";
import type { ParamDescriptor } from "../api/apiTypes";
import { isObject } from "../workspace/params";
import { isQuantity } from "../workspace/quantities";

export interface ParamFieldProps {
  descriptor: ParamDescriptor;
  /** Value written in the document; undefined when the default applies. */
  value: unknown;
  /** Dotted path from the element, used to mark overridden values. */
  path: string;
  editable: boolean;
  isOverridden: (path: string) => boolean;
  /** New value; undefined removes it from the document. */
  onCommit: (value: unknown) => void;
  /** Whether the draft at [path] is valid; an invalid draft is never committed. */
  onValidity: (path: string, valid: boolean) => void;
}

/** A form field built from a catalog parameter descriptor (ADR 0001). */
export function ParamField(props: ParamFieldProps) {
  return props.descriptor.kind === "OBJECT" ? <ObjectField {...props} /> : <ScalarField {...props} />;
}

function ObjectField({ descriptor, value, path, editable, isOverridden, onCommit, onValidity }: ParamFieldProps) {
  const current = isObject(value) ? value : isObject(descriptor.default) ? descriptor.default : {};
  return (
    <fieldset className={isOverridden(path) ? "param-group param-group--overridden" : "param-group"}>
      <legend title={descriptor.description}>{descriptor.title}</legend>
      {descriptor.fields.map((field) => (
        <ParamField
          key={field.name}
          descriptor={field}
          value={current[field.name]}
          path={`${path}.${field.name}`}
          editable={editable}
          isOverridden={isOverridden}
          onValidity={onValidity}
          onCommit={(next) => {
            const updated = { ...current };
            if (next === undefined) delete updated[field.name];
            else updated[field.name] = next;
            onCommit(updated);
          }}
        />
      ))}
    </fieldset>
  );
}

type Parsed = { ok: true; value: unknown } | { ok: false; message: string };

function parse(descriptor: ParamDescriptor, draft: string): Parsed {
  const text = draft.trim();
  if (text === "") return descriptor.required ? { ok: false, message: "Required" } : { ok: true, value: undefined };
  switch (descriptor.kind) {
    case "INTEGER":
      return Number.isSafeInteger(Number(text)) ? { ok: true, value: Number(text) } : { ok: false, message: "Enter a whole number" };
    case "NUMBER":
      return Number.isFinite(Number(text)) ? { ok: true, value: Number(text) } : { ok: false, message: "Enter a number" };
    case "QUANTITY":
      return descriptor.units.length === 0 || isQuantity(text, descriptor.units)
        ? { ok: true, value: text }
        : { ok: false, message: `Use a value with a unit: ${descriptor.units.join(", ")}` };
    default:
      return { ok: true, value: text };
  }
}

function ScalarField({ descriptor, value, path, editable, isOverridden, onCommit, onValidity }: ParamFieldProps) {
  const id = useId();
  const shown = value == null ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  const [previous, setPrevious] = useState(shown);
  if (previous !== shown) {
    setPrevious(shown);
    setDraft(shown);
  }
  const parsed = parse(descriptor, draft);
  const validityRef = useRef(onValidity);

  useEffect(() => {
    validityRef.current = onValidity;
  }, [onValidity]);

  useEffect(() => {
    validityRef.current(path, parsed.ok);
  }, [path, parsed.ok]);

  useEffect(
    () => () => {
      validityRef.current(path, true);
    },
    [path],
  );
  const overridden = isOverridden(path);
  const fallback = descriptor.default == null ? "" : String(descriptor.default);
  const commit = () => {
    if (parsed.ok && draft.trim() !== shown) onCommit(parsed.value);
  };

  return (
    <div className={overridden ? "param-field param-field--overridden" : "param-field"}>
      <label htmlFor={id} title={descriptor.description}>
        {descriptor.title}
      </label>
      {descriptor.kind === "CHOICE" ? (
        <select
          id={id}
          value={draft}
          disabled={!editable}
          onChange={(event) => {
            setDraft(event.target.value);
            onCommit(event.target.value === "" ? undefined : event.target.value);
          }}
        >
          {descriptor.required ? null : <option value="">{fallback === "" ? "Default" : `Default (${fallback})`}</option>}
          {descriptor.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type="text"
          inputMode={descriptor.kind === "QUANTITY" ? "text" : "decimal"}
          value={draft}
          placeholder={fallback}
          readOnly={!editable}
          aria-invalid={parsed.ok ? undefined : true}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
      )}
      {overridden ? <span className="param-badge">overridden</span> : null}
      {parsed.ok ? null : (
        <span className="param-error" role="alert">
          {parsed.message}
        </span>
      )}
    </div>
  );
}
```

`src/inspector/Inspector.tsx`:

```tsx
import type { Catalog, ExperimentFile, ModelFile } from "../api/apiTypes";
import { elementOf, isOverridden } from "../workspace/params";
import { ParamField } from "./ParamField";

export interface InspectorProps {
  catalog: Catalog;
  /** The model as the active variant page sees it. */
  model: ModelFile;
  experiment: ExperimentFile;
  selected: string | null;
  /** False on variant pages: values are shown, not edited. */
  editable: boolean;
  overrides: Record<string, unknown>;
  onParam: (id: string, name: string, value: unknown) => void;
  /** Validity of a field draft by `elementId.path`; a field that unmounts reports itself valid. */
  onValidity: (key: string, valid: boolean) => void;
}

/** Context inspector (product vision §5.5): the selected element from the catalog, run settings otherwise. */
export function Inspector({ catalog, model, experiment, selected, editable, overrides, onParam, onValidity }: InspectorProps) {
  const element = selected === null ? null : elementOf(model, selected);
  const type = element === null ? undefined : catalog.types.find((candidate) => candidate.id === element.type);

  return (
    <aside className="inspector" aria-label="Inspector">
      {selected !== null && element !== null && type !== undefined ? (
        <>
          <h2>{selected}</h2>
          <p className="inspector-type">
            {type.title}
            {editable ? "" : " · read-only on this variant page"}
          </p>
          {type.params.length === 0 ? <p>No parameters.</p> : null}
          {type.params.map((descriptor) => (
            <ParamField
              key={`${selected}.${descriptor.name}`}
              descriptor={descriptor}
              value={element.params[descriptor.name]}
              path={descriptor.name}
              editable={editable}
              isOverridden={(path) => isOverridden(overrides, selected, path)}
              onCommit={(value) => onParam(selected, descriptor.name, value)}
              onValidity={(path, valid) => onValidity(`${selected}.${path}`, valid)}
            />
          ))}
        </>
      ) : (
        <RunSettings experiment={experiment} />
      )}
    </aside>
  );
}

function RunSettings({ experiment }: { experiment: ExperimentFile }) {
  const { execution } = experiment;
  return (
    <>
      <h2>Run settings</h2>
      <dl className="run-settings">
        <dt>Replications</dt>
        <dd>{execution.replications}</dd>
        <dt>Warm-up</dt>
        <dd>{execution.warmup}</dd>
        <dt>Measurement</dt>
        <dd>{execution.measurement}</dd>
        <dt>Seed</dt>
        <dd>{execution.seed}</dd>
      </dl>
      <h3>Faults</h3>
      {experiment.faults.length === 0 ? (
        <p>None.</p>
      ) : (
        <ul>
          {experiment.faults.map((fault, index) => (
            <li key={index}>
              {fault.target}: {fault.from}–{fault.to}
              {fault.processingMultiplier == null ? "" : `, processing ×${fault.processingMultiplier}`}
              {fault.failureRate == null ? "" : `, failures ${fault.failureRate}`}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
```

- [ ] **Step 4: Тест проходит**

Run: `npm test -- --run src/inspector && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/inspector
git commit -m "feat(web): build the inspector from catalog descriptors"
```

---

### Task 9: Панели каркаса

**Files:**
- Create: `web/src/layout/TopBar.tsx`, `Palette.tsx`, `ResultsPanel.tsx`, `SummaryTable.tsx`, `ProblemList.tsx`, `web/src/components/useHealth.ts`
- Test: `web/src/layout/SummaryTable.test.tsx`

- [ ] **Step 1: Написать падающий тест**

```tsx
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { summary } from "../test/fixtures";
import { ProblemList } from "./ProblemList";
import { SummaryTable } from "./SummaryTable";

describe("SummaryTable", () => {
  it("shows one row per variant with confidence intervals and service amplification", () => {
    render(<SummaryTable summary={summary} />);
    const table = screen.getByRole("table", { name: "Summary" });

    const baseline = within(table).getByRole("row", { name: /Baseline/ });
    expect(baseline.textContent).toContain("97.5% (95% CI 95.0%–100.0%)");
    expect(baseline.textContent).toContain("41.3 ms");
    expect(baseline.textContent).toContain("1.20×");
    expect(within(table).getByRole("columnheader", { name: "gateway admitted ×" })).toBeTruthy();
    expect(within(table).getByRole("row", { name: /No retries/ }).textContent).toContain("n/a");
  });
});

describe("ProblemList", () => {
  it("lists diagnostics with their location", () => {
    render(
      <ProblemList
        problem={{
          code: "EXPERIMENT_INVALID",
          message: "Experiment has errors",
          diagnostics: [
            {
              code: "PARAM_MISSING",
              severity: "ERROR",
              message: "Required parameter 'handlers' is missing",
              document: "m.model.json",
              pointer: "/blocks/gateway/params/handlers",
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "PARAM_MISSING m.model.json#/blocks/gateway/params/handlers: Required parameter 'handlers' is missing",
    );
  });
});
```

- [ ] **Step 2: Тест падает**

Run: `npm test -- --run src/layout`
Expected: FAIL — нет модулей `./SummaryTable`, `./ProblemList`.

- [ ] **Step 3: Реализация**

`src/layout/SummaryTable.tsx`:

```tsx
import type { MetricSummary, RunSummary } from "../api/apiTypes";

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const millis = (value: number) => `${value.toFixed(1)} ms`;
const times = (value: number) => `${value.toFixed(2)}×`;

/** Mean over replications with the Student 95% interval when there are at least two replications. */
function metric(summary: MetricSummary | null | undefined, format: (value: number) => string): string {
  if (summary == null) return "n/a";
  const interval =
    summary.ci95Low == null || summary.ci95High == null ? "" : ` (95% CI ${format(summary.ci95Low)}–${format(summary.ci95High)})`;
  return format(summary.mean) + interval;
}

/** Metrics by variant (stage 1 design §6.3, Summary tab). */
export function SummaryTable({ summary }: { summary: RunSummary }) {
  const services = [...new Set(summary.variants.flatMap((variant) => Object.keys(variant.aggregate.services)))].sort();
  return (
    <table className="summary-table" aria-label="Summary">
      <thead>
        <tr>
          <th scope="col">Variant</th>
          <th scope="col">Replications</th>
          <th scope="col">Success rate</th>
          <th scope="col">p95 latency</th>
          <th scope="col">p99 latency</th>
          {services.map((service) => (
            <th key={service} scope="col">
              {service} admitted ×
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {summary.variants.map((variant) => (
          <tr key={variant.id}>
            <th scope="row">{variant.label}</th>
            <td>{variant.replications}</td>
            <td>{metric(variant.aggregate.successRate, percent)}</td>
            <td>{metric(variant.aggregate.p95LatencyMs, millis)}</td>
            <td>{metric(variant.aggregate.p99LatencyMs, millis)}</td>
            {services.map((service) => (
              <td key={service}>{metric(variant.aggregate.services[service]?.admittedAmplification, times)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

`src/layout/ProblemList.tsx`:

```tsx
import type { ApiProblem, Diagnostic } from "../api/apiTypes";

function locationOf(diagnostic: Diagnostic): string {
  return [diagnostic.document, diagnostic.pointer].filter((part) => part != null && part !== "").join("#") || "experiment";
}

/** An API problem with its diagnostics (stage 1 design §4.1). */
export function ProblemList({ problem }: { problem: ApiProblem }) {
  return (
    <div className="problem-list" role="alert">
      <p>{problem.message}</p>
      {problem.diagnostics.length === 0 ? null : (
        <ul>
          {problem.diagnostics.map((diagnostic, index) => (
            <li key={index}>
              {diagnostic.code} {locationOf(diagnostic)}: {diagnostic.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

`src/layout/ResultsPanel.tsx`:

```tsx
import type { ApiProblem, JobView, RunSummary } from "../api/apiTypes";
import { ProblemList } from "./ProblemList";
import { SummaryTable } from "./SummaryTable";

export interface ResultsPanelProps {
  job: JobView | null;
  summary: RunSummary | null;
  problem: ApiProblem | null;
}

function progressOf(job: JobView): string {
  return `${job.status} · ${job.completedTasks}/${job.totalTasks === 0 ? "?" : job.totalTasks} tasks`;
}

/** Results panel below the screen (product vision §5.5); the slice has the Summary tab only. */
export function ResultsPanel({ job, summary, problem }: ResultsPanelProps) {
  return (
    <section className="results-panel" aria-label="Results">
      <div role="tablist" aria-label="Result views">
        <button type="button" role="tab" aria-selected="true">
          Summary
        </button>
      </div>
      <div className="results-body">
        {problem !== null ? (
          <ProblemList problem={problem} />
        ) : summary !== null ? (
          <SummaryTable summary={summary} />
        ) : (
          <p className="results-empty">{job === null ? "Run the experiment to see results." : progressOf(job)}</p>
        )}
      </div>
    </section>
  );
}
```

`src/layout/Palette.tsx`:

```tsx
import type { Catalog, TypeDescriptor } from "../api/apiTypes";

function TypeList({ title, types }: { title: string; types: TypeDescriptor[] }) {
  return (
    <>
      <h2>{title}</h2>
      <ul>
        {types.map((type) => (
          <li key={type.id} title={type.description}>
            {type.title}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Computable types of the catalog; dragging them onto the canvas arrives with the editor track. */
export function Palette({ catalog }: { catalog: Catalog | null }) {
  const types = catalog?.types ?? [];
  return (
    <aside className="palette" aria-label="Palette">
      <TypeList title="Blocks" types={types.filter((type) => type.category === "BLOCK")} />
      <TypeList title="Connections" types={types.filter((type) => type.category === "CONNECTION")} />
    </aside>
  );
}
```

`src/layout/TopBar.tsx`:

```tsx
import type { HealthView, JobView } from "../api/apiTypes";
import { HealthBadge } from "../components/HealthBadge";

export interface TopBarProps {
  experiments: string[];
  experiment: string | null;
  onExperiment: (path: string) => void;
  /** An experiment is being opened. */
  loading: boolean;
  dirty: boolean;
  /** Some field holds a draft that cannot be committed. */
  invalid: boolean;
  saving: boolean;
  onSave: () => void;
  running: boolean;
  onRun: () => void;
  job: JobView | null;
  health: HealthView | null;
  healthError: string | null;
}

/**
 * Top bar (stage 1 design §6.1): experiment, unsaved changes, save, run, job status, backend health. Switching waits for
 * opening, saving and running; saving and running wait for valid drafts, and running also for saved changes.
 */
export function TopBar(props: TopBarProps) {
  const { experiments, experiment, onExperiment, loading, dirty, invalid, saving, onSave, running, onRun, job, health, healthError } =
    props;
  return (
    <header className="top-bar">
      <h1>Resilience Lab</h1>
      <span className="top-bar-label">Experiment</span>
      <select
        aria-label="Experiment"
        value={experiment ?? ""}
        disabled={loading || saving || running}
        onChange={(event) => onExperiment(event.target.value)}
      >
        {experiment === null ? <option value="">No experiment</option> : null}
        {experiments.map((path) => (
          <option key={path} value={path}>
            {path}
          </option>
        ))}
      </select>
      {dirty ? <span className="dirty-mark">Unsaved changes</span> : null}
      <button type="button" onClick={onSave} disabled={!dirty || invalid || saving || loading}>
        Save
      </button>
      <button
        type="button"
        className="primary"
        onClick={onRun}
        disabled={experiment === null || loading || dirty || invalid || running}
        title={invalid ? "Fix invalid values first" : dirty ? "Save changes before running" : undefined}
      >
        Run
      </button>
      <span className="job-status" data-testid="job-status">
        {job === null ? "" : job.status}
      </span>
      <span className="spacer" />
      <HealthBadge health={health} error={healthError} />
    </header>
  );
}
```

`src/components/useHealth.ts`:

```ts
import { useEffect, useState } from "react";
import { api } from "../api/apiClient";
import type { HealthView } from "../api/apiTypes";

/** Backend health, read once on start. */
export function useHealth(): { health: HealthView | null; error: string | null } {
  const [health, setHealth] = useState<HealthView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .health()
      .then((value) => {
        if (active) setHealth(value);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Health check failed");
      });
    return () => {
      active = false;
    };
  }, []);

  return { health, error };
}
```

В `src/components/HealthBadge.tsx` заменить импорт типа на `import type { HealthView } from "../api/apiTypes";`.

- [ ] **Step 4: Тест проходит**

Run: `npm test -- --run src/layout src/components && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/layout web/src/components
git commit -m "feat(web): add top bar, palette and results panels"
```

---

### Task 10: Каркас приложения и удаление интерфейса MVP

**Files:**
- Modify: `web/src/App.tsx` (заменить целиком), `web/src/styles.css` (заменить целиком)
- Delete: `web/src/editor/`, `web/src/experiment/`, `web/src/forms/`, `web/src/io/`, `web/src/results/`, `web/src/scenario/`, `web/src/api/types.ts`, `web/src/api/client.ts`, `web/src/api/client.test.ts`

- [ ] **Step 1: `src/App.tsx` целиком**

```tsx
import { useCallback, useState } from "react";
import { Canvas } from "./canvas/Canvas";
import { VariantTabs } from "./canvas/VariantTabs";
import { useHealth } from "./components/useHealth";
import { Inspector } from "./inspector/Inspector";
import { Palette } from "./layout/Palette";
import { ProblemList } from "./layout/ProblemList";
import { ResultsPanel } from "./layout/ResultsPanel";
import { TopBar } from "./layout/TopBar";
import { useRun } from "./run/useRun";
import { applyOverrides } from "./workspace/params";
import { useWorkspace } from "./workspace/useWorkspace";

/**
 * One-screen layout (product vision §5.5, stage 1 design §6.1). A variant without overrides is the model itself and
 * can be edited; other variant pages show the model with their overrides, read-only in the stage 1 slice. Results are
 * shown only for the experiment they were computed for.
 */
export function App() {
  const workspace = useWorkspace();
  const run = useRun();
  const health = useHealth();
  const [variantId, setVariantId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(new Set());
  const { loaded, catalog } = workspace;
  const variants = loaded?.experiment.variants ?? [];
  const variant = variants.find((candidate) => candidate.id === variantId) ?? variants[0];
  const overrides = variant?.overrides ?? {};
  const editable = Object.keys(overrides).length === 0 && !workspace.loading;
  const model = loaded === null || catalog === null ? null : applyOverrides(loaded.model, overrides, catalog);
  const ownRun = loaded !== null && run.experiment === loaded.experimentPath;

  const onValidity = useCallback((key: string, valid: boolean) => {
    setInvalidFields((current) => {
      if (valid === !current.has(key)) return current;
      const next = new Set(current);
      if (valid) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <div className="app">
      <TopBar
        experiments={workspace.experiments}
        experiment={loaded?.experimentPath ?? null}
        onExperiment={(path) => {
          if (workspace.dirty && !window.confirm("Discard unsaved changes to the model?")) return;
          setSelected(null);
          setVariantId(null);
          run.reset();
          void workspace.open(path, true);
        }}
        loading={workspace.loading}
        dirty={workspace.dirty}
        invalid={invalidFields.size > 0}
        saving={workspace.saving}
        onSave={() => void workspace.save()}
        running={run.running}
        onRun={() => {
          if (loaded !== null) void run.run(loaded.experimentPath);
        }}
        job={ownRun ? run.job : null}
        health={health.health}
        healthError={health.error}
      />
      <Palette catalog={catalog} />
      <main className="canvas-area">
        <div className="canvas-messages">
          {workspace.conflict ? (
            <div className="banner" role="alert">
              The model changed on disk.{" "}
              <button type="button" onClick={() => void workspace.reload()}>
                Reload
              </button>
            </div>
          ) : null}
          {workspace.problem === null ? null : <ProblemList problem={workspace.problem} />}
        </div>
        <div className="canvas">
          {model === null || loaded === null ? (
            <p className="canvas-empty">Loading workspace…</p>
          ) : (
            <Canvas model={model} layout={loaded.layout} selected={selected} onSelect={setSelected} />
          )}
        </div>
        <VariantTabs variants={variants} active={variant?.id ?? ""} onSelect={setVariantId} />
      </main>
      {model === null || loaded === null || catalog === null ? (
        <aside className="inspector" aria-label="Inspector" />
      ) : (
        <Inspector
          catalog={catalog}
          model={model}
          experiment={loaded.experiment}
          selected={selected}
          editable={editable}
          overrides={overrides}
          onParam={workspace.setParam}
          onValidity={onValidity}
        />
      )}
      <ResultsPanel
        job={ownRun ? run.job : null}
        summary={ownRun ? run.summary : null}
        problem={ownRun ? run.problem : null}
      />
    </div>
  );
}
```

- [ ] **Step 2: `src/styles.css` целиком (светлая тема, экран без прокрутки)**

```css
:root {
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  color: #1f2933;
  background: #f5f7fa;
  font-synthesis: none;
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  height: 100%;
  margin: 0;
}

button,
input,
select {
  font: inherit;
}

.app {
  display: grid;
  height: 100vh;
  overflow: hidden;
  grid-template-columns: 13rem minmax(0, 1fr) 20rem;
  grid-template-rows: auto minmax(0, 1fr) 16rem;
  grid-template-areas:
    "top top top"
    "palette canvas inspector"
    "results results results";
}

.top-bar {
  grid-area: top;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid #d5dbe3;
  background: #fff;
}

.top-bar h1 {
  margin: 0 1rem 0 0;
  font-size: 1.1rem;
}

.top-bar-label,
.job-status {
  color: #52606d;
  font-size: 0.875rem;
}

.top-bar select {
  padding: 0.3rem 0.5rem;
  border: 1px solid #9aa5b1;
  border-radius: 0.35rem;
  background: #fff;
}

.top-bar button {
  padding: 0.35rem 0.9rem;
  border: 1px solid #9aa5b1;
  border-radius: 0.35rem;
  background: #fff;
  cursor: pointer;
}

.top-bar button.primary {
  border-color: #2563eb;
  background: #2563eb;
  color: #fff;
}

.top-bar button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.dirty-mark {
  color: #b45309;
  font-size: 0.875rem;
}

.spacer {
  flex: 1;
}

.health-badge {
  padding: 0.3rem 0.65rem;
  border: 1px solid #9aa5b1;
  border-radius: 999px;
  font-size: 0.8rem;
}

.health-badge--healthy {
  border-color: #16a34a;
  color: #166534;
}

.health-badge--error {
  border-color: #dc2626;
  color: #991b1b;
}

.palette {
  grid-area: palette;
  overflow: auto;
  padding: 0.75rem;
  border-right: 1px solid #d5dbe3;
  background: #fff;
}

.palette h2 {
  margin: 0.5rem 0;
  color: #52606d;
  font-size: 0.75rem;
  text-transform: uppercase;
}

.palette ul {
  margin: 0 0 1rem;
  padding: 0;
  list-style: none;
}

.palette li {
  margin-bottom: 0.35rem;
  padding: 0.4rem 0.5rem;
  border: 1px solid #d5dbe3;
  border-radius: 0.35rem;
  background: #f8fafc;
}

.canvas-area {
  grid-area: canvas;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-height: 0;
}

.canvas {
  min-height: 0;
}

.canvas-empty,
.results-empty {
  margin: 1rem;
  color: #52606d;
}

.banner {
  margin: 0.5rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid #f59e0b;
  border-radius: 0.35rem;
  background: #fffbeb;
}

.block-node {
  display: grid;
  gap: 0.2rem;
  min-width: 11rem;
  padding: 0.6rem 0.8rem;
  border: 1px solid #9aa5b1;
  border-radius: 0.5rem;
  background: #fff;
}

.block-node--client {
  border-color: #0ea5e9;
}

.block-node span {
  color: #52606d;
  font-size: 0.8rem;
}

.react-flow__node.selected .block-node {
  border-color: #2563eb;
  box-shadow: 0 0 0 2px #bfdbfe;
}

.variant-tabs {
  display: flex;
  gap: 0.25rem;
  padding: 0.35rem 0.5rem;
  border-top: 1px solid #d5dbe3;
  background: #fff;
}

.variant-tabs button {
  padding: 0.25rem 0.75rem;
  border: 1px solid #d5dbe3;
  border-radius: 0 0 0.35rem 0.35rem;
  background: #f1f4f8;
  cursor: pointer;
}

.variant-tabs button[aria-selected="true"] {
  border-color: #2563eb;
  background: #fff;
  color: #1d4ed8;
}

.inspector {
  grid-area: inspector;
  overflow: auto;
  padding: 0.75rem;
  border-left: 1px solid #d5dbe3;
  background: #fff;
}

.inspector h2 {
  margin: 0;
  font-size: 1rem;
}

.inspector-type {
  margin: 0.25rem 0 0.75rem;
  color: #52606d;
  font-size: 0.85rem;
}

.run-settings {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 0.75rem;
}

.run-settings dd {
  margin: 0;
}

.param-group {
  margin: 0 0 0.6rem;
  padding: 0.5rem;
  border: 1px solid #d5dbe3;
  border-radius: 0.35rem;
}

.param-field {
  display: grid;
  gap: 0.2rem;
  margin-bottom: 0.6rem;
}

.param-field label {
  font-size: 0.85rem;
}

.param-field input,
.param-field select {
  padding: 0.3rem 0.45rem;
  border: 1px solid #9aa5b1;
  border-radius: 0.3rem;
  background: #fff;
}

.param-field input[readonly],
.param-field select:disabled {
  background: #f1f4f8;
}

.param-field input[aria-invalid="true"] {
  border-color: #dc2626;
}

.param-field--overridden input,
.param-field--overridden select {
  border-color: #f59e0b;
  background: #fffbeb;
}

.param-badge {
  color: #b45309;
  font-size: 0.75rem;
}

.param-error {
  color: #dc2626;
  font-size: 0.75rem;
}

.results-panel {
  grid-area: results;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 0;
  border-top: 1px solid #d5dbe3;
  background: #fff;
}

.results-panel [role="tablist"] {
  display: flex;
  gap: 0.25rem;
  padding: 0.35rem 0.75rem 0;
  border-bottom: 1px solid #d5dbe3;
}

.results-panel [role="tab"] {
  padding: 0.25rem 0.75rem;
  border: 1px solid #d5dbe3;
  border-bottom: none;
  border-radius: 0.35rem 0.35rem 0 0;
  background: #fff;
}

.results-body {
  overflow: auto;
  padding: 0.75rem;
}

.summary-table {
  border-collapse: collapse;
  font-size: 0.875rem;
}

.summary-table th,
.summary-table td {
  padding: 0.35rem 0.75rem;
  border-bottom: 1px solid #e4e7eb;
  text-align: left;
  white-space: nowrap;
}

.problem-list {
  color: #991b1b;
}
```

- [ ] **Step 3: Удалить интерфейс MVP**

```bash
git rm -r web/src/editor web/src/experiment web/src/forms web/src/io web/src/results web/src/scenario
git rm web/src/api/types.ts web/src/api/client.ts web/src/api/client.test.ts
```

Run: `grep -rln "api/types\|api/client\|scenario/" web/src web/e2e`
Expected: совпадения только в старых `web/e2e/*.spec.ts`; их заменяет Task 11.

- [ ] **Step 4: Проверка**

Run: `npm run lint && npm test -- --run && npm run build`
Expected: PASS. `tsc -b` не проверяет `e2e/`, поэтому старые E2E ещё не мешают сборке.

Run: `npm run dev -- --host 127.0.0.1` при запущенном `./gradlew :apps:server:bootRun` из корня; открыть `http://127.0.0.1:5173`.
Expected: страница не прокручивается; слева палитра, в центре четыре блока retry storm, справа параметры прогона, внизу вкладки `Baseline` и `No retries` и панель результатов.

- [ ] **Step 5: Commit**

```bash
git add -A web/src
git commit -m "feat(web): replace the MVP interface with the stage 1 layout"
```

---

### Task 11: E2E среза

**Files:**
- Delete: `web/e2e/arrival-rate.spec.ts`, `web/e2e/retry-storm.spec.ts`, `web/e2e/submission-guards.spec.ts`, `web/e2e/sweep.spec.ts`
- Create: `web/e2e/workspace.spec.ts`

- [ ] **Step 1: Новый сценарий**

```ts
import { expect, test } from "@playwright/test";

const experiment = "retry-storm/retry-storm.experiment.json";
const model = "retry-storm/retry-storm.model.json";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Backend healthy/)).toBeVisible();
  await expect(page.getByLabel("Experiment")).toHaveValue(experiment);
  await expect(page.getByTestId("block-node")).toHaveCount(4);
});

test("shows a variant page read-only with its overrides", async ({ page }) => {
  await page.getByRole("tab", { name: "No retries" }).click();
  const call = page.getByTestId("rf__edge-gateway-to-middle");
  await expect(call).toContainText("· 1×");
  await call.click();

  const attempts = page.getByLabel("Attempts", { exact: true });
  await expect(attempts).toHaveValue("1");
  await expect(attempts).not.toBeEditable();
  await expect(page.locator(".param-field--overridden")).toContainText("overridden");

  await page.getByRole("tab", { name: "Baseline" }).click();
  await expect(attempts).toHaveValue("3");
  await expect(attempts).toBeEditable();
});

test("edits the model, saves it, runs the experiment and shows the summary", async ({ page, request }) => {
  await page.getByTestId("rf__node-gateway").click();
  const handlers = page.getByLabel("Handlers", { exact: true });
  await expect(handlers).toHaveValue("4");
  await handlers.fill("4.5");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
  await handlers.fill("6");
  await handlers.press("Enter");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Unsaved changes")).toBeHidden();
  const stored = await (await request.get(`/api/v1/workspace/document?path=${encodeURIComponent(model)}`)).json();
  expect(stored.content.model.blocks.gateway.params.handlers).toBe(6);

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByTestId("job-status")).toHaveText("COMPLETED", { timeout: 60_000 });
  const summary = page.getByRole("table", { name: "Summary" });
  await expect(summary.getByRole("row", { name: /Baseline/ })).toContainText("%");
  await expect(summary.getByRole("row", { name: /No retries/ })).toContainText("%");
});
```

`rf__node-<id>` и `rf__edge-<id>` — `data-testid`, которые React Flow ставит на узлы и связи.

- [ ] **Step 2: Удалить старые сценарии и прогнать**

```bash
git rm web/e2e/arrival-rate.spec.ts web/e2e/retry-storm.spec.ts web/e2e/submission-guards.spec.ts web/e2e/sweep.spec.ts
```

Run: `npm run test:e2e`
Expected: PASS, 2 теста. После прогона `git status` не показывает изменений в `examples/`.

- [ ] **Step 3: Commit**

```bash
git add web/e2e
git commit -m "test(e2e): cover the stage 1 slice in a real browser"
```

---

### Task 12: Документация

**Files:**
- Modify: `AGENTS.md`, `README.md`

- [ ] **Step 1: `AGENTS.md`, «Текущее состояние»**

Заменить строку `` - `web` — Vite/React SPA с ... `` на:

```markdown
- `web` — Vite/React SPA этапа 1: экран без прокрутки, холст React Flow, инспектор параметров из каталога с сохранением модели, страницы вариантов для просмотра, запуск задания и сводка; типы API генерируются из `apps/server/openapi.json`.
```

В строке `core` заменить «; модель сценариев MVP со sweep остаётся до перехода web» на «; модель сценариев MVP со sweep остаётся до отдельного плана удаления MVP». В строке `apps:server` заменить « и ручки MVP для нынешнего web» на « и ручки MVP, которые больше не используются и ждут удаления».

Заменить абзац «Первый полный MVP завершён: ...» на:

```markdown
Сквозной срез этапа 1: реальный Chromium-сценарий открывает пример рабочей области, меняет параметр, сохраняет модель, запускает эксперимент и видит сводку без mock API. Ручки MVP на сервере больше не используются и удаляются отдельной задачей.
```

- [ ] **Step 2: `AGENTS.md`, команды**

После строки `` - `npm run lint` — ESLint для web. `` добавить:

```markdown
- `npm run api:types` — пересоздать `web/src/api/schema.d.ts` из `apps/server/openapi.json`; `npm run api:check` проверяет, что файл актуален.
```

В строке `npm run test:e2e` заменить `` изолированные `./gradlew :apps:server:bootRun` из корня `` на `` изолированные `./gradlew :apps:server:bootRunE2e` из корня (сервер на свежей копии `examples/` в `apps/server/build/e2e-workspace/`, поэтому E2E не меняют файлы репозитория) ``.

В абзаце про CI заменить `` `npm ci`, lint, `npm run test:coverage` и production build `` на `` `npm ci`, lint, проверку сгенерированных типов API (`npm run api:check`), `npm run test:coverage` и production build ``.

- [ ] **Step 3: `README.md`**

Заменить абзац «Текущая версия моделирует ...» (до «Сценарии и результаты экспортируются в JSON.» включительно) на:

```markdown
Текущая версия моделирует линейные синхронные вызовы: ограниченные пулы
обработчиков и очереди, таймауты, повторы с backoff/jitter и общий deadline.
Модель, раскладка и эксперимент — JSON-файлы рабочей области; варианты
эксперимента переопределяют параметры модели и сравниваются на независимых
повторениях. Результаты включают долю успешных запросов, p95/p99 задержки и
размножение нагрузки из-за повторов (amplification); прогоны сохраняются в
`.results/`.
```

Заменить два абзаца от «Нажмите `Load retry storm example`...» до «`Download full result JSON`.» на:

```markdown
Откроется эксперимент retry storm. Выберите блок или связь на схеме, измените
параметр в инспекторе справа, нажмите `Save`, затем `Run` и дождитесь
`COMPLETED`: сводка по вариантам появится в панели внизу. Вкладки под схемой
переключают варианты; на странице варианта с переопределениями параметры
доступны только для просмотра, переопределённые отмечены.

Оба порта доступны только на `127.0.0.1`. Backend работает с копией `examples/`
внутри контейнера: изменения и результаты прогонов пропадают вместе с ним.
```

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md
git commit -m "docs: describe the stage 1 web interface"
```

---

### Task 13: Полная проверка

- [ ] **Step 1: Web**

Run: `npm ci && npm run lint && npm run api:check && npm test -- --run && npm run build && npm run test:e2e`
Expected: всё проходит.

- [ ] **Step 2: JVM**

Run (из корня): `./gradlew clean build`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 3: Docker Compose**

```bash
docker compose up --build -d
curl -fsS http://127.0.0.1:5173/api/v1/workspace/documents
docker compose down
```

Expected: список содержит документы `retry-storm/`; интерфейс на `http://127.0.0.1:5173` показывает схему. Если Docker недоступен, написать об этом в PR.

- [ ] **Step 4: Просмотр диффа**

Run: `git diff --check origin/main && git diff --stat origin/main`
Expected: изменения в `web/`, `apps/server/build.gradle.kts`, `.github/workflows/ci.yml`, `AGENTS.md`, `README.md`; в `examples/` изменений нет.

- [ ] **Step 5: PR**

Открыть PR в `main` по правилам `AGENTS.md` (раздел «Работа по issue») с `Closes #<issue web>`.
