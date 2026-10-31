# web/AGENTS.md

Правила для frontend. Дополняют [корневой AGENTS.md](../AGENTS.md); общие правила работы по issue — там.

## Окружение

Команды выполняются из каталога `web`. Node.js — версия из `.nvmrc` и npm из её комплекта: `nvm install && nvm use` или `fnm install && fnm use`.

## Команды

- `npm ci` — воспроизводимая установка зависимостей из `package-lock.json`.
- `npm run lint` — ESLint.
- `npm test -- --run` — unit-тесты Vitest; `npm run test:coverage` — с V8-покрытием без порогов, отчёт в `coverage/`.
- `npm run build` — проверка типов и production-сборка в `dist/`.
- `npm run api:types` — пересоздать `src/api/schema.d.ts` из `../apps/server/openapi.json`; `npm run api:check` проверяет, что файл актуален. Типы API вручную не правятся: при конфликте пересоздай их генератором.
- `npm run dev` — Vite dev server на `5173` с proxy `/api` на `http://127.0.0.1:8080`; backend запускается отдельно `./gradlew :apps:server:bootRun` из корня.
- `npx playwright install chromium` — локальный Chromium для E2E; в CI он уже есть в образе Playwright.
- `npm run test:e2e` — E2E Playwright с настоящим backend (см. ниже).

Проверки web-изменений перед PR: `npm ci`, `npm run lint`, `npm test -- --run`, `npm run build`; при изменении API — ещё `npm run api:check`; для UI и пользовательских сценариев — затронутые сценарии E2E (раздел «E2E»).

## E2E

- **Границы новых тестов.** E2E пишутся для сквозных сценариев «интерфейс ↔ сервер». Детали интерфейса — раскладка, тексты, состояние отдельных элементов — проверяются unit- и компонентными тестами. Прогон реального эксперимента в E2E добавляй только тогда, когда тест проверяет результат расчёта.

- **Что запускать перед PR.** Локально — затронутые сценарии: новые и изменённые файлы `e2e/*.spec.ts` и файлы, которые проверяют изменённую область, например `npx playwright test e2e/language.spec.ts e2e/scenario-editor.spec.ts`. Полный набор выполняют три части `e2e-shard` в CI на каждом pull request с кодом. Правило действует и тогда, когда в issue указан `npm run test:e2e`.
- **Когда нужен полный `npm run test:e2e` локально:** изменены API или его клиент в `web/src/api/`, общая раскладка (`App.tsx`, `web/src/layout/`), конфигурация или общие помощники E2E (`playwright.config.ts`, `playwright.global-setup.ts`), или job `e2e` в CI упал.
- **В описании PR** перечисли запущенные файлы E2E. Если job `e2e` в CI упал — исправь причину, повтори упавшие и затронутые сценарии локально.
- Playwright сам запускает свои серверы: локально `./gradlew :apps:server:bootRunE2e` на свежей копии `examples/` в `apps/server/build/e2e-workspace/` и Vite в режиме `e2e` с `--strictPort`. В CI job `e2e-server` один раз собирает JAR; каждая часть `e2e-shard` задаёт `E2E_SERVER_JAR` (путь от корня репозитория), а `scripts/e2e-server.mjs` создаёт свежую копию `examples/` без `.results/` и запускает JAR через Java. Уже запущенные серверы не используются, файлы репозитория не меняются.
- Порты — `E2E_BACKEND_PORT` (по умолчанию `8080`) и `E2E_WEB_PORT` (по умолчанию `5173`), разные. Если порт занят, прогон останавливается до тестов с именем переменной для замены. Проверка портов выполняется один раз за запуск, поэтому работает и UI mode (`--ui`).
- Одновременные прогоны — в отдельных worktree и на разных парах портов: `E2E_BACKEND_PORT=18080 E2E_WEB_PORT=15173 npm run test:e2e`.
- Trace и screenshot при ошибках — в `test-results/`. HTML-отчёт для `npx playwright show-report` пишется только с `--reporter=html` (в CI передаётся `--reporter=line,html`). В CI отчёты частей сохраняются отдельно: скачай `playwright-artifacts-<i>` и открой его `playwright-report/` командой `npx playwright show-report <каталог>/playwright-report`.
- Перед проверкой холодного старта удаляй `node_modules/.vite`: лениво загружаемые зависимости при пустом кэше могут перезагрузить страницу, если их нет в `optimizeDeps.include` в `vite.config.ts`.

## Зависимости

Dependabot еженедельно проверяет npm в `/web` и `web/Dockerfile`; minor и patch объединяются, major приходят отдельными PR, для `@playwright/test` выделена группа `playwright`.

- **Node.js.** `.nvmrc` и `FROM node:<версия>-alpine` в `Dockerfile` меняются в одном PR, в том числе в PR Dependabot; CI проверяет совпадение. При смене major согласуй `engines.node` в `package.json`.
- **Playwright.** `package.json`, `package-lock.json` и `jobs.e2e-shard.container.image` в `.github/workflows/ci.yml` меняются в одном PR. Образ имеет вид `mcr.microsoft.com/playwright:v<версия @playwright/test>-noble`; CI блокирует рассинхрон. В PR группы `playwright` образ меняется вручную: Dependabot обновляет ссылки `uses:`, а не `container.image`.
- **TypeScript.** `@typescript/native` (`npm:typescript@7.x`) даёт `tsc` для сборки и проверки типов. Alias `typescript` (`npm:@typescript/typescript6@6.x`) даёт `tsc6` и API TypeScript 6 для инструментов, включая `typescript-eslint`; фактический компилятор 6 закреплён в `overrides["@typescript/old"]`. Dependabot эти пакеты не видит, обновляются вручную: `@typescript/native`, alias `typescript`, `overrides["@typescript/old"]` и `package-lock.json` в одном PR, версия override совпадает с версией alias.
- **minimatch.** `overrides.minimatch` поднимает `minimatch` до 11 во всём дереве: версии до 11.0.1 уязвимы (GHSA-g3hv-75wg-m249), а `@redocly/openapi-core` 1.x внутри `openapi-typescript` 7 закрепляет 5.1.9. В версии 11 модуль не вызывается как функция; redocly делает такой вызов только при сопоставлении URL удалённых ссылок с заголовками из своего конфига, а `npm run api:types` читает локальный `openapi.json`. Сними переопределение, когда `openapi-typescript` перейдёт на `@redocly/openapi-core` 2 или новее; после снятия `npm audit` должен оставаться чистым.
- **nginx.** Образ `nginx:alpine` в `Dockerfile` плавающий: новое содержимое приходит при загрузке образа, PR от Dependabot на это не бывает.
