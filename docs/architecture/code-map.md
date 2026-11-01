# Карта кода

Карта помогает выбрать слой изменения и проследить путь данных в текущем коде. Поведение описано в [дизайне этапа 1](../superpowers/specs/2026-10-27-stage-1-design.md) и связанных дизайнах срезов, модельная семантика — в [дизайне MVP](../superpowers/specs/2026-10-25-resilience-lab-design.md), формат данных — в [формате артефакта](../results-format.md), решения — в [целевой архитектуре](2026-10-27-target-architecture.md) и [ADR](adr/).

## Модули и границы

- [`core`](../../core/) содержит модель, проверку, расчёт и хранение. Он не зависит от приложений, Spring или React.
- [`apps:cli`](../../apps/cli/) и [`apps:server`](../../apps/server/) зависят от `core` и вызывают общий [`Lab`][lab]. Вход CLI — [`main`][cli]; сервер добавляет HTTP, состояние заданий и конфигурацию Spring. Логика модели остаётся в ядре.
- [`web`](../../web/) — отдельное приложение React/Vite. Оно работает с сервером через [`apiClient.ts`][api-client] и сгенерированные типы API; файлы рабочей области читает сервер. В web находятся редактирование и представление результатов, но не симуляция и не полная проверка модели.

## Пакеты и каталоги

Пакеты в [`core/src/main/kotlin/resiliencelab/core`](../../core/src/main/kotlin/resiliencelab/core/):

| Пакет | Ответственность и граница |
|---|---|
| `catalog` | Типы, параметры, порты, единицы и выходы. Описывает контракт, не исполняет блоки. |
| `document` | Документы, строгий JSON, версии и генерация схем. Семантическая проверка находится в `compiler`. |
| `compiler` | Переопределения, проверка параметров и графа, разворачивание реплик, IR и диагностика. Не запускает KSL. |
| `ir` | Типизированный граф, параметры и происхождение элементов. Не зависит от JSON-документов и KSL. |
| `engine/ksl` | Исполнение IR, ресурсы, политики, случайные потоки и сборщики метрик. Не управляет файлами прогонов. |
| `execution` | Задачи «вариант × точка × повторение», общий планировщик, отмена и оценка стоимости. HTTP-задания принадлежат серверу. |
| `experiment` | Итоги повторения, скетчи задержек, статистическая агрегация и группы реплик. Не записывает артефакт. |
| `results` | Ряды, части, индексы, запись/чтение артефакта, досчёт, насыщение и запас ёмкости. Не исполняет запросы модели. |
| `workspace` | Хранилище файлов, версии, операции записи и внешние изменения. Не компилирует документы. |
| `lab` | Фасад проверки, оценки, запуска и досчёта; связывает остальные пакеты. Не содержит HTTP-контроллеров. |

В [`apps/server/src/main/kotlin/resiliencelab/server`](../../apps/server/src/main/kotlin/resiliencelab/server/) пакет `server` запускает Spring Boot; `server.lab` содержит контроллеры, DTO, обработку ошибок, `JobService` и связывание зависимостей. Состояние заданий живёт в процессе сервера, артефакты — в хранилище ядра.

Каталоги в [`web/src`](../../web/src/); связывает их [`App`][app]:

| Каталог | Ответственность и граница |
|---|---|
| `api` | HTTP, версии и типы API; состояние редактора хранит `workspace`. |
| `assets` | SVG-значки; React-компоненты значков находятся в `layout`. |
| `canvas` | React Flow, узлы, связи, порты и геометрия; изменения документов выполняют команды `workspace`. |
| `components` | Общие диалоги и состояние доступности сервера; предметные формы находятся в `inspector`. |
| `experiment` | Ход эксперимента, нагрузка и интервалы отказов; команды документов находятся в `workspace`. |
| `help` | Справка из каталога; определения типов принадлежат ядру. |
| `i18n` | Переводы, язык и форматирование; идентификаторы документов не переводит. |
| `inspector` | Формы и результаты выбранного элемента; загрузка рядов находится в `results/series`. |
| `layout` | Панели, меню, палитра, Summary/Answer/Problems; подготовка данных находится в `results`. |
| `presentation` | Подписи и контекст диагностик; словари находятся в `i18n`. |
| `results` | Проекции итогов, выбор, Map; `series`, `timeline`, `playback` — загрузка, графики и курсор. Заданиями управляет `run`. |
| `run` | Запуск, опрос, отмена, восстановление, досчёт и оценка; документы редактирует `workspace`. |
| `test` | Общие фикстуры и настройка Vitest; E2E с сервером находятся в `web/e2e`. |
| `validation` | Проверка черновиков через API и адресация диагностик; правила модели исполняет ядро. |
| `workspace` | Документы, версии, команды, Undo/Redo, переименования и параметры; выбор результатов хранится отдельно. |

## Главные потоки

### Документы и расчёт

1. [`Lab.loadDocuments`][lab] читает эксперимент и его ссылки через [`Workspace`][workspace]. [`DocumentCodec`][codec] проверяет JSON и версии. [`ModelCompiler.compile`][compiler] применяет варианты и сетку, проверяет модель и разворачивает реплики в [`GraphIr`][ir]; `Lab.validate` добавляет [`ModelLinter`][linter].
2. [`Lab.run`][lab] вызывает [`ExperimentExecutor.run`][executor]. Каждое повторение получает свежую модель KSL; [`ReliabilityModel.runReplication`][engine] возвращает итоги [`MetricsCollector`][metrics], а [`WindowCollector`][windows] передаёт закрытые окна через callback.
3. [`SeriesWriter`][series] пишет части и индекс; его детектор потоково считает путь деградации. [`ArtifactWriter`][artifact] сохраняет путь вместе с итогами повторения. Его `summarize` параллельно читает итоги повторений и собирает сводку через [`MetricsAggregator`][aggregator] и анализаторы выводов в общем пуле исполнителя; затем публикуются сводка и манифест. Итоги когорты и временные окна собираются отдельно.

### Задание через API

1. `POST /api/v1/jobs`: [`JobController.submitJob`][job-controller] вызывает [`JobService.submit`][jobs]. Тот проверяет эксперимент, запоминает версии документов и ставит работу в исполнитель из [`LabConfiguration`][configuration]. Потоки расчёта принадлежат общему `ExperimentExecutor` ядра.
2. `JobService` вызывает `Lab.run`; callback обновляет прогресс для `GET /api/v1/jobs/{id}`. Отмена проходит через `JobController.cancelJob`, `JobService.cancel` и сигнал `isCancelled` в ядро; сохранение неполного артефакта завершает `Lab`.
3. `POST /api/v1/runs/{id}/resume`: [`RunController.resumeRun`][run-controller], `JobService.resume`, `Lab.validateResume` и `Lab.resume`. Проверка сохранённых задач находится в [`ResumeArtifact.kt`][resume]; досчитываются отсутствующие или повреждённые задачи того же прогона.

### Документы в web

1. [`useWorkspace`][use-workspace] загружает каталог и документы через `api`; `loadExperiment` разрешает ссылки и сохраняет версии.
2. Команды [`EditorCommand`][editor] преобразуют документы; `execute` передаёт их в `editorReducer`. История снимков обеспечивает Undo/Redo; сохранённые версии учитываются отдельно.
3. [`useValidation`][validation] отправляет черновики в `/api/v1/validate`. Независимо от проверки `useWorkspace.save` пишет изменённые документы через `api.saveDocument` с `If-Match`; [`DocumentController`][document-controller] проверяет запись. `App.startRun` проверяет готовность, сохраняет изменения через `useWorkspace.save` и запускает задание через [`useRun.run`][use-run].

### Результаты в web

1. `useRun` загружает манифест и сводку. В `App` вариант задаёт `variantPage`; [`useResultsSelection`][selection] хранит точку, повторение, окно и реплику. [`canvasResults`][canvas-results] проецирует выбранный итог и снимок параметров прогона на схему; [`ElementResults`][element-results] показывает выбранный элемент.
2. [`RunTimeline`][timeline] и [`usePlayback`][playback] используют [`SeriesLoader`][loader]: индекс, выбор частей диапазона, общий кэш, [`series.worker.ts`][worker] и [`decode.ts`][decode]. [`outputs.ts`][outputs] вычисляет метрики каталога для графиков и инспектора.
3. Закреплённый курсор Timeline через `App` вызывает `usePlayback.seek`; `windowCanvasResults` превращает окно в слой схемы. Воспроизведение подгружает текущий и следующий диапазоны; наведение на график имеет отдельный временный курсор. Популяции клиентов и классов, включая причины отказов, показывает [`EntryResults`][entry-results].

## Как добавить

### Тип блока

- Зарегистрировать тип, параметры, порты, выходы и допустимые связи в [`Stage1Catalog`][catalog]. Дополнить `ModelCompiler`, типизированный `GraphIr` и исполнение в `engine/ksl`; новые случайные источники включить в [`PathStreams.kt`][streams]. При новых метриках пройти рецепт поля результата ниже.
- Проверить создание через [`structure.ts`][structure] и формы [`Inspector`][inspector]. Вид задают [`BlockNode`][block-node], [`BlockIcon`][block-icon], [`BlockShape`][block-shape] и [`blockGeometry.ts`][geometry]; новая семья агрегатов требует проверки `canvasResults` и `ElementResults`. Обновить переводы и снимок каталога, пересоздать схемы/API; проверить `Stage1CatalogTest` и тесты компилятора/движка. Одной регистрации типа для исполнения недостаточно.

### Параметр или объект политики

- Описать [`ParamDescriptor`][catalog-contract] и подключить его в `Stage1Catalog`; образцы объектов — [`CallPolicyParameters`][call-policies] и [`ServicePolicyParameters`][service-policies]. Чтение и межполевые ограничения находятся в [`ParamReader`][param-reader]/`ModelCompiler`, значение — в IR, поведение — в движке. Для групп проверить передачу настройки в [`ReplicaExpansion.kt`][replicas]; состояние политики размещать по [ADR 0015](adr/0015-resilience-policies.md).
- Формы строит [`ParamField`][param-field]; умолчания и применимость — [`initialParams.ts`][initial-params] и [`parameterApplicability.ts`][applicability], разбор и значения — [`paramParsing.ts`][param-parsing]/[`parameterValues.ts`][parameter-values], запись — `editor.ts` и [`experimentCommands.ts`][experiment-commands]. Проверить вложенные переопределения и [`policyParameters.ts`][policy-parameters]: перечисленные там `readOnlyPolicies` пока нельзя редактировать. Обновить переводы, снимок каталога и схемы/API.
- Если меняется структура документа, нужны [`Documents.kt`][documents], версия в `DocumentCodec`, примеры и фикстуры. Параметры каталога хранятся в обобщённом `params` и не требуют нового поля документа для каждого параметра.

### Выход каталога и его показ

- По [ADR 0011](adr/0011-type-outputs.md) описать выход в [`Stage1Outputs`][stage-outputs] либо специализированном файле выходов и подключить через `TypeDescriptor.outputs`: расчёт, источник сводки, нужные `timeline`/`inspector`/`overlay`. Обновить снимок каталога и переводы `catalog.types.<typeId>.outputs.<id>.*`.
- Существующие данные и операции обслуживает `outputs.ts`; новая операция меняет контракт [`Outputs.kt`][outputs-contract] и интерпретатор в `outputs.ts`. Для выхода политики проверить `policyOutputAvailable` в `policyParameters.ts`. Потребители — `RunTimeline`, [`elementResultsData.ts`][element-data], `canvasResults`; проверки — [`Stage1CatalogTest`][catalog-test] и [`catalogOutputs.test.tsx`][outputs-test]. Новое измерение требует рецепта поля ниже.

### Сообщение ядра

- Добавить контракт и аргументы в [`CoreMessage`][messages], использовать его в месте выдачи диагностики с документом, указателем и вариантом. Обновить `messages.<code>[.<reason>]` в [`en.json`][en]/[`ru.json`][ru]; отображение выполняет [`backendMessage.ts`][backend-message].
- Проверить [`MessageContractTest`][message-test], [`backendMessageCoverage.test.ts`][message-coverage] и тест места выдачи. Эти проверки читают реестр кодов; отдельный список переводимых сообщений не нужен.

### Причину отказа

- Задать стабильный `failureReason` в [`AttemptOutcome`][outcome], возникновение и передачу исхода в движке/[`CallAttempt`][call-attempt]; проверить [`MetricsCollector`][metrics], [`ConnectionCollector`][connection-metrics] и `WindowCollector`. Словари причин проходят через [`ResultModels.kt`][result-models], `WindowSeries.kt`, `MetricsAggregator` и [`ReplicaGroups`][replica-groups].
- Если причина допускает fallback, дополнить `fallback.on` в `CallPolicyParameters` и перевод `catalog.options.<reason>`. Перевести `messages.<reason>` в обоих языках; [`entries.ts`][entries] и `EntryResults` показывают сохранённые причины. Это отдельный от `CoreMessage` контракт исходов расчёта.

### Поле итогов повторения или рядов

- Итоги когорты определены в `ResultModels.kt`, окна времени — в [`WindowSeries.kt`][series]. Добавить сбор/сброс поля в соответствующий сборщик; проверить оба пути агрегации: `MetricsAggregator` и `ReplicaGroups`. `ArtifactWriter` и `SeriesWriter` записывают эти структуры.
- При смене формата повысить соответствующие константы [`Versions`][artifact], обновить формат артефакта, фикстуры и эталон рядов; пересоздать OpenAPI/TS. В web проверить [`types.ts`][series-types], `decode.ts`, `loader.ts`, проекцию и выход каталога. Обычные сырые поля декодер сохраняет через spread, задержки преобразует отдельно.
- Если меняется количество или размер строк, проверить [`CostEstimator`][estimator] и учёт памяти в `SeriesLoader`. Регрессии проверяют [`WebSeriesGoldenTest`][golden-test], тесты агрегации, групп и артефактов.

### Пересоздание производных файлов

Запускать нужные команды из корня; источник команд — [корневой AGENTS.md](../../AGENTS.md), [правила сервера](../../apps/server/AGENTS.md), [правила web](../../web/AGENTS.md) и [инструкция переводов](../../web/src/i18n/README.md). Производные файлы вручную не правятся.

```sh
UPDATE_SCHEMAS=1 ./gradlew :core:test --tests 'resiliencelab.core.document.DocumentSchemasTest' --rerun
UPDATE_OPENAPI=1 ./gradlew :apps:server:test --tests 'resiliencelab.server.lab.OpenApiSpecTest' --rerun
(cd web && npm run api:types)
UPDATE_SERIES_GOLDEN=1 ./gradlew :core:test --tests 'resiliencelab.core.results.WebSeriesGoldenTest' --rerun
./gradlew :apps:cli:installDist
apps/cli/build/install/cli/bin/cli catalog > web/src/test/catalog.json
```

[lab]: ../../core/src/main/kotlin/resiliencelab/core/lab/Lab.kt
[cli]: ../../apps/cli/src/main/kotlin/resiliencelab/cli/Main.kt
[api-client]: ../../web/src/api/apiClient.ts
[app]: ../../web/src/App.tsx
[workspace]: ../../core/src/main/kotlin/resiliencelab/core/workspace/Workspace.kt
[codec]: ../../core/src/main/kotlin/resiliencelab/core/document/DocumentCodec.kt
[compiler]: ../../core/src/main/kotlin/resiliencelab/core/compiler/ModelCompiler.kt
[ir]: ../../core/src/main/kotlin/resiliencelab/core/ir/GraphIr.kt
[linter]: ../../core/src/main/kotlin/resiliencelab/core/compiler/ModelLinter.kt
[executor]: ../../core/src/main/kotlin/resiliencelab/core/execution/ExperimentExecutor.kt
[engine]: ../../core/src/main/kotlin/resiliencelab/core/engine/ksl/ReliabilityModel.kt
[metrics]: ../../core/src/main/kotlin/resiliencelab/core/engine/ksl/MetricsCollector.kt
[windows]: ../../core/src/main/kotlin/resiliencelab/core/engine/ksl/WindowCollector.kt
[series]: ../../core/src/main/kotlin/resiliencelab/core/results/WindowSeries.kt
[artifact]: ../../core/src/main/kotlin/resiliencelab/core/results/RunArtifact.kt
[aggregator]: ../../core/src/main/kotlin/resiliencelab/core/experiment/MetricsAggregator.kt
[job-controller]: ../../apps/server/src/main/kotlin/resiliencelab/server/lab/JobController.kt
[jobs]: ../../apps/server/src/main/kotlin/resiliencelab/server/lab/JobService.kt
[configuration]: ../../apps/server/src/main/kotlin/resiliencelab/server/lab/LabConfiguration.kt
[run-controller]: ../../apps/server/src/main/kotlin/resiliencelab/server/lab/RunController.kt
[resume]: ../../core/src/main/kotlin/resiliencelab/core/results/ResumeArtifact.kt
[use-workspace]: ../../web/src/workspace/useWorkspace.ts
[editor]: ../../web/src/workspace/editor.ts
[validation]: ../../web/src/validation/useValidation.ts
[document-controller]: ../../apps/server/src/main/kotlin/resiliencelab/server/lab/DocumentController.kt
[use-run]: ../../web/src/run/useRun.ts
[selection]: ../../web/src/results/selection.ts
[canvas-results]: ../../web/src/results/canvasResults.ts
[element-results]: ../../web/src/inspector/ElementResults.tsx
[timeline]: ../../web/src/results/timeline/Timeline.tsx
[playback]: ../../web/src/results/playback/usePlayback.ts
[loader]: ../../web/src/results/series/loader.ts
[worker]: ../../web/src/results/series/series.worker.ts
[decode]: ../../web/src/results/series/decode.ts
[outputs]: ../../web/src/results/outputs.ts
[entry-results]: ../../web/src/results/EntryResults.tsx
[catalog]: ../../core/src/main/kotlin/resiliencelab/core/catalog/Stage1Catalog.kt
[streams]: ../../core/src/main/kotlin/resiliencelab/core/engine/ksl/PathStreams.kt
[structure]: ../../web/src/workspace/structure.ts
[inspector]: ../../web/src/inspector/Inspector.tsx
[block-node]: ../../web/src/canvas/BlockNode.tsx
[block-icon]: ../../web/src/layout/BlockIcon.tsx
[block-shape]: ../../web/src/canvas/BlockShape.tsx
[geometry]: ../../web/src/canvas/blockGeometry.ts
[catalog-contract]: ../../core/src/main/kotlin/resiliencelab/core/catalog/Catalog.kt
[call-policies]: ../../core/src/main/kotlin/resiliencelab/core/catalog/CallPolicyParameters.kt
[service-policies]: ../../core/src/main/kotlin/resiliencelab/core/catalog/ServicePolicyParameters.kt
[param-reader]: ../../core/src/main/kotlin/resiliencelab/core/compiler/ParamReader.kt
[replicas]: ../../core/src/main/kotlin/resiliencelab/core/compiler/ReplicaExpansion.kt
[param-field]: ../../web/src/inspector/ParamField.tsx
[initial-params]: ../../web/src/workspace/initialParams.ts
[applicability]: ../../web/src/workspace/parameterApplicability.ts
[param-parsing]: ../../web/src/workspace/paramParsing.ts
[parameter-values]: ../../web/src/workspace/parameterValues.ts
[experiment-commands]: ../../web/src/workspace/experimentCommands.ts
[policy-parameters]: ../../web/src/workspace/policyParameters.ts
[documents]: ../../core/src/main/kotlin/resiliencelab/core/document/Documents.kt
[stage-outputs]: ../../core/src/main/kotlin/resiliencelab/core/catalog/Stage1Outputs.kt
[outputs-contract]: ../../core/src/main/kotlin/resiliencelab/core/catalog/Outputs.kt
[element-data]: ../../web/src/inspector/elementResultsData.ts
[catalog-test]: ../../core/src/test/kotlin/resiliencelab/core/catalog/Stage1CatalogTest.kt
[outputs-test]: ../../web/src/results/catalogOutputs.test.tsx
[messages]: ../../core/src/main/kotlin/resiliencelab/core/compiler/CoreMessage.kt
[en]: ../../web/src/i18n/en.json
[ru]: ../../web/src/i18n/ru.json
[backend-message]: ../../web/src/i18n/backendMessage.ts
[message-test]: ../../core/src/test/kotlin/resiliencelab/core/compiler/MessageContractTest.kt
[message-coverage]: ../../web/src/i18n/backendMessageCoverage.test.ts
[outcome]: ../../core/src/main/kotlin/resiliencelab/core/engine/ksl/AttemptOutcome.kt
[call-attempt]: ../../core/src/main/kotlin/resiliencelab/core/engine/ksl/CallAttempt.kt
[connection-metrics]: ../../core/src/main/kotlin/resiliencelab/core/engine/ksl/ConnectionCollector.kt
[result-models]: ../../core/src/main/kotlin/resiliencelab/core/experiment/ResultModels.kt
[replica-groups]: ../../core/src/main/kotlin/resiliencelab/core/experiment/ReplicaGroups.kt
[entries]: ../../web/src/results/entries.ts
[series-types]: ../../web/src/results/series/types.ts
[estimator]: ../../core/src/main/kotlin/resiliencelab/core/execution/CostEstimator.kt
[golden-test]: ../../core/src/test/kotlin/resiliencelab/core/results/WebSeriesGoldenTest.kt
