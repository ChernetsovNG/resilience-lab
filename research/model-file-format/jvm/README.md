# Изолированный JVM-прототип S2

Это исследовательская программа, не модуль приложения. Она не подключена к корневому `settings.gradle.kts`, не меняет `core`, `apps` или `web` и не реализует новый файловый формат продукта.

Из корня репозитория:

```sh
./gradlew -p research/model-file-format/jvm --no-daemon run
./gradlew -p research/model-file-format/jvm --no-daemon run --args=--benchmark
```

Первоначальная фиксация зависимостей выполнена с `--write-locks`; повторный запуск использует `gradle.lockfile`. Нужны JDK 25 и доступ к Maven Central/Gradle Plugin Portal при пустом кэше. Используется существующий Gradle Wrapper 9.8.2, отдельного wrapper здесь нет. Утверждения проверяются AssertJ; нарушение останавливает программу ненулевым кодом. Результаты запусков сохраняются в JSON/YAML в `results/`; повторный запуск обновляет эти файлы.

## Совместимость, проверенная исполнением

На JDK 25.0.3, Kotlin JVM/serialization plugin 2.4.21, Gradle 9.8.2 успешно скомпилированы и исполнены:

- `org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0`;
- `org.jetbrains.kotlinx:kotlinx-schema-generator-json:0.6.0`;
- `com.charleskorn.kaml:kaml:0.104.0`;
- `org.snakeyaml:snakeyaml-engine:3.2`;
- `com.fasterxml.jackson.module:jackson-module-kotlin:2.21.7`;
- `com.github.victools:jsonschema-generator:4.38.0` и `jsonschema-module-jackson:4.38.0`.

Зависимости фиксирует lockfile, включая разрешённые JVM-варианты. Недоступных кандидатов среди перечисленных нет. Совместимость не означает полного тестирования библиотек на всех моделях приложения. Версия Jackson 2.21.7 также подтверждена настоящим `:apps:server:dependencyInsight`; вывод лежит в `results/boot-jackson-dependency.txt`. Это существующий `com.fasterxml.jackson` из server manifest; наличие Spring Boot 4.1.2 не делает его автоматически Jackson 3. POM Boot управляет отдельно Jackson 2 и 3.

`results/maven-provenance.json` содержит URL и SHA-256 POM каждого кандидата, а также зависимости, объявленные издателем. У schema-generator 0.6.0 это serialization 1.11.0/Kotlin 2.3.21; у kaml 0.104.0 — serialization 1.9.0/Kotlin 2.2.21. Прототип разрешил serialization до 1.12.0 и stdlib до 2.4.21. Это проверка совместимости выбранных операций, не заявление об официальной матрице поддержки. Victools 4.38.0 выбран для сравнения с имеющимся Jackson 2; более новый Victools 5.0.0 отдельно не испытывался.

## Измеренные свойства

Машиночитаемый результат: `results/checks.json`.

**JSON.** Typed-декодирование kotlinx отвергает неизвестные поля, `NaN`, переполнение `1e999` в `Double`, завершающую запятую; запись `Double.NaN` тоже запрещена. Но повторённый ключ принимает, оставляя последнее значение. Generic `Json.parseToJsonElement` принимает даже bare `NaN`, а typed `Double` декодируется и из строки `"1.0"`; поэтому синтаксический разбор дерева, проверка JSON Schema и типизированное декодирование — разные проверки. Порядок ключей `Map` зависит от порядка вставки. Повторная запись DTO с фиксированным порядком полей стабильна; это не универсальная канонизация JSON.

Jackson с `STRICT_DUPLICATE_DETECTION` отвергает дубли; остальные явно включённые проверки видны в исходнике. Настройки сортировки обеспечивают одинаковую запись двух `Map` с разным порядком вставки. Однако `1e999` при привязке к `Double` становится бесконечностью, а NaN по умолчанию записывается строкой `"NaN"`. Поэтому необходимы независимая проверка конечности чисел и проверка схемой, а не доверие одному имени «строгий JSON».

**YAML.** kaml отвергает неизвестные поля и дубли, умеет round-trip типизированного sealed-типа с discriminator property, но typed decode → copy → encode теряет все три комментария теста. `NaN` принимается. Кроме того, [репозиторий kaml архивирован 30 ноября 2025 года](https://github.com/charleskorn/kaml), поэтому для новой долгоживущей записи файлов он нежелателен.

SnakeYAML Engine `Load → Dump` также теряет комментарии. Альтернатива работоспособна: `Compose(parseComments=true) → MappingNode → замена ScalarNode с переносом его comment-полей → Serialize → Present(dumpComments=true)` сохраняет начальный, inline и завершающий комментарии при изменении числа. Второй цикл даёт тот же текст (`results/engine-node-edited.yaml`). Это проверка одной локальной правки узла, не доказательство сохранения любого форматирования или комментариев при произвольной перестройке графа. AST должен оставаться рядом с типизированной моделью; пересоздание из DTO уничтожает такую возможность.

У Engine явно отключены дубли, нестандартные ключи и aliases коллекций, задана `JsonSchema`; загрузка отвергает custom tag, non-scalar key и несколько документов. Однако `.nan` всё равно становится `Double.NaN`: YAML `JsonSchema` не является JSON Schema-валидатором и не обеспечивает конечность чисел. `Compose` сохраняет две одинаковые записи ключа, хотя `Load` отвергает их. Значит, AST-путь записи требует отдельного этапа валидации входа. Прототип не объявляет политику допустимых aliases/tags готовой для продукта.

## JSON Schema из Kotlin

`SerializationClassJsonSchemaGenerator` из существующей библиотеки Kotlin/kotlinx-schema 0.6.0 потребляет `SerialDescriptor`; собственного генератора здесь нет. Результат — `results/probe.schema.json` (Draft 2020-12). Созданы также положительный и отрицательные JSON-примеры для независимого валидатора JS.

Проверено в сгенерированном результате:

- `@SerialName("schemaVersion")` меняет имя поля;
- обязательны `schemaVersion` и nullable-поле без default; поля с default необязательны;
- nullable представлен union с `null`;
- enum содержит `sync`/`async` из `@SerialName`;
- sealed-типы представлены через `oneOf`, `$defs` и discriminator `type` с `const` для подтипов `fixed`/`uniform`;
- `additionalProperties: false` закрывает объекты.

`SerialDescriptor` знает **наличие** default (`isElementOptional`), но не его вычисленное значение: строковый default `untitled` не попал в схему. Генерировать его reflection-конструктором значило бы выбрать другой механизм и исполнять пользовательские default-выражения; в этой работе это не требуется. Если подсказки о default нужны редактору, им нужен явный источник метаданных и тесты, не параллельная ручная копия всех Kotlin-моделей.

Критичный пример несовпадения: `Json { explicitNulls = false }` позволяет опустить обязательное nullable-поле без default и восстанавливает null. Дескрипторная схема требует его присутствия. В текущем `ScenarioCodec` приложения установлен именно `explicitNulls=false`. Для новых файлов нужно отдельно выбрать политику null/default и закрепить общими положительными/отрицательными fixtures на JVM/JS. Конфигурация генератора `JsonSchemaConfig.Strict` здесь не подходит автоматически: она требует **все** поля, включая имеющие Kotlin-default. Прототип использует обычный `Default`, а для записи самой схемы — `encodeDefaults=false`, чтобы не выводить пустые schema keywords со значениями null.

Результат Victools+Jackson (`results/victools-jackson.schema.json`) без дополнительной настройки отличается от kotlinx-контракта: поле `version`, enum `SYNC`/`ASYNC`, нет required/nullable-правил Kotlin, `work` — пустой object. Это результат конкретной конфигурации, а не утверждение, что Victools нельзя настроить. Jackson KotlinModule также не переводит `@SerialName` в Jackson-аннотацию. При источнике типов на kotlinx.serialization проще генерировать из того же descriptor, чем сопровождать второй набор правил Jackson.

## Скорость

`results/benchmark.json` хранит исходные результаты для 50, 500, 5000 синтетических блоков с одинаковыми значениями. Измерен parse из строки в generic tree без чтения диска, схемной или предметной валидации, преобразования в domain DTO и UI. Для каждой пары parser/size выполнены 20 прогревочных и 50 измеряемых итераций в одном процессе JVM; median — среднее элементов 24 и 25, p95 — элемент 47 отсортированного массива с нулевой индексацией. GC не отключался, порядок библиотек фиксирован. Это небольшой воспроизводимый smoke benchmark, не JMH, не статистическое доказательство производительности всего приложения.

На 5000 блоках: JSON 438935 байт, YAML 273917 байт. Median: kotlinx JSON-tree 0.714 мс; Jackson JSON-tree 1.004 мс; kaml YAML-node tree 9.110 мс; SnakeYAML Engine Java tree 15.001 мс. Engine работает с `parseComments=true` и строгими настройками из проверки. Сравниваются разные структуры дерева и реализации; абсолютные времена другого runtime/браузера и задержка сохранения в UI отсюда не следуют.

## Рекомендация исследователя

Для типов и схемы использовать существующий kotlinx.serialization и проверить Kotlin/kotlinx-schema на будущих файловых DTO. Для YAML backend writer технически возможен на SnakeYAML Engine AST; комментарии требуют edit-in-place дерева, переноса metadata при замене узлов и набора регрессий на реальные правки. Typed YAML-сериализатор в одиночку эту гарантию не даёт. JSON проще по записи и проверке, но комментариев в формате нет. Окончательный выбор A1 и место записи A6 остаются отдельными решениями; этот прототип их не принимает.

## Первичные источники

- [kotlinx.serialization: SerialDescriptor](https://kotlinlang.org/api/kotlinx.serialization/kotlinx-serialization-core/kotlinx.serialization.descriptors/-serial-descriptor/) — структура сериализатора, nullability, optionality.
- [Kotlin/kotlinx-schema: serialization-based generation](https://github.com/Kotlin/kotlinx-schema/blob/main/docs/serializable.md) — генерация через descriptor, enum/SerialName/polymorphism, настройки required/null.
- [Точный source JAR schema-generator 0.6.0](https://repo.maven.apache.org/maven2/org/jetbrains/kotlinx/kotlinx-schema-generator-json-jvm/0.6.0/kotlinx-schema-generator-json-jvm-0.6.0-sources.jar) — реализация `SerializationClassJsonSchemaGenerator` и `JsonSchemaConfig`.
- [kaml configuration](https://github.com/charleskorn/kaml/blob/main/src/commonMain/kotlin/com/charleskorn/kaml/YamlConfiguration.kt) и [точный source JAR 0.104.0](https://repo.maven.apache.org/maven2/com/charleskorn/kaml/kaml-jvm/0.104.0/kaml-jvm-0.104.0-sources.jar) — strict mode, defaults, polymorphism, aliases.
- [SnakeYAML Engine](https://github.com/snakeyaml/snakeyaml-engine) и [точный source JAR 3.2](https://repo.maven.apache.org/maven2/org/snakeyaml/snakeyaml-engine/3.2/snakeyaml-engine-3.2-sources.jar) — базовые Java-типы, Load/Dump settings и Compose/Serialize/Present.
- [Victools JSON Schema Generator](https://github.com/victools/jsonschema-generator) — Java/reflection и Jackson annotations; [Jackson Kotlin module](https://github.com/FasterXML/jackson-module-kotlin) — отдельная модель Jackson.
- [Spring Boot dependencies 4.1.2 POM](https://repo.maven.apache.org/maven2/org/springframework/boot/spring-boot-dependencies/4.1.2/spring-boot-dependencies-4.1.2.pom) — Jackson 2 BOM 2.21.7 и Jackson 3 BOM 3.1.7.
