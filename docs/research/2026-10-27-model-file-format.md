# S2: формат файлов модели для git

Дата: 2026-10-27. Статус: рекомендация по A1, не принятое архитектурное решение.
Задача: [#47](https://github.com/ChernetsovNG/resilience-lab/issues/47).
Контекст: [дизайн MVP](../superpowers/specs/2026-10-25-resilience-lab-design.md),
[продуктовое видение, §5.7](../product/2026-10-27-product-vision.md#57-иерархия-блоков),
[черновик целевой архитектуры в PR #45](https://github.com/ChernetsovNG/resilience-lab/pull/45).

## Рекомендация

Для A1 предлагаю **JSON с JSON Schema Draft 2020-12**, отдельные файлы модели,
раскладки и эксперимента, каталог библиотечных блоков. Объяснения, которые должны
переживать сохранение из UI, хранить в полях `description`/`notes` будущей схемы.
Схему генерировать из сериализуемых Kotlin-типов через существующий
`kotlinx-schema`, дополняя предметными метаданными из будущего каталога A2.

Причина выбора: нынешнее ядро уже использует kotlinx.serialization, браузер
работает с JSON, а место записи файлов A6 ещё не выбрано. Разделение файлов и
стабильные ID дают малошумные диффы в обоих форматах. JSON позволяет сохранять
документ из типизированных данных без отдельной модели комментариев. Цена:
больше пунктуации и отсутствие комментариев непосредственно возле параметра.

**YAML остаётся обоснованной альтернативой, если такие комментарии обязательны.**
Прототип подтвердил их сохранение через npm `yaml` Document и SnakeYAML Engine
AST на JVM. Это потребует хранить исходное дерево рядом с данными, изменять
нужные узлы и проверять сохранение комментариев при всех командах редактора.
Обычный цикл «разобрать в объект, изменить, сериализовать» их теряет.
Синхронно поддерживать два редактируемых представления одной модели не предлагается.

Три независимых исследователя изучили библиотеки JVM, спецификации и текущие
контракты. Исследователь форматов предпочёл YAML при обязательном сохранении
комментариев; разведка контракта предпочла JSON. Рекомендация выше учитывает
открытое A6 и стоимость обоих способов записи. Прототип не меняет приложение,
не вводит новый формат в API и не закрывает решение A6.

## Что сравнивалось

Исходная ревизия `main`: `37710289be93ab37b4424c07b98547e13224c640`.
Исходный пример: [retry-storm.json](../../examples/retry-storm.json);
его SHA-256 записан в [результатах JS][js-checks].

| Критерий | JSON | YAML 1.2 |
|---|---|---|
| Чтение и ручная правка | Явные скобки и типы; больше пунктуации | Компактнее; отступы и разрешение скалярных значений требуют внимания |
| Комментарии при записи программой | Синтаксиса комментариев нет; текстовые поля сохраняются как данные | Document/AST сохраняет проверенные комментарии; запись из DTO теряет их |
| Детерминированная запись | Нужна политика порядка, чисел, отступов и LF; повторная запись проверена | Та же потребность; дополнительно стили скаляров, комментарии и исходное дерево |
| Слияние Git | Независимые правки слились, два разных timeout дали конфликт | В тех же пробах такой же результат; при добавлении узла меньше строк |
| JSON Schema и редакторы | Прямая проверка; VS Code имеет встроенную поддержку | Та же схема после разбора в JSON-совместимые значения; нужен YAML language server |
| Схема из Kotlin | Генерируется из `SerialDescriptor` | Генерируется та же схема значений; синтаксические ограничения YAML проверяются отдельно |
| Ссылки между файлами | Нужен явный `modelRef`/`libraryRef` и resolver | То же; anchors не заменяют ссылки на библиотечные файлы |
| Тысячи блоков | В измерениях разбор быстрее | В измерениях текст меньше, разбор медленнее; это не предел размера модели |

Основания стандартов: [RFC 8259, §4–6](https://www.rfc-editor.org/rfc/rfc8259.html#section-4)
и [модели информации YAML 1.2.2](https://yaml.org/spec/1.2.2/#32-information-models).
Оба формата имеют упорядоченные последовательности; порядок полей объекта не
должен определять модельную семантику. Детерминированный текст обеспечивает
конкретная программа записи, а не название формата.

TOML и KDL не добавлены в исполняемый прототип. У [TOML](https://toml.io/en/v1.1.0#keyvalue-pair)
нет значения null, зато есть даты; понадобилось бы новое отображение текущих
nullable-типов и вложенных графов. [KDL](https://kdl.dev/) вводит собственную
модель узлов и схему. Для требований задачи не найдено преимущества, которое
оправдало бы третий контракт. JSONC также потребовал бы отдельного парсера и
политики сохранения комментариев; стандартным JSON он не является.

## Проверенные библиотеки

JVM: JDK 25.0.3, Kotlin и serialization plugin 2.4.21, Gradle 9.8.2.
JS: Node.js 26.12.1 из `web/.nvmrc`, npm 11.20.0, TypeScript 6.0.2
(`npm:@typescript/typescript6`). Эти значения проверены исполнением, не только
сопоставлением номеров версий. Зависимости исследовательского проекта закреплены
отдельно от приложения.

| Библиотека | Проверка прототипом | Вывод |
|---|---|---|
| kotlinx.serialization JSON 1.12.0 | Типизированное чтение/запись, null/default, числа, дубли, порядок map | Оставить сериализацию типов; синтаксическая и числовая проверка нужны отдельно |
| Jackson Kotlin 2.21.7 | Чтение/запись, сортировка map, строгая проверка дублей | Возможный строгий parser на JVM; Jackson-аннотации не совпадают с `@SerialName` |
| kaml 0.104.0 | Typed YAML, sealed-тип, unknown keys/дубли, потеря комментариев | Совместим в проверенных операциях, но upstream архивирован; не выбирать для новой долгоживущей записи |
| SnakeYAML Engine 3.2 | Load/Dump и Compose/Serialize/Present, комментарии, повторная запись | JVM-альтернатива для YAML с отдельным AST и валидацией входа |
| npm `yaml` 2.9.1 | parse/stringify и Document, комментарии, ограничение синтаксиса, browser bundle | Рабочая альтернатива для браузера; типизирована для TypeScript |
| kotlinx-schema 0.6.0 | Схема из сериализатора, enum, nullable, sealed discriminator | Предпочтительный источник структурной схемы |
| Victools 4.38.0 + Jackson module | Схема того же probe-типа | В проверенной конфигурации теряет kotlinx-имена и часть Kotlin-контракта |
| AJV 8.20.0 | Draft 2020-12, хорошие/плохие примеры с Kotlin-схемой, browser bundle | Проверка в JS; coercion/default insertion не включены |

Точный `com.fasterxml.jackson` 2.21.7 подтверждён
[dependencyInsight сервера][jackson-dependency]. Spring Boot 4.1.2 сам по себе
не означает, что объявленная в проекте зависимость уже относится к Jackson 3.
[BOM Boot](https://repo.maven.apache.org/maven2/org/springframework/boot/spring-boot-dependencies/4.1.2/spring-boot-dependencies-4.1.2.pom)
управляет обеими линиями отдельно.

У `kotlinx-schema` опубликованный POM объявляет serialization 1.11.0/Kotlin
2.3.21, у kaml — 1.9.0/2.2.21. Разрешение зависимостей до 1.12.0/2.4.21 и
операции прототипа прошли. Это не официальная матрица поддержки. POM URL и
контрольные суммы сохранены в [maven-provenance.json][provenance].

Первичные сведения о назначении и API: [kotlinx.serialization](https://kotlinlang.org/docs/serialization.html),
[Jackson Kotlin](https://github.com/FasterXML/jackson-module-kotlin),
[kaml и статус поддержки](https://github.com/charleskorn/kaml),
[SnakeYAML Engine](https://github.com/snakeyaml/snakeyaml-engine),
[стабильная документация yaml@2](https://eemeli.org/yaml/),
[Victools](https://github.com/victools/jsonschema-generator),
[AJV и диалекты схем](https://ajv.js.org/json-schema.html#draft-2020-12).
В [JVM README][jvm-readme] есть ссылки на исходники именно испытанных версий.

## Разделение исходного примера

Оба набора находятся в [fixtures/json][json-fixtures] и [fixtures/yaml][yaml-fixtures].
Для каждого варианта создан свой файл модели; одинаковый сервис `dependency`
вынесен в один библиотечный шаблон. Это минимальная проверка механизма ссылок,
а не реализация составных блоков с портами и масками.

| Файл | Содержимое |
|---|---|
| `models/baseline.json`, `models/candidate.json` | entry, сервисы и связи по ID, исходный порядок массивов |
| `library/dependency.json` | Параметры общего сервиса и пояснение `description` |
| `layout.json` | Координаты блоков по ID |
| `experiment.json` | execution, варианты, ссылки на модель/раскладку, нагрузка и деградация |

В YAML структура та же, расширение `.yaml`. `schemaVersion: research-1`
явно отличает прототип от формата приложения. Координаты созданы заново по
формуле текущего холста `(index * 260, 100)`: исходный JSON раскладки не содержит.

Настоящий файл библиотечного блока в двух форматах:

```json
{
  "description": "Shared dependency from the original retry-storm example.",
  "kind": "service-template",
  "schemaVersion": "research-1",
  "service": {
    "failureRate": 0,
    "handlers": 2,
    "processing": {
      "kind": "FIXED",
      "meanMs": 8
    },
    "queueCapacity": 8
  }
}
```

```yaml
description: Shared dependency from the original retry-storm example.
kind: service-template
schemaVersion: research-1
service:
  failureRate: 0
  handlers: 2
  processing:
    kind: FIXED
    meanMs: 8
  queueCapacity: 8
```

`libraryRef: ../library/dependency.yaml` разрешается относительно файла модели.
`modelRef` и `layoutRef` в эксперименте разрешаются относительно эксперимента.
Проверены существующая ссылка, отсутствующий файл, цикл, выход выше корня и
запрет URL. Resolver работает с файлами в памяти; защита реальной файловой
системы от симлинков здесь не проверялась.

JSON Schema [`$ref`](https://json-schema.org/understanding-json-schema/structuring#ref)
ссылается на схему, не загружает экземпляр модели. Поэтому библиотечные ссылки
должны обрабатываться будущим компилятором A3. Для воспроизводимости потребуется
учитывать содержимое транзитивных библиотечных файлов в снимке/хеше запуска;
это предложение для A3/A7, не реализованная функция.

Проверка split/resolve/rebuild восстановила оба исходных варианта с точным
структурным равенством, включая порядок массивов. `arrivalRate=0.12` сохранён
как есть: в нынешнем ядре это интенсивность на миллисекунду, то есть 120 RPS.
Преобразование чисел `1.0` в текст `1` меняет запись, но не числовые значения
примера. Универсальная миграция произвольных сценариев не проверялась.

### Порядок и воспроизводимость

В [ReliabilityModel](../../core/src/main/kotlin/resiliencelab/core/simulation/ReliabilityModel.kt)
потоки случайных чисел назначаются по индексам сервисов и связей. Поэтому
сортировка старых массивов по ID может изменить симуляцию при том же seed.
Прототип сохраняет `serviceOrder` и `linkOrder`, хотя данные узлов находятся
в map. При дальнейшем проектировании можно оставить массивы; обязательна
сохранность их порядка при адаптации v1. Назначение потоков по устойчивым ID
потребовало бы отдельного изменения ядра.

## Настоящие диффы и слияния

Диффы получены `git diff --no-index` между записанными файлами. Скрипт заменяет
только временные имена в заголовках. Числа ниже не включают строки заголовка.

| Правка | JSON: добавлено / удалено | YAML: добавлено / удалено | Затронутые файлы |
|---|---|---|---|
| middle.x: 260 в 300 | [1 / 1][json-move] | [1 / 1][yaml-move] | Только layout |
| timeoutMs: 60 в 90 | [1 / 1][json-timeout] | [1 / 1][yaml-timeout] | Только baseline model |
| worker после dependency | [33 / 2][json-add] | [25 / 0][yaml-add] | baseline model и layout |

Перемещение в JSON:

```diff
diff --git a/layout.json b/layout.json
index 0ce9e02..90c0c22 100644
--- a/layout.json
+++ b/layout.json
@@ -10,7 +10,7 @@
       "y": 100
     },
     "middle": {
-      "x": 260,
+      "x": 300,
       "y": 100
     }
   },
```

Изменение timeout в YAML:

```diff
diff --git a/models/baseline.yaml b/models/baseline.yaml
index 2523853..62db26f 100644
--- a/models/baseline.yaml
+++ b/models/baseline.yaml
@@ -28,7 +28,7 @@ links:
       baseBackoffMs: 2
       kind: EXPONENTIAL_FULL_JITTER
       maxBackoffMs: 20
-    timeoutMs: 60
+    timeoutMs: 90
     to: dependency
 schemaVersion: research-1
 serviceOrder:
```

Добавление блока включает сервис, связь от прежнего последнего сервиса,
записи порядка и координаты. Полные диффы доступны в таблице. Соседние узлы
не пересоздаются; форматирование стабильных файлов одинаково при повторной записи.

`git merge-file` слил изменение timeout одной связи и handlers другого сервиса
в обоих форматах. Конкурирующие значения одного timeout дали конфликт в обоих:
[JSON][json-conflict], [YAML][yaml-conflict]. Их stdout и код завершения сохранены
в JSON, чтобы тестовые маркеры не выглядели как незавершённое слияние ветки.
Это два конкретных сценария,
а не оценка частоты конфликтов на больших проектах. Массовые перестановки,
одновременное добавление элементов порядка и переименование ID могут конфликтовать.

## Комментарии и политика записи

Примеры npm `yaml`: [исходный текст][comment-original],
[правка Document][comment-ast], [правка через объект][comment-dto].
Document сохранил начальный, inline и завершающий комментарии после изменения
числа; второй цикл дал те же байты. На JVM ту же локальную операцию выполнил
SnakeYAML Engine с переносом metadata комментариев при замене ScalarNode.
kaml и Engine Load/Dump потеряли комментарии при преобразовании через DTO/Map.
Это результат малых проб, а не гарантия для удаления подграфа или любой YAML-записи.

Для новых JSON-файлов предлагается UTF-8, LF, конечный перевод строки, два
пробела и фиксированный порядок полей. В прототипе рекурсивно сортируются
только ключи объектов; массивы сохраняют порядок. Для YAML с комментариями
локальная правка дерева предпочтительнее полной пересортировки документа.

Повторная запись проверена в каждой реализации отдельно. Побайтовое совпадение
записи Kotlin и JS не проверялось: различаются, например, отображение Double и
порядок integer-like ключей JS. До реализации A6 нужно назначить одну реализацию
записи или общий корпус эталонных файлов. Хеш исполняемой модели должен иметь
отдельно определённую нормализацию и исключать раскладку; готовой канонизации
или хеширования этот прототип не предлагает.

### Строгость входа

JSON не избавляет от проверки парсера. В пробе `JSON.parse` и kotlinx принимают
дубли с последним значением, тогда как Jackson с `STRICT_DUPLICATE_DETECTION`
их отклоняет. AJV после разбора не восстановит потерянный дубль. `1e400` в JS
превращается в Infinity; обычная запись затем дала бы null. Generic-дерево
kotlinx принимает bare NaN, хотя typed Double decoder его отклоняет.

Следовательно, будущему загрузчику нужны проверка синтаксиса и дублей до потери
информации, конечность всех чисел, проверка JSON Schema и предметная валидация.
Прототип JSON намеренно фиксирует отсутствие duplicate guard, не выдавая себя
за готовый загрузчик. Для browser writer такой guard ещё нужно выбрать.

YAML-проба JS дополнительно отвергает aliases/anchors, явные tags, дубли и
неконечные числа. Название `JsonSchema` в SnakeYAML означает правила YAML-скаляров,
не JSON Schema validator: `.nan` всё равно стал Double.NaN. Compose сохраняет
дубликаты узлов, хотя Load их отвергает. Для AST writer нужен отдельный этап
проверки входа. Ограничения глубины, размера и сложных атак не исследовались.

`seed` в Kotlin имеет тип Long, в браузере сейчас number. Будущей схеме нужно
явно выбрать безопасный диапазон целых или десятичную строку для полного Long;
проверка прототипа отклоняет seed вне ±(2^53−1). Это не исправление текущего API.

## Генерация и проверка схемы

Использована [библиотека Kotlin/kotlinx-schema](https://github.com/Kotlin/kotlinx-schema/blob/main/docs/serializable.md),
а не самописный генератор. [Полученная схема][kotlin-schema] сохраняет
`@SerialName`, optionality default-полей, nullable, enum и sealed-подтипы через
`oneOf`/`$defs`/discriminator. Одна и та же схема потребляется AJV в JS без
перевода; положительный пример принят, отсутствие required, неверные enum и
discriminator отклонены.

Есть два установленных ограничения:

1. `SerialDescriptor` сообщает наличие default, но не вычисленное значение.
   Default-значение `untitled` не появилось в схеме. Единицы, диапазоны,
   описания и defaults должны прийти из одного явного источника метаданных A2.
2. Текущий `ScenarioCodec` использует `explicitNulls=false`: отсутствие nullable
   поля без Kotlin-default декодируется в null. Генератор объявляет такое поле
   required. [Контрольный пример][nullable-fixture] принят Kotlin и отклонён
   AJV. Значит, дескрипторная схема не совпадает автоматически с нынешним codec.

Для новых файлов предлагается отдельный сериализуемый контракт: необязательное
nullable-поле объявлять с `= null`, обязательное передавать явно; настройки
codec и генератора закрепить общими примерами. Это рекомендация для будущей
реализации, не изменение существующей модели. О семантике omission см.
[explicitNulls](https://kotlinlang.org/api/kotlinx.serialization/kotlinx-serialization-json/kotlinx.serialization.json/-json-builder/explicit-nulls.html).
Schema [`default`](https://json-schema.org/understanding-json-schema/reference/annotations)
сам по себе не подставляет значение при валидации.

Предлагаемый процесс: генерация структурной схемы из файловых DTO, добавление
предметных ограничений из каталога A2, сохранение versioned schema в репозитории,
проверка отсутствия diff после регенерации в CI. JVM и JS должны прогонять один
набор допустимых/недопустимых файлов. Проверка ссылок, циклов, портов и
вычислимости остаётся в компиляторе A3. Четыре схемы оболочек в [schemas][schemas]
написаны вручную для сравнения форматов и не являются полной схемой `core`.

Для редакторов схема связывается с файлами через workspace settings либо
поддерживаемую директиву. [VS Code JSON](https://code.visualstudio.com/docs/languages/json#_json-schemas-and-settings)
заявляет ограниченную поддержку 2020-12; [YAML extension](https://github.com/redhat-developer/vscode-yaml#associating-schemas)
заявляет этот диалект и поддерживает `yaml-language-server` modeline. Подсказки
в реальном редакторе здесь не проверялись. CLI/CI-валидатор должен оставаться
источником результата проверки, даже если редактор не понимает часть keywords.

## Скорость разбора

Измерения локальные, на Apple M4 Pro arm64. Node: пять прогревов, 20 измерений;
JVM: 20 прогревов, 50 измерений. Все парсеры каждого runtime запускались
последовательно, GC не отключался. Измерены строки в памяти, без диска,
валидации, записи, UI и расчёта. Размеры 50/500/5000 относятся к плоским
синтетическим блокам, а не к раскрытой иерархии. Медиана — среднее двух
центральных наблюдений; исходные p95 и параметры доступны в JSON.

Node использует сервисы с handlers, queueCapacity и processing. JVM использует
более короткие блоки id/type/timeoutMs. **Абсолютные времена между этими двумя
таблицами сравнивать нельзя.** Это малые воспроизводимые измерения, не JMH и
не установленный предел размера модели.

| Parser | 50 блоков, мс | 500 блоков, мс | 5000 блоков, мс |
|---|---:|---:|---:|
| JSON.parse | 0.013 | 0.114 | 1.133 |
| yaml.parse | 1.880 | 15.484 | 161.315 |
| yaml.parseDocument | 1.517 | 14.099 | 148.157 |

| Parser | 50 блоков, мс | 500 блоков, мс | 5000 блоков, мс |
|---|---:|---:|---:|
| kotlinx-json-tree | 0.055 | 0.162 | 0.714 |
| jackson-json-tree | 0.063 | 0.282 | 1.004 |
| kaml-yaml-tree | 0.370 | 2.154 | 9.110 |
| engine-yaml-tree | 0.421 | 1.612 | 15.001 |

При 5000 сервисах Node разбирал JSON 938913 байт, YAML 638900 байт;
JVM — JSON 438935 байт и YAML 273917 байт. YAML компактнее в этих представлениях,
JSON быстрее в измеренном разборе. Нельзя переносить Node-время на браузер или
выводить из него задержку сохранения UI. Браузерная проверка подтвердила только
исполнение Document и AJV после esbuild-сборки.

## Проверки и дальнейшее решение

Команды воспроизведения: [README прототипа][prototype]. Выполнены JVM `run`,
JVM `run --args=--benchmark`, `npm ci`, `npm run check`, `npm run probe`,
`npm run benchmark`, `npm run browser` и открытие браузерной страницы.
JS-проверки завершились с `10 checks passed`, JVM — `checks: PASS`.
Исходные результаты: [JS checks][js-checks], [JVM checks][jvm-checks],
[JS timings][js-benchmark], [JVM timings][jvm-benchmark].

Дополнительно прошла `./gradlew --no-daemon clean build` приложения: тесты,
KtLint и проверка покрытия JVM-модулей. Изменены только этот документ и
изолированный прототип. E2E приложения не запускался: UI/API не менялись.
Исполненный browser probe не является E2E продукта.
Не проверялись полный UI import/export нового формата, универсальная миграция,
все комментарии при структурных правках, writer parity JVM/JS и файловые операции A6.
Текущий web-import также отвергает многовариантный retry-storm как неоднозначный;
проверка split/rebuild не меняет этого поведения.

Следующий шаг по A1: согласовать JSON и поясняющие поля либо обязательные inline
комментарии YAML. Затем зафиксировать контракт записи с A6, null/default и
числа, версионирование файлов и схему из A2. Иерархия, порты и маски остаются
обязательным дальнейшим развитием по продуктовому видению, не готовыми
возможностями исследовательских файлов.

Попутно обнаружены риски существующего контракта: зависимость RNG от порядка
массивов, полный Long против JS number, различия форматирования backend и web.
Они описаны выше и не исправлялись в рамках #47.

[prototype]: ../../research/model-file-format/README.md
[jvm-readme]: ../../research/model-file-format/jvm/README.md
[js-checks]: ../../research/model-file-format/results/js-checks.json
[jvm-checks]: ../../research/model-file-format/jvm/results/checks.json
[js-benchmark]: ../../research/model-file-format/results/js-benchmark.json
[jvm-benchmark]: ../../research/model-file-format/jvm/results/benchmark.json
[jackson-dependency]: ../../research/model-file-format/jvm/results/boot-jackson-dependency.txt
[provenance]: ../../research/model-file-format/jvm/results/maven-provenance.json
[json-fixtures]: ../../research/model-file-format/fixtures/json
[yaml-fixtures]: ../../research/model-file-format/fixtures/yaml
[schemas]: ../../research/model-file-format/schemas
[kotlin-schema]: ../../research/model-file-format/jvm/results/probe.schema.json
[nullable-fixture]: ../../research/model-file-format/jvm/results/probe-explicit-nulls-false.json
[json-move]: ../../research/model-file-format/diffs/json-move.diff
[yaml-move]: ../../research/model-file-format/diffs/yaml-move.diff
[json-timeout]: ../../research/model-file-format/diffs/json-timeout.diff
[yaml-timeout]: ../../research/model-file-format/diffs/yaml-timeout.diff
[json-add]: ../../research/model-file-format/diffs/json-add-node.diff
[yaml-add]: ../../research/model-file-format/diffs/yaml-add-node.diff
[json-conflict]: ../../research/model-file-format/diffs/json-merge-conflict.json
[yaml-conflict]: ../../research/model-file-format/diffs/yaml-merge-conflict.json
[comment-original]: ../../research/model-file-format/comments/original.yaml
[comment-ast]: ../../research/model-file-format/comments/ast-edit.yaml
[comment-dto]: ../../research/model-file-format/comments/dto-edit.yaml
