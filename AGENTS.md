# AGENTS.md

## Текущее состояние

Текущий срез включает модули `core`, `apps:cli`, `apps:server` и `web`:

- `core` — модель сценариев, валидация, KSL-симуляция, повторения, parameter sweep и агрегация метрик.
- `apps:cli` — команды `validate`, `run` и `sweep`, собираемые с помощью Gradle `application`.
- `apps:server` — Spring Boot API для health, валидации сценариев, асинхронных заданий экспериментов и их результатов; задания хранятся process-local.
- `web` — Vite/React SPA с типизированным API client, health badge, controlled Xyflow editor, формами параметров, baseline/candidate-сравнением, sweep, Recharts-графиками и импортом/экспортом JSON.

Первый полный MVP завершён: core, CLI, Spring API и браузерный UI реализованы; реальный Chromium-сценарий проходит через editor, API, polling, charts и download без mock API.

## Стандартные команды сборки и проверки

Gradle-команды выполняются из корня репозитория, команды web — из каталога `web`; для всех JVM-модулей требуется JDK 25 (`jvmToolchain(25)`), для web — версия Node.js из `web/.nvmrc` и npm из её комплекта.

В каталоге `web/` выполните `nvm install && nvm use` или `fnm install && fnm use`: версия будет взята из `.nvmrc`.

- `./gradlew test` — все JVM-тесты.
- `./gradlew clean build` — чистая полная сборка и все доступные JVM-проверки.
- `./gradlew :core:test` — тесты модуля `core`.
- `./gradlew :apps:cli:test` — тесты модуля `apps:cli`, включая проверку установленного launcher.
- `./gradlew :apps:server:test` — тесты модуля `apps:server`.
- `./gradlew ktlintCheck` — проверка KtLint для всех JVM-модулей.
- `./gradlew jacocoTestReport jacocoTestCoverageVerification` — формирование отчётов JaCoCo и проверка покрытия для всех JVM-модулей.
- `npm ci` — воспроизводимая установка frontend-зависимостей из `package-lock.json`.
- `npm test -- --run` — web unit-тесты.
- `npm run test:coverage` — web unit-тесты с V8-покрытием без порогов; HTML и LCOV сохраняются в `web/coverage/`.
- `npm run build` — type-check и production-сборка web в `web/dist/`.
- `npm run lint` — ESLint для web.
- `npm run dev` — Vite dev server с proxy `/api` на `http://127.0.0.1:8080`.
- `npx playwright install chromium` — локальная установка Chromium; в CI браузеры и системные зависимости уже установлены в официальном Docker-образе Playwright.
- `npm run test:e2e` — Playwright запускает изолированные `./gradlew :apps:server:bootRun` из корня и `npm run dev -- --host 127.0.0.1` из `web`, ждёт `http://127.0.0.1:8080/api/v1/health` и `http://127.0.0.1:5173`, не использует уже запущенные серверы и останавливает browser/server processes после прогона. Trace и screenshot при ошибках сохраняются в `web/test-results/`; CI также загружает `web/playwright-report/`, если он сформирован.

Проект использует Gradle Wrapper 9.8.2. Workflow `.github/workflows/ci.yml` запускается на `push` только в ветку `main`, на `pull_request` и вручную через `workflow_dispatch`. В нём настроены две независимые job с лимитом 20 минут каждая. `build` на обычном Ubuntu-раннере выполняет `./gradlew --no-daemon clean build`, `npm ci`, lint, `npm run test:coverage` и production build. `e2e` запускает `npm ci` и `npm run test:e2e -- --reporter=line,html` внутри официального образа `mcr.microsoft.com/playwright:v1.64.1-noble` с готовыми браузерами и системными зависимостями; установки браузеров и apt-пакетов в workflow нет. Обе job используют JDK 25 и Node.js из `web/.nvmrc`, кэши Gradle и npm. При запуске E2E `GRADLE_USER_HOME="$HOME/.gradle"` направляет Gradle в каталог, который кэширует `actions/setup-java` внутри контейнера.

Перед E2E проверяется совпадение версии образа с `@playwright/test` из `web/package-lock.json`; при обновлении Playwright нужно также обновить `jobs.e2e.container.image`, иначе проверка завершится с понятной ошибкой. YAML anchor связывает образ контейнера и значение для проверки. HTML/XML-отчёты JaCoCo `core/build/reports/jacoco/test`, `apps/cli/build/reports/jacoco/test`, `apps/server/build/reports/jacoco/test` и V8-отчёт `web/coverage/` (артефакт `frontend-coverage`) сохраняет job `build`, а `web/test-results/` и `web/playwright-report/` — job `e2e`, в обоих случаях и при ошибке предыдущих шагов, если файлы сформированы. HTML-отчёт Playwright формируется и при успешном прогоне.

### Обновление зависимостей и Docker-образов

Dependabot еженедельно проверяет npm, Gradle, GitHub Actions и Dockerfile в `apps/server` и `web`. Обновления minor/patch объединяются по экосистеме; major приходят отдельными PR. Для `@playwright/test` выделена группа `playwright` для всех типов обновлений.

- При обновлении Node.js меняй `web/.nvmrc` и `FROM node:<версия>-alpine` в `web/Dockerfile` в одном PR, в том числе в PR Dependabot. CI проверяет точное совпадение перед сборкой. Если меняется major, согласуй также `web/package.json` (`engines.node`).
- При обновлении `@playwright/test` обновляй `web/package.json`, `web/package-lock.json` и `jobs.e2e.container.image` в `.github/workflows/ci.yml` в одном PR. Образ должен иметь вид `mcr.microsoft.com/playwright:v<версия @playwright/test>-noble`; существующая CI-проверка блокирует рассинхрон. В PR группы `playwright` образ меняется вручную: [Dependabot для GitHub Actions](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories#github-actions) обновляет ссылки `uses:`, а не `container.image`.
- Плавающий `nginx:alpine` получает новое содержимое при загрузке образа. Без версии или digest Dependabot не создаёт PR на изменение содержимого этого тега.

Параметры `directories`, `groups` и `exclude-patterns` сверены с [документацией Dependabot](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).

### Локальный Docker Compose

- `docker compose up --build -d` — собрать production-like образы и запустить backend и frontend из корня репозитория.
- Frontend: `http://127.0.0.1:5173`; backend health: `http://127.0.0.1:8080/api/v1/health`. Оба host-порта опубликованы только на loopback (`127.0.0.1`), без configurable LAN access.
- `docker compose down` — остановить и удалить только контейнеры этого Compose-проекта; volumes, образы и исходники не удаляются.
- Браузер обращается к same-origin `/api`, Nginx передаёт запросы сервису `backend:8080`. Контейнеры работают от non-root пользователей; секреты и persistent volumes не используются.
- Задания остаются process-local: перезапуск backend удаляет их, поэтому Compose не обеспечивает сохранение результатов между перезапусками.

### Backend API

Backend использует Spring Boot 4.1.2 и JDK 25. `./gradlew :apps:server:bootRun` запускает локальный API с базовым URL `http://127.0.0.1:8080/api/v1`; `./gradlew :apps:server:test` запускает тесты backend. Асинхронные задания экспериментов хранятся только в памяти процесса (process-local) и не сохраняются между перезапусками. Хранятся не более 100 завершённых заданий в порядке завершения FIFO; активные задания никогда не вытесняются.

### CLI

- `./gradlew :apps:cli:run --args="validate examples/retry-storm.json"` — проверить пример эксперимента.
- `./gradlew :apps:cli:run --args="run examples/retry-storm.json"` — выполнить пример эксперимента.
- `./gradlew :apps:cli:run --args="sweep <sweep.json>"` — выполнить parameter sweep; вместо `<sweep.json>` подставить путь к sweep-документу.
- `./gradlew :apps:cli:installDist` — собрать установленный launcher в `apps/cli/build/install/cli/bin/` (`cli` для Linux/macOS, `cli.bat` для Windows).

`run` и `sweep` выводят один JSON-документ в stdout приложения; диагностика и сообщения `validate` выводятся в stderr. Запуск через Gradle добавляет служебные сообщения в общий вывод. Для машинного потребления JSON нужно запускать установленный launcher отдельным процессом из корня репозитория с теми же аргументами, например `run examples/retry-storm.json`, и парсить только его stdout.

Основной документ: [проектный дизайн](docs/superpowers/specs/2026-10-25-resilience-lab-design.md). Он содержит цели, границы MVP, модельную семантику, критерии результата и рассмотренные альтернативы.

[Продуктовое видение](docs/product/2026-10-27-product-vision.md): основной пользователь, его задачи, принципы продукта, раскладка интерфейса, модель сервиса, иерархия блоков, сквозной кейс и порядок этапов после MVP.

## Устойчивые решения

- Все JVM-модули используют JDK 25.
- Ядро на Kotlin/JVM с использованием KSL/KSLCore.
- Backend на Spring Boot 4.1.2, без добавления второго web-фреймворка.
- Приложение распространяется под GPLv3.
- Браузерный UI отделён от вычислительного ядра; симуляция запускается и без UI.
- Собственный универсальный дискретно-событийный движок не разрабатывается.
- Модели MiSim используются как справочная семантика блоков, отображаемая на KSL, а не как переносимый DESMO-J код или готовый тестовый оракул.
- Эксперименты воспроизводятся по конфигурации и случайным seed/stream; независимые повторения обязательны.
- В `MetricSummary` поля `mean`, `min` и `max` описывают наблюдаемые значения метрики; доверительные границы Стьюдента `ci95Low`/`ci95High` не обрезаются до физического диапазона и могут выходить за `[0,1]`, в том числе для `successRate`.
- В репозиторий не помещаются секреты, производственные адреса, клиентские идентификаторы или реальные конфиденциальные данные.

## Границы MVP

Первая версия моделирует линейную цепочку синхронных вызовов с ограниченными обработчиками и очередями, timeout, retry, backoff, jitter и общим deadline. Первый законченный эксперимент исследует деградацию сервиса и retry amplification.

Не расширять MVP до произвольных графов, брокеров, баз данных или автоматической калибровки без отдельного согласования. Точная семантика попыток, orphaned work, измерений и метрик определяется проектным дизайном.

## Обязательное развитие после MVP

Предметная модель должна развиваться до асинхронных взаимодействий, gRPC, RabbitMQ/Kafka, баз данных, Redis и других компонентов реальных программных архитектур. После MVP также обязателен универсальный Graph UI для рисования архитектурных схем реальных систем с произвольными топологиями и новыми типами узлов и связей. Порядок и глубина моделирования согласовываются отдельными этапами. Ограничения MVP не должны становиться архитектурным запретом на такие расширения.

## Соглашения по коду

- Kotlin-код размещать в пакете `resiliencelab` и его подпакетах.
- В тестах использовать AssertJ для утверждений.
- Публичные API и нетривиальные контракты документировать с помощью KDoc.

## Правила работы

- Сначала проверять проектный дизайн и фактические manifest/build-файлы.
- Не добавлять зависимости по предположению о доступности; использовать совместимые версии и идиомы выбранного toolchain.
- Сохранять сценарии версионируемыми и воспроизводимыми.
- При изменении поведения обновлять проектный дизайн, устаревшие комментарии и этот файл, если затронуты записанные здесь правила.
- При изменении toolchain или команд сборки и проверки синхронно обновлять этот файл.

## Работа по issue

`AGENTS.md` — единственный источник правил для агентов. В шаблонах и других файлах ссылайся на него, не копируй правила.

Репозиторий публичный. Не включай в файлы, сообщения коммитов и PR секреты, производственные данные, реальные клиентские идентификаторы, внутренние названия компаний и систем. Для примеров используй вымышленные данные.

1. Прочитай issue целиком, комментарии, этот файл и связанные документы. Сверь постановку с проектным дизайном и продуктовым видением по ссылкам выше; уточняй только то, чего эти источники не объясняют.
2. Проверь `git status`; не перезаписывай чужие незакоммиченные изменения. Выполни `git fetch origin` и создай отдельную ветку от актуального `main`: `git switch -c <имя-ветки> origin/main`. Не работай в `main` или ветке другой задачи.
3. Меняй только то, что нужно для issue. Сторонние ошибки и технический долг перечисли в PR; не исправляй их в той же задаче.
4. Проверь изменения по затронутым областям, как указано ниже. Создавай коммиты в стиле Conventional Commits на английском, например `docs: add agent task templates`.
   В коммитах с участием Codex сохраняй автора-человека и добавляй трейлер `Co-authored-by: Codex <codex@openai.com>`. При squash сохраняй этот трейлер в итоговом сообщении коммита.
5. Перед PR снова выполни `git fetch origin` и `git rebase origin/main`, сохранив актуальные изменения `main`. Если после rebase изменился результат работы или были конфликты, повтори соответствующие проверки.
6. Отправь ветку командой `git push -u origin HEAD` и открой PR в `main`: `gh pr create --base main`. В описании укажи `Closes #N`, заменив `N` номером issue. Самостоятельно не мержи PR.

Перед PR проверь конечное состояние ветки:

- Всегда: `git diff --check origin/main` и просмотр diff относительно `origin/main`, чтобы исключить посторонние изменения.
- JVM-код, зависимости или сборка JVM-модулей: `./gradlew clean build` из корня. Команда включает тесты, KtLint и проверку покрытия.
- Web-код, зависимости или сборка web: из `web` выполни `npm ci`, `npm run lint`, `npm test -- --run` и `npm run build`.
- Взаимодействие UI и API, пользовательские сценарии, E2E-тесты или их запуск: из `web` выполни `npm run test:e2e`. Подготовка окружения и установка Chromium описаны в разделе стандартных команд выше.
- Только документация или шаблоны: проверь ссылки, Markdown и YAML-заголовок шаблона issue. Сборка приложения для таких изменений не требуется.

В описании PR объясни, что изменено и зачем; перечисли команды проверок и их результаты, а также то, что проверить не удалось, с причиной. Отдельно укажи найденное попутно или напиши, что таких находок нет. Не называй проверку пройденной, если её результат неизвестен.
