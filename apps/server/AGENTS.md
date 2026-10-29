# apps/server/AGENTS.md

Правила для backend. Дополняют [корневой AGENTS.md](../../AGENTS.md); общие правила работы по issue — там. Поведение ручек описано в [дизайне этапа 1](../../docs/superpowers/specs/2026-10-27-stage-1-design.md) (§5) и в `openapi.json`.

## Команды

Из корня репозитория:

- `./gradlew :apps:server:test` — тесты backend.
- `./gradlew :apps:server:bootRun` — API на `http://127.0.0.1:8080/api/v1` с рабочей областью `examples/`; другой каталог — `RESILIENCE_LAB_WORKSPACE=<каталог>` или `--args='--resilience-lab.workspace=<каталог>'`.
- `./gradlew :apps:server:bootRunE2e` — сервер для E2E на свежей копии `examples/` в `apps/server/build/e2e-workspace/`, порт из `E2E_BACKEND_PORT`.
- `UPDATE_OPENAPI=1 ./gradlew :apps:server:test --tests 'resiliencelab.server.lab.OpenApiSpecTest' --rerun` — пересоздать `openapi.json`. Затем из `web` — `npm run api:types`.

## Контракт API

- API только расширяется: существующие ручки и поля не меняют смысла (ADR 0010). Изменение API — это изменение `openapi.json` и TS-типов web в том же PR; оба файла пересоздаются генераторами, а не правятся вручную.
- Типы API — `@Serializable` data-классы и enum без `@SerialName`, `@Transient`, собственных сериализаторов и полиморфизма. Ответы содержат все поля, отсутствующее значение — `null`. Имена методов контроллеров уникальны. Схему строит springdoc по свойствам Kotlin, JSON пишет kotlinx; тест `OpenApiConformance` сверяет ответы со схемой.
- Ошибки — `ApiProblem` со стабильным кодом; новые коды перечисляются в KDoc `LabExceptionHandler` и в описании PR.
- Параметры пути и запроса проверяются: выход за рабочую область или каталог прогона невозможен, неизвестный объект — 404, а не 500.
- API и CLI вызывают одни и те же методы `Lab` и выдают одинаковую диагностику с теми же кодами.
- Задания живут в памяти процесса и не переживают перезапуск; всё, что должно пережить перезапуск, опирается на прогон в `.results/`.
