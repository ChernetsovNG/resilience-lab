# Срез этапа 1: ядро — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить в `core` новый фундамент этапа 1 — каталог типов, документы, компилятор в IR, движок с потоками по путям, исполнение задач, файловую рабочую область, артефакт прогона и фасад `Lab` для сервера и CLI — не ломая нынешнее API ядра.

**Architecture:** Новые пакеты `catalog`, `document`, `compiler`, `ir`, `execution`, `results`, `workspace`, `lab` появляются рядом со старыми. Движок (`simulation`) начинает принимать `ChainIr` и источник потоков `StreamSource`; старый конструктор `ReliabilityModel(model, scenario, execution)` остаётся и переводит MVP-сценарий в IR с прежней нумерацией потоков, поэтому старые тесты, сервер, CLI и web продолжают работать. План 2 переключит сервер и CLI на `Lab`; старый код удаляет план 4 после перехода web.

**Tech Stack:** Kotlin 2.4.21, JDK 25, KSLCore R1.8.1, kotlinx.serialization 1.12.0, jackson-core 2.21.7 (строгая проверка JSON), kotlin.test + AssertJ.

---

## Источники

- Дизайн этапа 1: `docs/superpowers/specs/2026-10-27-stage-1-design.md` — §3 (каталог, документы, пути, величины), §4 (ядро), §7.1 (сквозной срез).
- ADR 0001 (каталог), 0002 (конвейер), 0003 (рабочая область), 0005 (формат), 0006 (потоки), 0007 (KSL), 0008 (артефакт), 0009 (исполнение) — `docs/architecture/adr/`.
- Прототип потоков: `research/ksl-streams/src/main/kotlin/resiliencelab/research/streams/PathStreams.kt`.
- Семантика движка — без изменений: `core/src/main/kotlin/resiliencelab/core/simulation/ReliabilityModel.kt`.

## Границы плана

- **Входит:** всё перечисленное в Goal; пример `examples/retry-storm/` в новом формате; тесты детерминизма.
- **Не входит:** сервер, CLI, web (планы 2 и 3). Дорожке T1 остаются ряды и поле `execution.window`, вывод v1, линтер, сетка и поле `grid`, генерация JSON-схем, оценка стоимости, отмена, досчёт и чередование заданий.
- **Остаётся до плана 4 (удаление MVP после перехода web):** пакет `scenario`, `experiment/ExperimentRunner`, `experiment/SweepExpander`, `simulation/SeedFactory`, старый конструктор `ReliabilityModel`, `LegacyScenarioAdapter`. План 4 удаляет их, переносит смысловые тесты MVP на IR и переименовывает пакет `simulation` в `engine.ksl`; файл `examples/retry-storm.json` удаляет план 2 вместе со старым CLI.
- **Отличие от §4.1 дизайна:** пакеты `workspace` (хранилище документов, ADR 0003) и `lab` (фасад) живут в ядре, чтобы сервер и CLI работали с документами одинаково (D5); таблица §4.1 дополнена.

## Карта файлов

| Файл | Ответственность |
|---|---|
| `core/src/main/kotlin/resiliencelab/core/catalog/Quantities.kt` | Величины с единицами: разбор и печать |
| `core/src/main/kotlin/resiliencelab/core/catalog/Catalog.kt` | Описания типов, портов и параметров |
| `core/src/main/kotlin/resiliencelab/core/catalog/Stage1Catalog.kt` | Каталог этапа 1: `client`, `service`, `request`, `call` |
| `core/src/main/kotlin/resiliencelab/core/compiler/Diagnostic.kt` | Диагностика и JSON Pointer |
| `core/src/main/kotlin/resiliencelab/core/document/Documents.kt` | Классы документов модели, раскладки, эксперимента |
| `core/src/main/kotlin/resiliencelab/core/document/StrictJson.kt` | Отказ от повторяющихся ключей и неконечных чисел |
| `core/src/main/kotlin/resiliencelab/core/document/DocumentCodec.kt` | Строгое чтение и детерминированная запись |
| `core/src/main/kotlin/resiliencelab/core/ir/ChainIr.kt` | Промежуточное представление цепочки |
| `core/src/main/kotlin/resiliencelab/core/compiler/ParamReader.kt` | Чтение параметров по каталогу |
| `core/src/main/kotlin/resiliencelab/core/compiler/ModelCompiler.kt` | Документы → IR с диагностикой |
| `core/src/main/kotlin/resiliencelab/core/simulation/PathStreams.kt` | Потоки по путям (ADR 0006) |
| `core/src/main/kotlin/resiliencelab/core/simulation/LegacyScenarioAdapter.kt` | Временный перевод MVP-сценария в IR |
| `core/src/main/kotlin/resiliencelab/core/simulation/*` (изменения) | Движок принимает IR и `StreamSource` |
| `core/src/main/kotlin/resiliencelab/core/execution/ExperimentExecutor.kt` | Задачи вариант × повторение на пуле |
| `core/src/main/kotlin/resiliencelab/core/workspace/Workspace.kt` | Абстракция и файловая рабочая область |
| `core/src/main/kotlin/resiliencelab/core/results/RunArtifact.kt` | Манифест, сводка, запись артефакта |
| `core/src/main/kotlin/resiliencelab/core/lab/Lab.kt` | Фасад для сервера и CLI |
| `examples/retry-storm/*.json` | Пример в новом формате |

Тесты лежат зеркально в `core/src/test/kotlin/resiliencelab/core/<пакет>/`.

Общие команды:

- один тест: `./gradlew :core:test --tests '<полное.имя.Класса>'`
- форматирование: `./gradlew :core:ktlintFormat`
- полная проверка модуля: `./gradlew :core:check`

---

### Task 1: Зависимость и величины с единицами

**Files:**
- Modify: `core/build.gradle.kts`
- Create: `core/src/main/kotlin/resiliencelab/core/catalog/Quantities.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/catalog/QuantitiesTest.kt`

- [ ] **Step 1: Добавить jackson-core**

В `core/build.gradle.kts` в блок `dependencies` после строки с `kotlinx-coroutines-core` добавить:

```kotlin
    implementation("com.fasterxml.jackson.core:jackson-core:2.21.7")
```

- [ ] **Step 2: Написать падающий тест**

```kotlin
package resiliencelab.core.catalog

import org.assertj.core.api.Assertions.assertThat
import kotlin.test.Test

class QuantitiesTest {
    @Test
    fun `parses durations into milliseconds`() {
        assertThat(Quantities.parse("250ms", Dimension.DURATION)).isEqualTo(250.0)
        assertThat(Quantities.parse("2s", Dimension.DURATION)).isEqualTo(2_000.0)
        assertThat(Quantities.parse("1.5min", Dimension.DURATION)).isEqualTo(90_000.0)
        assertThat(Quantities.parse("0.5ms", Dimension.DURATION)).isEqualTo(0.5)
    }

    @Test
    fun `parses rates into requests per millisecond`() {
        assertThat(Quantities.parse("120/s", Dimension.RATE)).isEqualTo(0.12)
        assertThat(Quantities.parse("3/ms", Dimension.RATE)).isEqualTo(3.0)
        assertThat(Quantities.parse("60/min", Dimension.RATE)).isEqualTo(0.001)
    }

    @Test
    fun `parses percentages into probabilities`() {
        assertThat(Quantities.parse("0.5%", Dimension.PROBABILITY)).isEqualTo(0.005)
        assertThat(Quantities.parse("100%", Dimension.PROBABILITY)).isEqualTo(1.0)
    }

    @Test
    fun `rejects malformed, unitless, foreign-unit and non-finite quantities`() {
        listOf("120", "-1ms", "1 ms", " 1ms", "ms", "1h", "1e999ms", "1.ms").forEach { text ->
            assertThat(Quantities.parse(text, Dimension.DURATION)).describedAs(text).isNull()
        }
        assertThat(Quantities.parse("120/s", Dimension.DURATION)).isNull()
        assertThat(Quantities.parse("5ms", Dimension.PROBABILITY)).isNull()
    }

    @Test
    fun `formats canonical values with base display units`() {
        assertThat(Quantities.format(1_000.0, Dimension.DURATION)).isEqualTo("1000ms")
        assertThat(Quantities.format(0.5, Dimension.DURATION)).isEqualTo("0.5ms")
        assertThat(Quantities.format(0.12, Dimension.RATE)).isEqualTo("120/s")
        assertThat(Quantities.format(0.005, Dimension.PROBABILITY)).isEqualTo("0.5%")
    }

    @Test
    fun `lists accepted units per dimension`() {
        assertThat(Quantities.unitsOf(Dimension.DURATION)).containsExactly("ms", "s", "min")
        assertThat(Quantities.unitsOf(Dimension.RATE)).containsExactly("/ms", "/s", "/min")
        assertThat(Quantities.unitsOf(Dimension.PROBABILITY)).containsExactly("%")
    }
}
```

- [ ] **Step 3: Убедиться, что тест падает**

Run: `./gradlew :core:test --tests 'resiliencelab.core.catalog.QuantitiesTest'`
Expected: FAIL — `Unresolved reference: Quantities`.

- [ ] **Step 4: Реализация**

```kotlin
package resiliencelab.core.catalog

import kotlinx.serialization.Serializable
import java.math.BigDecimal

/**
 * Physical kinds of catalog quantities. Canonical units: milliseconds for [DURATION],
 * requests per millisecond for [RATE], a probability from 0 to 1 for [PROBABILITY].
 */
@Serializable
enum class Dimension {
    DURATION,
    RATE,
    PROBABILITY,
}

/** Parses and prints document quantities such as `250ms`, `2s`, `120/s` and `0.5%` (ADR 0001, item 6). */
object Quantities {
    private val pattern = Regex("""^([0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)(ms|s|min|/ms|/s|/min|%)$""")

    /** canonical = value * numerator / denominator; the division keeps results like 120/s == 0.12 exact. */
    private class Scale(
        val numerator: Double,
        val denominator: Double,
    )

    private val scales: Map<Dimension, Map<String, Scale>> =
        mapOf(
            Dimension.DURATION to linkedMapOf("ms" to Scale(1.0, 1.0), "s" to Scale(1_000.0, 1.0), "min" to Scale(60_000.0, 1.0)),
            Dimension.RATE to linkedMapOf("/ms" to Scale(1.0, 1.0), "/s" to Scale(1.0, 1_000.0), "/min" to Scale(1.0, 60_000.0)),
            Dimension.PROBABILITY to linkedMapOf("%" to Scale(1.0, 100.0)),
        )

    /** Units accepted for [dimension], in display order. */
    fun unitsOf(dimension: Dimension): List<String> = scales.getValue(dimension).keys.toList()

    /** Returns the canonical value, or null when [text] is not a finite non-negative quantity of [dimension]. */
    fun parse(
        text: String,
        dimension: Dimension,
    ): Double? {
        val match = pattern.matchEntire(text) ?: return null
        val scale = scales.getValue(dimension)[match.groupValues[2]] ?: return null
        val value = match.groupValues[1].toDouble() * scale.numerator / scale.denominator
        return value.takeIf { it.isFinite() }
    }

    /** Formats a canonical value in the base display unit of [dimension]. */
    fun format(
        canonical: Double,
        dimension: Dimension,
    ): String =
        when (dimension) {
            Dimension.DURATION -> "${plain(canonical)}ms"
            Dimension.RATE -> "${plain(canonical * 1_000.0)}/s"
            Dimension.PROBABILITY -> "${plain(canonical * 100.0)}%"
        }

    /** Prints a number without exponent or trailing zeros. */
    fun plain(value: Double): String = BigDecimal.valueOf(value).stripTrailingZeros().toPlainString()
}
```

- [ ] **Step 5: Убедиться, что тест проходит**

Run: `./gradlew :core:test --tests 'resiliencelab.core.catalog.QuantitiesTest'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
./gradlew :core:ktlintFormat
git add core/build.gradle.kts core/src/main/kotlin/resiliencelab/core/catalog/Quantities.kt core/src/test/kotlin/resiliencelab/core/catalog/QuantitiesTest.kt
git commit -m "feat(core): parse quantities with units"
```

---

### Task 2: Каталог типов этапа 1

**Files:**
- Create: `core/src/main/kotlin/resiliencelab/core/catalog/Catalog.kt`
- Create: `core/src/main/kotlin/resiliencelab/core/catalog/Stage1Catalog.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/catalog/Stage1CatalogTest.kt`

- [ ] **Step 1: Написать падающий тест**

```kotlin
package resiliencelab.core.catalog

import kotlinx.serialization.json.Json
import org.assertj.core.api.Assertions.assertThat
import kotlin.test.Test

class Stage1CatalogTest {
    private val catalog = Stage1Catalog.catalog

    @Test
    fun `contains the stage 1 block and connection types`() {
        assertThat(catalog.types.map { it.id }).containsExactly("client", "service", "request", "call")
        assertThat(catalog.type("client")!!.category).isEqualTo(TypeCategory.BLOCK)
        assertThat(catalog.type("call")!!.connects).isEqualTo(ConnectionRule("service", "service"))
        assertThat(catalog.type("request")!!.connects).isEqualTo(ConnectionRule("client", "service"))
        assertThat(catalog.type("unknown")).isNull()
    }

    @Test
    fun `describes required service parameters with units and ranges`() {
        val params = catalog.type("service")!!.params.associateBy { it.name }
        assertThat(params.keys).containsExactly("handlers", "queue", "processing", "failureRate")
        assertThat(params.getValue("handlers").required).isTrue()
        assertThat(params.getValue("handlers").minimum).isEqualTo(1.0)
        assertThat(params.getValue("failureRate").dimension).isEqualTo(Dimension.PROBABILITY)
        assertThat(params.getValue("failureRate").units).containsExactly("%")
        assertThat(params.getValue("handlers").units).isEmpty()
        assertThat(params.getValue("processing").fields.first { it.name == "mean" }.units).containsExactly("ms", "s", "min")
        assertThat(params.getValue("processing").fields.map { it.name }).containsExactly("kind", "mean", "stdDev")
    }

    @Test
    fun `survives a JSON round trip`() {
        val json = Json.encodeToString(Catalog.serializer(), catalog)
        assertThat(Json.decodeFromString(Catalog.serializer(), json)).isEqualTo(catalog)
    }
}
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `./gradlew :core:test --tests 'resiliencelab.core.catalog.Stage1CatalogTest'`
Expected: FAIL — `Unresolved reference: Stage1Catalog`.

- [ ] **Step 3: Реализация `Catalog.kt`**

```kotlin
package resiliencelab.core.catalog

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** Whether a type is drawn as a block or as a connection between blocks. */
@Serializable
enum class TypeCategory {
    BLOCK,
    CONNECTION,
}

/** Direction of a block port. */
@Serializable
enum class PortDirection {
    IN,
    OUT,
}

/** Value kinds of catalog parameters. */
@Serializable
enum class ParamKind {
    INTEGER,
    NUMBER,
    QUANTITY,
    CHOICE,
    OBJECT,
}

/** A named port of a block type. */
@Serializable
data class PortDescriptor(
    val id: String,
    val direction: PortDirection,
)

/** Block types a connection type may join, from its source to its target. */
@Serializable
data class ConnectionRule(
    val fromType: String,
    val toType: String,
)

/**
 * One parameter of a type. Ranges of [ParamKind.QUANTITY] are in canonical units of [dimension], and [units] lists the
 * units a document may write; [default] is used when a document omits the parameter.
 */
@Serializable
data class ParamDescriptor(
    val name: String,
    val kind: ParamKind,
    val title: String,
    val description: String,
    val required: Boolean = false,
    val default: JsonElement? = null,
    val dimension: Dimension? = null,
    val units: List<String> = emptyList(),
    val minimum: Double? = null,
    val exclusiveMinimum: Double? = null,
    val maximum: Double? = null,
    val options: List<String> = emptyList(),
    val fields: List<ParamDescriptor> = emptyList(),
    val sweepable: Boolean = false,
)

/** A computable block or connection type; the single source for palette, forms, checks and CLI help (ADR 0001). */
@Serializable
data class TypeDescriptor(
    val id: String,
    val version: Int,
    val category: TypeCategory,
    val title: String,
    val description: String,
    val ports: List<PortDescriptor> = emptyList(),
    val connects: ConnectionRule? = null,
    val params: List<ParamDescriptor> = emptyList(),
)

/** Versioned set of computable types. */
@Serializable
data class Catalog(
    val schemaVersion: Int,
    val types: List<TypeDescriptor>,
) {
    fun type(id: String): TypeDescriptor? = types.firstOrNull { it.id == id }
}
```

- [ ] **Step 4: Реализация `Stage1Catalog.kt`**

```kotlin
package resiliencelab.core.catalog

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Stage 1 catalog: a client, blocking services, the client request and synchronous calls (stage 1 design §3.1). */
object Stage1Catalog {
    val catalog: Catalog =
        Catalog(
            schemaVersion = 1,
            types = listOf(client(), service(), request(), call()).map { type -> type.copy(params = type.params.map(::withUnits)) },
        )

    /** Quantity parameters list the units [Quantities] accepts for their dimension (ADR 0001, items 1 and 6). */
    private fun withUnits(param: ParamDescriptor): ParamDescriptor =
        param.copy(units = param.dimension?.let(Quantities::unitsOf).orEmpty(), fields = param.fields.map(::withUnits))

    private fun client() =
        TypeDescriptor(
            id = "client",
            version = 1,
            category = TypeCategory.BLOCK,
            title = "Client",
            description = "Open Poisson stream of original requests with an end-to-end deadline.",
            ports = listOf(PortDescriptor("out", PortDirection.OUT)),
            params =
                listOf(
                    ParamDescriptor(
                        name = "rate",
                        kind = ParamKind.QUANTITY,
                        title = "Arrival rate",
                        description = "Mean rate of original requests.",
                        required = true,
                        dimension = Dimension.RATE,
                        exclusiveMinimum = 0.0,
                        sweepable = true,
                    ),
                    ParamDescriptor(
                        name = "deadline",
                        kind = ParamKind.QUANTITY,
                        title = "Deadline",
                        description = "End-to-end deadline of each original request.",
                        required = true,
                        dimension = Dimension.DURATION,
                        exclusiveMinimum = 0.0,
                        sweepable = true,
                    ),
                ),
        )

    private fun service() =
        TypeDescriptor(
            id = "service",
            version = 1,
            category = TypeCategory.BLOCK,
            title = "Service",
            description = "Blocking service: a handler is held through local work, downstream calls and backoff.",
            ports = listOf(PortDescriptor("in", PortDirection.IN), PortDescriptor("out", PortDirection.OUT)),
            params =
                listOf(
                    ParamDescriptor(
                        name = "handlers",
                        kind = ParamKind.INTEGER,
                        title = "Handlers",
                        description = "Concurrent handlers.",
                        required = true,
                        minimum = 1.0,
                        sweepable = true,
                    ),
                    ParamDescriptor(
                        name = "queue",
                        kind = ParamKind.INTEGER,
                        title = "Queue capacity",
                        description = "Waiting places in the FIFO queue; zero disables queueing.",
                        default = JsonPrimitive(0),
                        minimum = 0.0,
                        sweepable = true,
                    ),
                    distribution(
                        name = "processing",
                        title = "Processing time",
                        description = "Local processing time of one attempt.",
                        default = null,
                    ),
                    ParamDescriptor(
                        name = "failureRate",
                        kind = ParamKind.QUANTITY,
                        title = "Failure rate",
                        description = "Probability that local processing fails.",
                        default = JsonPrimitive("0%"),
                        dimension = Dimension.PROBABILITY,
                        minimum = 0.0,
                        maximum = 1.0,
                        sweepable = true,
                    ),
                ),
        )

    private fun request() =
        TypeDescriptor(
            id = "request",
            version = 1,
            category = TypeCategory.CONNECTION,
            title = "Request",
            description = "Delivers original requests from the client to the entry service without delay or retries.",
            connects = ConnectionRule("client", "service"),
        )

    private fun call() =
        TypeDescriptor(
            id = "call",
            version = 1,
            category = TypeCategory.CONNECTION,
            title = "Call",
            description = "Synchronous call with a per-attempt timeout, retries and backoff on the caller side.",
            connects = ConnectionRule("service", "service"),
            params =
                listOf(
                    distribution(
                        name = "network",
                        title = "Network delay",
                        description = "One-way network delay, drawn separately for the request and the response.",
                        default =
                            buildJsonObject {
                                put("kind", "fixed")
                                put("mean", "0ms")
                            },
                    ),
                    ParamDescriptor(
                        name = "timeout",
                        kind = ParamKind.QUANTITY,
                        title = "Timeout",
                        description = "Per-attempt timeout, also bounded by the remaining deadline.",
                        required = true,
                        dimension = Dimension.DURATION,
                        exclusiveMinimum = 0.0,
                        sweepable = true,
                    ),
                    ParamDescriptor(
                        name = "attempts",
                        kind = ParamKind.INTEGER,
                        title = "Attempts",
                        description = "Maximum attempts including the first one.",
                        default = JsonPrimitive(1),
                        minimum = 1.0,
                        sweepable = true,
                    ),
                    ParamDescriptor(
                        name = "backoff",
                        kind = ParamKind.OBJECT,
                        title = "Backoff",
                        description = "Delay between attempts.",
                        default = buildJsonObject { put("kind", "none") },
                        fields =
                            listOf(
                                ParamDescriptor(
                                    name = "kind",
                                    kind = ParamKind.CHOICE,
                                    title = "Kind",
                                    description = "Backoff policy.",
                                    required = true,
                                    options = listOf("none", "fixed", "exponential-full-jitter"),
                                ),
                                ParamDescriptor(
                                    name = "base",
                                    kind = ParamKind.QUANTITY,
                                    title = "Base delay",
                                    description = "Delay after the first failed attempt before jitter.",
                                    default = JsonPrimitive("0ms"),
                                    dimension = Dimension.DURATION,
                                    minimum = 0.0,
                                    sweepable = true,
                                ),
                                ParamDescriptor(
                                    name = "max",
                                    kind = ParamKind.QUANTITY,
                                    title = "Maximum delay",
                                    description = "Upper bound of one backoff delay.",
                                    default = JsonPrimitive("0ms"),
                                    dimension = Dimension.DURATION,
                                    minimum = 0.0,
                                ),
                                ParamDescriptor(
                                    name = "multiplier",
                                    kind = ParamKind.NUMBER,
                                    title = "Multiplier",
                                    description = "Growth factor of exponential backoff.",
                                    default = JsonPrimitive(2),
                                    exclusiveMinimum = 0.0,
                                ),
                            ),
                    ),
                ),
        )

    private fun distribution(
        name: String,
        title: String,
        description: String,
        default: JsonElement?,
    ) = ParamDescriptor(
        name = name,
        kind = ParamKind.OBJECT,
        title = title,
        description = description,
        required = default == null,
        default = default,
        fields =
            listOf(
                ParamDescriptor(
                    name = "kind",
                    kind = ParamKind.CHOICE,
                    title = "Distribution",
                    description = "Distribution of the duration.",
                    required = true,
                    options = listOf("fixed", "exponential", "lognormal"),
                ),
                ParamDescriptor(
                    name = "mean",
                    kind = ParamKind.QUANTITY,
                    title = "Mean",
                    description = "Mean duration.",
                    required = true,
                    dimension = Dimension.DURATION,
                    minimum = 0.0,
                    sweepable = true,
                ),
                ParamDescriptor(
                    name = "stdDev",
                    kind = ParamKind.QUANTITY,
                    title = "Standard deviation",
                    description = "Required for lognormal only.",
                    dimension = Dimension.DURATION,
                    exclusiveMinimum = 0.0,
                ),
            ),
    )
}
```

- [ ] **Step 5: Тест проходит**

Run: `./gradlew :core:test --tests 'resiliencelab.core.catalog.Stage1CatalogTest'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
./gradlew :core:ktlintFormat
git add core/src/main/kotlin/resiliencelab/core/catalog core/src/test/kotlin/resiliencelab/core/catalog/Stage1CatalogTest.kt
git commit -m "feat(core): add stage 1 type catalog"
```

---

### Task 3: Диагностика и JSON Pointer

**Files:**
- Create: `core/src/main/kotlin/resiliencelab/core/compiler/Diagnostic.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/compiler/DiagnosticTest.kt`

- [ ] **Step 1: Написать падающий тест**

```kotlin
package resiliencelab.core.compiler

import org.assertj.core.api.Assertions.assertThat
import kotlin.test.Test

class DiagnosticTest {
    @Test
    fun `builds RFC 6901 pointers with escaping`() {
        assertThat(JsonPointer.of("blocks", "a/b", "params")).isEqualTo("/blocks/a~1b/params")
        assertThat(JsonPointer.of("variants", 1, "overrides", "x~y")).isEqualTo("/variants/1/overrides/x~0y")
        assertThat(JsonPointer.child("/blocks", "gateway")).isEqualTo("/blocks/gateway")
    }

    @Test
    fun `collects errors and counts them`() {
        val sink = Diagnostics()
        sink.error("CODE", "message", "a.model.json", "/blocks", "gateway")
        assertThat(sink.errorCount()).isEqualTo(1)
        assertThat(sink.items.single())
            .isEqualTo(Diagnostic("CODE", Severity.ERROR, "message", "a.model.json", "/blocks", "gateway"))
    }
}
```

- [ ] **Step 2: Тест падает**

Run: `./gradlew :core:test --tests 'resiliencelab.core.compiler.DiagnosticTest'`
Expected: FAIL — `Unresolved reference: JsonPointer`.

- [ ] **Step 3: Реализация**

```kotlin
package resiliencelab.core.compiler

import kotlinx.serialization.Serializable

/** Severity of a diagnostic; only errors block a run. */
@Serializable
enum class Severity {
    ERROR,
    WARNING,
}

/**
 * One finding shared by API, CLI and UI: a stable [code], the [document] and JSON [pointer] it refers to,
 * and the block [path] when it concerns a block or connection (stage 1 design §4.1).
 */
@Serializable
data class Diagnostic(
    val code: String,
    val severity: Severity,
    val message: String,
    val document: String? = null,
    val pointer: String? = null,
    val path: String? = null,
)

/** JSON Pointer construction (RFC 6901). */
object JsonPointer {
    fun of(vararg tokens: Any): String = tokens.joinToString(separator = "") { "/" + escape(it.toString()) }

    fun child(
        base: String,
        token: Any,
    ): String = base + "/" + escape(token.toString())

    private fun escape(token: String): String = token.replace("~", "~0").replace("/", "~1")
}

/** Mutable collector used while compiling. */
class Diagnostics {
    val items: MutableList<Diagnostic> = mutableListOf()

    fun error(
        code: String,
        message: String,
        document: String?,
        pointer: String? = null,
        path: String? = null,
    ) {
        items += Diagnostic(code, Severity.ERROR, message, document, pointer, path)
    }

    fun errorCount(): Int = items.count { it.severity == Severity.ERROR }
}
```

- [ ] **Step 4: Тест проходит**

Run: `./gradlew :core:test --tests 'resiliencelab.core.compiler.DiagnosticTest'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
./gradlew :core:ktlintFormat
git add core/src/main/kotlin/resiliencelab/core/compiler/Diagnostic.kt core/src/test/kotlin/resiliencelab/core/compiler/DiagnosticTest.kt
git commit -m "feat(core): add diagnostics and JSON pointers"
```

---

### Task 4: Документы, строгое чтение и детерминированная запись

**Files:**
- Create: `core/src/main/kotlin/resiliencelab/core/document/Documents.kt`
- Create: `core/src/main/kotlin/resiliencelab/core/document/StrictJson.kt`
- Create: `core/src/main/kotlin/resiliencelab/core/document/DocumentCodec.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/document/DocumentCodecTest.kt`

- [ ] **Step 1: Написать падающий тест**

```kotlin
package resiliencelab.core.document

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.assertj.core.api.Assertions.assertThat
import kotlin.test.Test

class DocumentCodecTest {
    @Test
    fun `rejects duplicate keys, non-finite numbers and syntax errors`() {
        assertThat(StrictJson.check("""{"a": 1, "a": 2}""", "x.json")!!.code).isEqualTo("JSON_DUPLICATE_KEY")
        assertThat(StrictJson.check("""{"a": 1e400}""", "x.json")!!.code).isEqualTo("JSON_NON_FINITE")
        assertThat(StrictJson.check("""{"a": NaN}""", "x.json")!!.code).isEqualTo("JSON_SYNTAX")
        assertThat(StrictJson.check("""{"a": [1, 2.5, "x"]}""", "x.json")).isNull()
    }

    @Test
    fun `decodes a model and reports shape and version problems`() {
        val text = """{"schemaVersion": 1, "blocks": {"c": {"type": "client"}}, "connections": []}"""
        val decoded = DocumentCodec.decodeModel(text, "m.model.json")
        assertThat(decoded).isInstanceOf(DecodeResult.Ok::class.java)
        assertThat((decoded as DecodeResult.Ok).value.blocks.keys).containsExactly("c")

        val unknownField = DocumentCodec.decodeModel("""{"schemaVersion": 1, "blocks": {}, "extra": 1}""", "m.model.json")
        assertThat((unknownField as DecodeResult.Failed).diagnostics.single().code).isEqualTo("DOCUMENT_SHAPE")

        val wrongVersion = DocumentCodec.decodeModel("""{"schemaVersion": 2, "blocks": {}}""", "m.model.json")
        val diagnostic = (wrongVersion as DecodeResult.Failed).diagnostics.single()
        assertThat(diagnostic.code).isEqualTo("SCHEMA_VERSION")
        assertThat(diagnostic.pointer).isEqualTo("/schemaVersion")
    }

    @Test
    fun `writes canonical text with sorted keys, two-space indent and a final newline`() {
        val model =
            ModelFile(
                schemaVersion = 1,
                blocks =
                    linkedMapOf(
                        "b" to
                            BlockInstance(
                                type = "service",
                                params =
                                    buildJsonObject {
                                        put("queue", 1)
                                        put("handlers", 2)
                                    },
                            ),
                        "a" to BlockInstance(type = "client"),
                    ),
            )

        val text = DocumentCodec.encodeModel(model)

        assertThat(text).isEqualTo(
            """
            {
              "blocks": {
                "a": {
                  "type": "client"
                },
                "b": {
                  "params": {
                    "handlers": 2,
                    "queue": 1
                  },
                  "type": "service"
                }
              },
              "schemaVersion": 1
            }

            """.trimIndent(),
        )
        assertThat((DocumentCodec.decodeModel(text, "m.model.json") as DecodeResult.Ok).value).isEqualTo(model)
    }

    @Test
    fun `round-trips experiment and layout documents`() {
        val experiment =
            ExperimentFile(
                schemaVersion = 1,
                modelRef = "m.model.json",
                execution = ExecutionSettings(replications = 2, warmup = "0ms", measurement = "1s", seed = 7),
                variants = listOf(Variant(id = "baseline")),
            )
        val layout = LayoutFile(schemaVersion = 1, positions = mapOf("a" to Position(0.0, 100.0)))

        val decodedExperiment = DocumentCodec.decodeExperiment(DocumentCodec.encodeExperiment(experiment), "e.experiment.json")
        val decodedLayout = DocumentCodec.decodeLayout(DocumentCodec.encodeLayout(layout), "l.layout.json")

        assertThat((decodedExperiment as DecodeResult.Ok).value).isEqualTo(experiment)
        assertThat((decodedLayout as DecodeResult.Ok).value).isEqualTo(layout)
    }

    @Test
    fun `keeps descriptions and notes of documents, blocks and connections`() {
        val model =
            ModelFile(
                schemaVersion = 1,
                description = "Chain",
                notes = "Calibrated on staging",
                blocks = mapOf("a" to BlockInstance(type = "client", description = "Load", notes = "Peak hour")),
                connections =
                    listOf(ConnectionInstance(id = "c", type = "request", from = "a", to = "b", description = "Entry", notes = "Direct")),
            )

        val text = DocumentCodec.encodeModel(model)

        assertThat((DocumentCodec.decodeModel(text, "m.model.json") as DecodeResult.Ok).value).isEqualTo(model)
        assertThat(text).contains("\"notes\": \"Peak hour\"", "\"notes\": \"Direct\"")
    }
}
```

- [ ] **Step 2: Тест падает**

Run: `./gradlew :core:test --tests 'resiliencelab.core.document.DocumentCodecTest'`
Expected: FAIL — `Unresolved reference: StrictJson`.

- [ ] **Step 3: `Documents.kt`**

```kotlin
package resiliencelab.core.document

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** `*.model.json`: blocks by id and connections between them (ADR 0005, stage 1 design §3.2). */
@Serializable
data class ModelFile(
    val schemaVersion: Int,
    val description: String? = null,
    val notes: String? = null,
    val blocks: Map<String, BlockInstance>,
    val connections: List<ConnectionInstance> = emptyList(),
)

/** One block: catalog type, parameter values as written in the document and explanations (ADR 0005, item 5). */
@Serializable
data class BlockInstance(
    val type: String,
    val params: JsonObject = JsonObject(emptyMap()),
    val description: String? = null,
    val notes: String? = null,
)

/** One connection from a source block to a target block. */
@Serializable
data class ConnectionInstance(
    val id: String,
    val type: String,
    val from: String,
    val to: String,
    val params: JsonObject = JsonObject(emptyMap()),
    val description: String? = null,
    val notes: String? = null,
)

/** `*.layout.json`: canvas positions by block path. */
@Serializable
data class LayoutFile(
    val schemaVersion: Int,
    val positions: Map<String, Position> = emptyMap(),
)

/** Top-left corner of a block on the canvas. */
@Serializable
data class Position(
    val x: Double,
    val y: Double,
)

/** `*.experiment.json`: the model reference, run settings, faults and variants as path overrides (ADR 0002). */
@Serializable
data class ExperimentFile(
    val schemaVersion: Int,
    val description: String? = null,
    val notes: String? = null,
    val modelRef: String,
    val layoutRef: String? = null,
    val execution: ExecutionSettings,
    val faults: List<Fault> = emptyList(),
    val variants: List<Variant>,
)

/** Replications, measurement window and seed; durations are quantities such as `1s`. */
@Serializable
data class ExecutionSettings(
    val replications: Int,
    val warmup: String,
    val measurement: String,
    val seed: Long,
    val maxRealTime: String = "30s",
)

/** A degradation of the [target] service while local processing starts within [from, to). */
@Serializable
data class Fault(
    val target: String,
    val from: String,
    val to: String,
    val processingMultiplier: Double? = null,
    val failureRate: String? = null,
)

/** A variant: parameter overrides keyed by `blockOrConnectionId.param[.field]`. */
@Serializable
data class Variant(
    val id: String,
    val label: String? = null,
    val overrides: Map<String, JsonElement> = emptyMap(),
)
```

- [ ] **Step 4: `StrictJson.kt`**

```kotlin
package resiliencelab.core.document

import com.fasterxml.jackson.core.JsonFactory
import com.fasterxml.jackson.core.JsonParseException
import com.fasterxml.jackson.core.JsonToken
import com.fasterxml.jackson.core.StreamReadFeature
import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.compiler.Severity

/** Rejects what kotlinx would silently accept: duplicate keys and non-finite numbers (ADR 0005, item 7). */
object StrictJson {
    private val factory: JsonFactory =
        JsonFactory
            .builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .build()

    /** Returns a diagnostic for the first problem in [text], or null when the text is acceptable. */
    fun check(
        text: String,
        document: String,
    ): Diagnostic? =
        try {
            factory.createParser(text).use { parser ->
                var problem: Diagnostic? = null
                while (problem == null) {
                    val token = parser.nextToken() ?: break
                    if (token == JsonToken.VALUE_NUMBER_FLOAT && !parser.doubleValue.isFinite()) {
                        problem =
                            Diagnostic(
                                code = "JSON_NON_FINITE",
                                severity = Severity.ERROR,
                                message = "Number at line ${parser.currentLocation().lineNr} is not finite",
                                document = document,
                            )
                    }
                }
                problem
            }
        } catch (exception: JsonParseException) {
            val code = if (exception.originalMessage.startsWith("Duplicate field")) "JSON_DUPLICATE_KEY" else "JSON_SYNTAX"
            Diagnostic(
                code = code,
                severity = Severity.ERROR,
                message = "${exception.originalMessage} at line ${exception.location?.lineNr}, column ${exception.location?.columnNr}",
                document = document,
            )
        }
}
```

- [ ] **Step 5: `DocumentCodec.kt`**

```kotlin
package resiliencelab.core.document

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.compiler.Severity

/** Outcome of decoding one document. */
sealed interface DecodeResult<out T> {
    data class Ok<T>(
        val value: T,
    ) : DecodeResult<T>

    data class Failed(
        val diagnostics: List<Diagnostic>,
    ) : DecodeResult<Nothing>
}

/** Strict reading and deterministic writing of workspace documents (ADR 0005, items 4 and 7). */
object DocumentCodec {
    const val SCHEMA_VERSION = 1

    @OptIn(ExperimentalSerializationApi::class)
    private val reader =
        Json {
            ignoreUnknownKeys = false
            explicitNulls = false
        }

    @OptIn(ExperimentalSerializationApi::class)
    private val writer =
        Json {
            prettyPrint = true
            prettyPrintIndent = "  "
            explicitNulls = false
            encodeDefaults = false
        }

    fun decodeModel(
        text: String,
        document: String,
    ): DecodeResult<ModelFile> = decode(text, document, ModelFile.serializer()) { it.schemaVersion }

    fun decodeLayout(
        text: String,
        document: String,
    ): DecodeResult<LayoutFile> = decode(text, document, LayoutFile.serializer()) { it.schemaVersion }

    fun decodeExperiment(
        text: String,
        document: String,
    ): DecodeResult<ExperimentFile> = decode(text, document, ExperimentFile.serializer()) { it.schemaVersion }

    fun encodeModel(file: ModelFile): String = encode(ModelFile.serializer(), file)

    fun encodeLayout(file: LayoutFile): String = encode(LayoutFile.serializer(), file)

    fun encodeExperiment(file: ExperimentFile): String = encode(ExperimentFile.serializer(), file)

    /** Canonical text: object keys sorted recursively, arrays in order, two-space indent, LF, final newline. */
    fun <T> encode(
        serializer: KSerializer<T>,
        value: T,
    ): String = writer.encodeToString(JsonElement.serializer(), canonical(writer.encodeToJsonElement(serializer, value))) + "\n"

    private fun canonical(element: JsonElement): JsonElement =
        when (element) {
            is JsonObject -> JsonObject(element.toSortedMap().mapValues { (_, value) -> canonical(value) })
            is JsonArray -> JsonArray(element.map(::canonical))
            else -> element
        }

    private fun <T> decode(
        text: String,
        document: String,
        serializer: KSerializer<T>,
        version: (T) -> Int,
    ): DecodeResult<T> {
        StrictJson.check(text, document)?.let { return DecodeResult.Failed(listOf(it)) }
        val value =
            try {
                reader.decodeFromString(serializer, text)
            } catch (exception: SerializationException) {
                return DecodeResult.Failed(listOf(shape(exception, document)))
            } catch (exception: IllegalArgumentException) {
                return DecodeResult.Failed(listOf(shape(exception, document)))
            }
        if (version(value) != SCHEMA_VERSION) {
            return DecodeResult.Failed(
                listOf(
                    Diagnostic(
                        code = "SCHEMA_VERSION",
                        severity = Severity.ERROR,
                        message = "Unsupported schemaVersion ${version(value)}; expected $SCHEMA_VERSION",
                        document = document,
                        pointer = "/schemaVersion",
                    ),
                ),
            )
        }
        return DecodeResult.Ok(value)
    }

    private fun shape(
        exception: Exception,
        document: String,
    ) = Diagnostic(
        code = "DOCUMENT_SHAPE",
        severity = Severity.ERROR,
        message = exception.message ?: "Document does not match its schema",
        document = document,
    )
}
```

- [ ] **Step 6: Тест проходит**

Run: `./gradlew :core:test --tests 'resiliencelab.core.document.DocumentCodecTest'`
Expected: PASS. Если отличается только оформление пустых объектов или чисел в ожидаемом тексте — сверить с фактическим выводом kotlinx и поправить ожидание, не меняя правил записи.

- [ ] **Step 7: Commit**

```bash
./gradlew :core:ktlintFormat
git add core/src/main/kotlin/resiliencelab/core/document core/src/test/kotlin/resiliencelab/core/document
git commit -m "feat(core): add strict document codec with canonical writer"
```

---

### Task 5: Промежуточное представление

**Files:**
- Create: `core/src/main/kotlin/resiliencelab/core/ir/ChainIr.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/ir/ChainIrTest.kt`

Каждый элемент IR хранит происхождение — документ и указатель JSON (ADR 0002, п. 3); компилятор (Task 7) заполняет его, IR, собранная в коде (тесты, адаптер MVP), получает `Origin.UNSPECIFIED`.

- [ ] **Step 1: Написать падающий тест**

```kotlin
package resiliencelab.core.ir

import org.assertj.core.api.Assertions.assertThat
import kotlin.test.Test

class ChainIrTest {
    private val fixed = Distribution(DistributionShape.FIXED, 1.0)
    private val chain =
        ChainIr(
            client = ClientNode("client", arrivalRatePerMs = 0.1, deadlineMs = 100.0),
            entry = "a",
            services = listOf(ServiceNode("a", 1, 0, fixed, 0.0), ServiceNode("b", 1, 0, fixed, 0.0)),
            calls =
                listOf(
                    CallEdge(
                        path = "a-to-b",
                        from = "a",
                        to = "b",
                        network = fixed,
                        timeoutMs = 10.0,
                        attempts = 1,
                        backoff = Backoff(BackoffKind.NONE, 0.0, 0.0, 2.0),
                        origin = Origin("m.model.json", "/connections/1"),
                    ),
                ),
            faults = emptyList(),
            run = RunSettings(replications = 1, warmupMs = 0.0, measurementMs = 100.0, seed = 1, maxRealTimeSeconds = 30),
        )

    @Test
    fun `finds the outgoing call of a service`() {
        assertThat(chain.outgoingCall("a")?.path).isEqualTo("a-to-b")
        assertThat(chain.outgoingCall("b")).isNull()
    }

    @Test
    fun `keeps the origin of compiled elements and marks elements built in code`() {
        assertThat(chain.calls.single().origin).isEqualTo(Origin("m.model.json", "/connections/1"))
        assertThat(chain.services.first().origin).isEqualTo(Origin.UNSPECIFIED)
    }
}
```

- [ ] **Step 2: Тест падает**

Run: `./gradlew :core:test --tests 'resiliencelab.core.ir.ChainIrTest'`
Expected: FAIL — `Unresolved reference: ChainIr`.

- [ ] **Step 3: Реализация**

```kotlin
package resiliencelab.core.ir

/** Shape of a duration distribution. */
enum class DistributionShape {
    FIXED,
    EXPONENTIAL,
    LOGNORMAL,
}

/** Duration distribution in milliseconds; [stdDevMs] is set for [DistributionShape.LOGNORMAL] only. */
data class Distribution(
    val shape: DistributionShape,
    val meanMs: Double,
    val stdDevMs: Double? = null,
)

/** Delay policy between attempts. */
enum class BackoffKind {
    NONE,
    FIXED,
    EXPONENTIAL_FULL_JITTER,
}

/** Backoff in milliseconds; [multiplier] grows exponential delays. */
data class Backoff(
    val kind: BackoffKind,
    val baseMs: Double,
    val maxMs: Double,
    val multiplier: Double,
)

/** Where an IR element is defined (ADR 0002, item 3): the document and the JSON pointer in it. */
data class Origin(
    val document: String,
    val pointer: String,
) {
    companion object {
        /** Origin of IR built in code rather than compiled from documents (tests, the MVP adapter). */
        val UNSPECIFIED = Origin("", "")
    }
}

/** Source of original requests. */
data class ClientNode(
    val path: String,
    val arrivalRatePerMs: Double,
    val deadlineMs: Double,
    val origin: Origin = Origin.UNSPECIFIED,
)

/** Blocking service with a bounded FIFO queue. */
data class ServiceNode(
    val path: String,
    val handlers: Int,
    val queueCapacity: Int,
    val processing: Distribution,
    val failureProbability: Double,
    val origin: Origin = Origin.UNSPECIFIED,
)

/** Synchronous call from [from] to [to]. */
data class CallEdge(
    val path: String,
    val from: String,
    val to: String,
    val network: Distribution,
    val timeoutMs: Double,
    val attempts: Int,
    val backoff: Backoff,
    val origin: Origin = Origin.UNSPECIFIED,
)

/** Degradation of [target] while local processing starts within [fromMs, toMs). */
data class FaultSpan(
    val target: String,
    val fromMs: Double,
    val toMs: Double,
    val processingMultiplier: Double?,
    val failureProbability: Double?,
    val origin: Origin = Origin.UNSPECIFIED,
)

/** Replications, measurement window, seed and real-time cap of a run. */
data class RunSettings(
    val replications: Int,
    val warmupMs: Double,
    val measurementMs: Double,
    val seed: Long,
    val maxRealTimeSeconds: Long,
)

/**
 * Engine-neutral form of one variant (ADR 0002): a linear chain from [client] through [entry].
 * The compiler orders services, calls and faults canonically so that document order never changes a run.
 */
data class ChainIr(
    val client: ClientNode,
    val entry: String,
    val services: List<ServiceNode>,
    val calls: List<CallEdge>,
    val faults: List<FaultSpan>,
    val run: RunSettings,
) {
    fun outgoingCall(from: String): CallEdge? = calls.firstOrNull { it.from == from }
}
```

- [ ] **Step 4: Тест проходит**

Run: `./gradlew :core:test --tests 'resiliencelab.core.ir.ChainIrTest'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
./gradlew :core:ktlintFormat
git add core/src/main/kotlin/resiliencelab/core/ir/ChainIr.kt core/src/test/kotlin/resiliencelab/core/ir/ChainIrTest.kt
git commit -m "feat(core): add chain intermediate representation with element origins"
```

---

### Task 6: Чтение параметров по каталогу

**Files:**
- Create: `core/src/main/kotlin/resiliencelab/core/compiler/ParamReader.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/compiler/ParamReaderTest.kt`

- [ ] **Step 1: Написать падающий тест**

```kotlin
package resiliencelab.core.compiler

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.catalog.ParamDescriptor
import resiliencelab.core.catalog.Stage1Catalog
import kotlin.test.Test

class ParamReaderTest {
    private val serviceParams = Stage1Catalog.catalog.type("service")!!.params
    private val callParams = Stage1Catalog.catalog.type("call")!!.params

    private fun reader(
        json: String,
        diagnostics: MutableList<Diagnostic>,
        params: List<ParamDescriptor> = serviceParams,
    ) = ParamReader(
        Json.parseToJsonElement(json).jsonObject,
        params,
        "m.model.json",
        "/blocks/svc/params",
        "svc",
        diagnostics,
    )

    @Test
    fun `reads typed values and applies defaults`() {
        val diagnostics = mutableListOf<Diagnostic>()
        val reader = reader("""{"handlers": 4, "processing": {"kind": "fixed", "mean": "2ms"}}""", diagnostics)

        assertThat(reader.int("handlers")).isEqualTo(4)
        assertThat(reader.int("queue")).isEqualTo(0)
        assertThat(reader.quantity("failureRate")).isEqualTo(0.0)
        val processing = reader.obj("processing")!!
        assertThat(processing.choice("kind")).isEqualTo("fixed")
        assertThat(processing.quantity("mean")).isEqualTo(2.0)
        assertThat(processing.has("stdDev")).isFalse()
        assertThat(processing.quantity("stdDev")).isNull()
        assertThat(diagnostics).isEmpty()
    }

    @Test
    fun `reports unknown, missing, mistyped and out-of-range parameters with pointers`() {
        val diagnostics = mutableListOf<Diagnostic>()
        val reader =
            reader("""{"handlers": "4", "queue": -1, "failureRate": "150%", "extra": 1}""", diagnostics)

        assertThat(reader.int("handlers")).isNull()
        assertThat(reader.int("queue")).isNull()
        assertThat(reader.quantity("failureRate")).isNull()
        assertThat(reader.obj("processing")).isNull()

        assertThat(diagnostics.map { it.code to it.pointer }).containsExactly(
            "PARAM_UNKNOWN" to "/blocks/svc/params/extra",
            "PARAM_TYPE" to "/blocks/svc/params/handlers",
            "PARAM_RANGE" to "/blocks/svc/params/queue",
            "PARAM_RANGE" to "/blocks/svc/params/failureRate",
            "PARAM_MISSING" to "/blocks/svc/params/processing",
        )
        assertThat(diagnostics).allMatch { it.path == "svc" && it.severity == Severity.ERROR }
    }

    @Test
    fun `reads numbers, choices and nested defaults`() {
        val diagnostics = mutableListOf<Diagnostic>()
        val reader = reader("""{"timeout": "80ms", "backoff": {"kind": "slow"}}""", diagnostics, callParams)

        assertThat(reader.obj("network")!!.quantity("mean")).isEqualTo(0.0)
        val backoff = reader.obj("backoff")!!
        assertThat(backoff.choice("kind")).isNull()
        assertThat(backoff.number("multiplier")).isEqualTo(2.0)
        assertThat(reader.quantity("timeout")).isEqualTo(80.0)
        assertThat(diagnostics.single().code).isEqualTo("PARAM_TYPE")
        assertThat(diagnostics.single().pointer).isEqualTo("/blocks/svc/params/backoff/kind")
    }

    @Test
    fun `rejects quantities without a unit and non-object values`() {
        val diagnostics = mutableListOf<Diagnostic>()
        val reader = reader("""{"timeout": 80, "network": "fast", "attempts": 0}""", diagnostics, callParams)

        assertThat(reader.quantity("timeout")).isNull()
        assertThat(reader.obj("network")).isNull()
        assertThat(reader.int("attempts")).isNull()
        assertThat(diagnostics.map { it.code }).containsExactly("QUANTITY_INVALID", "PARAM_TYPE", "PARAM_RANGE")
    }

    @Test
    fun `reports overridden values at their place in the experiment`() {
        val diagnostics = mutableListOf<Diagnostic>()
        val overrides =
            OverrideOrigins(
                "e.experiment.json",
                mapOf("attempts" to "/variants/1/overrides/c.attempts", "backoff" to "/variants/1/overrides/c.backoff"),
            )
        val params = Json.parseToJsonElement("""{"timeout": "x", "attempts": 0, "backoff": {"kind": "slow"}}""").jsonObject
        val reader = ParamReader(params, callParams, "m.model.json", "/connections/1/params", "c", diagnostics, overrides)

        reader.quantity("timeout")
        reader.int("attempts")
        reader.obj("backoff")!!.choice("kind")

        assertThat(diagnostics.map { it.document to it.pointer }).containsExactly(
            "m.model.json" to "/connections/1/params/timeout",
            "e.experiment.json" to "/variants/1/overrides/c.attempts",
            "e.experiment.json" to "/variants/1/overrides/c.backoff",
        )
    }
}
```

- [ ] **Step 2: Тест падает**

Run: `./gradlew :core:test --tests 'resiliencelab.core.compiler.ParamReaderTest'`
Expected: FAIL — `Unresolved reference: ParamReader`.

- [ ] **Step 3: Реализация**

```kotlin
package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import resiliencelab.core.catalog.ParamDescriptor
import resiliencelab.core.catalog.Quantities

/** Where overridden values of one element come from: parameter path (`attempts`, `backoff.base`) → experiment pointer. */
internal class OverrideOrigins(
    val document: String,
    private val pointers: Map<String, String>,
) {
    /** Pointer of the override that set [parameter] or an object holding it; null when the value comes from the model. */
    fun pointerOf(parameter: String): String? =
        pointers.entries.firstOrNull { (path, _) -> parameter == path || parameter.startsWith("$path.") }?.value

    companion object {
        val NONE = OverrideOrigins("", emptyMap())
    }
}

/**
 * Reads document parameters against catalog descriptors. Every null result has a diagnostic, except optional
 * parameters without a default, which are simply absent. A diagnostic about a value set by a variant override points
 * to that override in the experiment, otherwise to the parameter in the model.
 */
internal class ParamReader(
    private val params: JsonObject,
    private val descriptors: List<ParamDescriptor>,
    private val document: String,
    private val pointer: String,
    private val path: String,
    private val diagnostics: MutableList<Diagnostic>,
    private val overrides: OverrideOrigins = OverrideOrigins.NONE,
    private val prefix: String = "",
) {
    init {
        params.keys
            .filter { key -> descriptors.none { it.name == key } }
            .sorted()
            .forEach { key -> report("PARAM_UNKNOWN", "Unknown parameter '$key'", key) }
    }

    fun has(name: String): Boolean = params[name].let { it != null && it !is JsonNull }

    fun int(name: String): Int? {
        val descriptor = descriptor(name)
        val element = valueOf(descriptor) ?: return null
        val value =
            (element as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
                ?: return fail("PARAM_TYPE", name, "Parameter '$name' must be an integer")
        return value.takeIf { inRange(descriptor, value.toDouble()) }
    }

    fun number(name: String): Double? {
        val descriptor = descriptor(name)
        val element = valueOf(descriptor) ?: return null
        val value =
            (element as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull?.takeIf { it.isFinite() }
                ?: return fail("PARAM_TYPE", name, "Parameter '$name' must be a number")
        return value.takeIf { inRange(descriptor, value) }
    }

    fun quantity(name: String): Double? {
        val descriptor = descriptor(name)
        val element = valueOf(descriptor) ?: return null
        val dimension = requireNotNull(descriptor.dimension) { "Quantity '$name' has no dimension" }
        val text = (element as? JsonPrimitive)?.takeIf { it.isString }?.content
        val value =
            text?.let { Quantities.parse(it, dimension) }
                ?: return fail(
                    "QUANTITY_INVALID",
                    name,
                    "Parameter '$name' must be a quantity with one of the units ${Quantities.unitsOf(dimension).joinToString()}",
                )
        return value.takeIf { inRange(descriptor, value) }
    }

    fun choice(name: String): String? {
        val descriptor = descriptor(name)
        val element = valueOf(descriptor) ?: return null
        val text = (element as? JsonPrimitive)?.takeIf { it.isString }?.content
        return text?.takeIf { it in descriptor.options }
            ?: fail("PARAM_TYPE", name, "Parameter '$name' must be one of ${descriptor.options.joinToString()}")
    }

    fun obj(name: String): ParamReader? {
        val descriptor = descriptor(name)
        val element = valueOf(descriptor) ?: return null
        val value = element as? JsonObject ?: return fail("PARAM_TYPE", name, "Parameter '$name' must be an object")
        val childPointer = JsonPointer.child(pointer, name)
        return ParamReader(value, descriptor.fields, document, childPointer, path, diagnostics, overrides, "$prefix$name.")
    }

    /** Reports an error about parameter [name] and returns null. */
    fun <T> fail(
        code: String,
        name: String,
        message: String,
    ): T? {
        report(code, message, name)
        return null
    }

    private fun descriptor(name: String): ParamDescriptor = descriptors.first { it.name == name }

    private fun valueOf(descriptor: ParamDescriptor): JsonElement? {
        val explicit = params[descriptor.name]?.takeUnless { it is JsonNull }
        if (explicit != null) return explicit
        if (descriptor.required) report("PARAM_MISSING", "Required parameter '${descriptor.name}' is missing", descriptor.name)
        return descriptor.default
    }

    private fun inRange(
        descriptor: ParamDescriptor,
        value: Double,
    ): Boolean {
        val below =
            descriptor.minimum?.let { value < it } == true ||
                descriptor.exclusiveMinimum?.let { value <= it } == true
        val above = descriptor.maximum?.let { value > it } == true
        if (below || above) {
            report("PARAM_RANGE", "Parameter '${descriptor.name}' is out of range: ${rangeText(descriptor)}", descriptor.name)
        }
        return !(below || above)
    }

    private fun rangeText(descriptor: ParamDescriptor): String =
        listOfNotNull(
            descriptor.minimum?.let { ">= ${shown(descriptor, it)}" },
            descriptor.exclusiveMinimum?.let { "> ${shown(descriptor, it)}" },
            descriptor.maximum?.let { "<= ${shown(descriptor, it)}" },
        ).joinToString(" and ")

    private fun shown(
        descriptor: ParamDescriptor,
        value: Double,
    ): String = descriptor.dimension?.let { Quantities.format(value, it) } ?: Quantities.plain(value)

    private fun report(
        code: String,
        message: String,
        name: String,
    ) {
        val override = overrides.pointerOf(prefix + name)
        diagnostics +=
            if (override == null) {
                Diagnostic(code, Severity.ERROR, message, document, JsonPointer.child(pointer, name), path)
            } else {
                Diagnostic(code, Severity.ERROR, message, overrides.document, override, path)
            }
    }
}
```

- [ ] **Step 4: Тест проходит**

Run: `./gradlew :core:test --tests 'resiliencelab.core.compiler.ParamReaderTest'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
./gradlew :core:ktlintFormat
git add core/src/main/kotlin/resiliencelab/core/compiler/ParamReader.kt core/src/test/kotlin/resiliencelab/core/compiler/ParamReaderTest.kt
git commit -m "feat(core): read block parameters against the catalog"
```

---

### Task 7: Компилятор модели

**Files:**
- Create: `core/src/main/kotlin/resiliencelab/core/compiler/ModelCompiler.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/compiler/ModelCompilerTest.kt`

- [ ] **Step 1: Написать падающий тест**

```kotlin
package resiliencelab.core.compiler

import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.document.ExperimentFile
import resiliencelab.core.document.ModelFile
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.Origin
import kotlin.test.Test

class ModelCompilerTest {
    private val compiler = ModelCompiler()

    private val model =
        """
        {"schemaVersion": 1, "blocks": {
          "client": {"type": "client", "params": {"rate": "120/s", "deadline": "250ms"}},
          "gateway": {"type": "service", "params": {"handlers": 4, "queue": 16, "processing": {"kind": "fixed", "mean": "1ms"}}},
          "dependency": {"type": "service", "params": {"handlers": 2, "queue": 8, "processing": {"kind": "exponential", "mean": "8ms"}}}
        }, "connections": [
          {"id": "client-to-gateway", "type": "request", "from": "client", "to": "gateway"},
          {"id": "gateway-to-dependency", "type": "call", "from": "gateway", "to": "dependency",
           "params": {"timeout": "80ms", "attempts": 3, "backoff": {"kind": "exponential-full-jitter", "base": "2ms", "max": "20ms"}}}
        ]}
        """.trimIndent()

    private val experiment =
        """
        {"schemaVersion": 1, "modelRef": "m.model.json",
         "execution": {"replications": 2, "warmup": "0ms", "measurement": "1s", "seed": 20261025},
         "faults": [{"target": "dependency", "from": "200ms", "to": "700ms", "processingMultiplier": 6.0, "failureRate": "5%"}],
         "variants": [{"id": "baseline"}, {"id": "no-retries", "label": "No retries", "overrides": {"gateway-to-dependency.attempts": 1}}]}
        """.trimIndent()

    private fun model(text: String = model): ModelFile = (DocumentCodec.decodeModel(text, "m.model.json") as DecodeResult.Ok).value

    private fun experiment(text: String = experiment): ExperimentFile =
        (DocumentCodec.decodeExperiment(text, "e.experiment.json") as DecodeResult.Ok).value

    private fun compile(
        modelText: String = model,
        experimentText: String = experiment,
    ) = compiler.compile(model(modelText), "m.model.json", experiment(experimentText), "e.experiment.json")

    private fun codes(result: CompileResult) = result.diagnostics.map { it.code }

    @Test
    fun `compiles every variant into a canonical chain`() {
        val result = compile()

        assertThat(result.diagnostics).isEmpty()
        val compiled = result.experiment!!
        assertThat(compiled.run.replications).isEqualTo(2)
        assertThat(compiled.run.measurementMs).isEqualTo(1_000.0)
        assertThat(compiled.run.maxRealTimeSeconds).isEqualTo(30L)
        val baseline = compiled.variants.first { it.id == "baseline" }.chain
        assertThat(baseline.client.arrivalRatePerMs).isEqualTo(0.12)
        assertThat(baseline.client.deadlineMs).isEqualTo(250.0)
        assertThat(baseline.entry).isEqualTo("gateway")
        assertThat(baseline.services.map { it.path }).containsExactly("dependency", "gateway")
        assertThat(baseline.services.first().processing.shape).isEqualTo(DistributionShape.EXPONENTIAL)
        val call = baseline.calls.single()
        assertThat(call.attempts).isEqualTo(3)
        assertThat(call.backoff.kind).isEqualTo(BackoffKind.EXPONENTIAL_FULL_JITTER)
        assertThat(call.backoff.multiplier).isEqualTo(2.0)
        assertThat(call.network.meanMs).isEqualTo(0.0)
        assertThat(baseline.faults.single().failureProbability).isEqualTo(0.05)
        val noRetries = compiled.variants.first { it.id == "no-retries" }
        assertThat(noRetries.label).isEqualTo("No retries")
        assertThat(noRetries.chain.calls.single().attempts).isEqualTo(1)
    }

    @Test
    fun `records where every element is defined`() {
        val chain = compile().experiment!!.variants.first().chain

        assertThat(chain.client.origin).isEqualTo(Origin("m.model.json", "/blocks/client"))
        assertThat(chain.services.first().origin).isEqualTo(Origin("m.model.json", "/blocks/dependency"))
        assertThat(chain.calls.single().origin).isEqualTo(Origin("m.model.json", "/connections/1"))
        assertThat(chain.faults.single().origin).isEqualTo(Origin("e.experiment.json", "/faults/0"))
    }

    @Test
    fun `reports invalid override values at their place in the experiment`() {
        val overrides = "\"gateway-to-dependency.attempts\": 0, \"gateway-to-dependency.backoff.base\": \"x\""
        val broken = experiment.replace("\"gateway-to-dependency.attempts\": 1", overrides)

        val diagnostics = compile(experimentText = broken).diagnostics

        assertThat(diagnostics.map { Triple(it.code, it.document, it.pointer) }).containsExactlyInAnyOrder(
            Triple("PARAM_RANGE", "e.experiment.json", "/variants/1/overrides/gateway-to-dependency.attempts"),
            Triple("QUANTITY_INVALID", "e.experiment.json", "/variants/1/overrides/gateway-to-dependency.backoff.base"),
        )
    }

    @Test
    fun `request connections take no parameters`() {
        val broken = model.replace("\"to\": \"gateway\"}", "\"to\": \"gateway\", \"params\": {\"attempts\": 3}}")

        val diagnostic = compile(modelText = broken).diagnostics.single()

        assertThat(diagnostic.code).isEqualTo("PARAM_UNKNOWN")
        assertThat(diagnostic.pointer).isEqualTo("/connections/0/params/attempts")
    }

    @Test
    fun `rejects values whose derived quantities are not finite`() {
        val tinyRate = model.replace("\"rate\": \"120/s\"", "\"rate\": \"1e-320/ms\"")
        val rate = compile(modelText = tinyRate).diagnostics.single()
        assertThat(rate.code to rate.pointer).isEqualTo("PARAM_RANGE" to "/blocks/client/params/rate")

        val endless =
            experiment.replace("\"warmup\": \"0ms\", \"measurement\": \"1s\"", "\"warmup\": \"1e308ms\", \"measurement\": \"1e308ms\"")
        val window = compile(experimentText = endless).diagnostics.single()
        assertThat(window.code to window.pointer).isEqualTo("EXECUTION_RANGE" to "/execution/measurement")
    }

    @Test
    fun `document order does not change the compiled experiment`() {
        val reordered =
            """
            {"schemaVersion": 1, "connections": [
              {"id": "gateway-to-dependency", "type": "call", "from": "gateway", "to": "dependency",
               "params": {"backoff": {"max": "20ms", "base": "2ms", "kind": "exponential-full-jitter"}, "attempts": 3, "timeout": "80ms"}},
              {"id": "client-to-gateway", "type": "request", "from": "client", "to": "gateway"}
            ], "blocks": {
              "dependency": {"type": "service",
                "params": {"processing": {"mean": "8ms", "kind": "exponential"}, "queue": 8, "handlers": 2}},
              "gateway": {"type": "service",
                "params": {"queue": 16, "handlers": 4, "processing": {"kind": "fixed", "mean": "1ms"}}},
              "client": {"type": "client", "params": {"deadline": "250ms", "rate": "120/s"}}
            }}
            """.trimIndent()

        assertThat(compile(modelText = reordered).experiment!!.withoutOrigins()).isEqualTo(compile().experiment!!.withoutOrigins())
    }

    /** Pointers of connections depend on their array position; everything the engine reads must not. */
    private fun CompiledExperiment.withoutOrigins(): CompiledExperiment =
        copy(
            variants =
                variants.map { variant ->
                    val chain = variant.chain
                    variant.copy(
                        chain =
                            chain.copy(
                                client = chain.client.copy(origin = Origin.UNSPECIFIED),
                                services = chain.services.map { it.copy(origin = Origin.UNSPECIFIED) },
                                calls = chain.calls.map { it.copy(origin = Origin.UNSPECIFIED) },
                                faults = chain.faults.map { it.copy(origin = Origin.UNSPECIFIED) },
                            ),
                    )
                },
        )

    @Test
    fun `reports unknown types with pointers`() {
        val broken = model.replace("\"type\": \"client\"", "\"type\": \"robot\"")

        val result = compile(modelText = broken)

        assertThat(result.experiment).isNull()
        assertThat(result.diagnostics.map { it.code to it.pointer }).contains("TYPE_UNKNOWN" to "/blocks/client/type")
    }

    @Test
    fun `reports missing parameters with pointers and block paths`() {
        val broken = model.replace("\"handlers\": 2, ", "")

        val diagnostic = compile(modelText = broken).diagnostics.single()

        assertThat(diagnostic.code).isEqualTo("PARAM_MISSING")
        assertThat(diagnostic.pointer).isEqualTo("/blocks/dependency/params/handlers")
        assertThat(diagnostic.path).isEqualTo("dependency")
        assertThat(diagnostic.document).isEqualTo("m.model.json")
    }

    @Test
    fun `rejects connections that join the wrong block types or unknown blocks`() {
        val broken =
            model
                .replace("\"type\": \"request\"", "\"type\": \"call\"")
                .replace("\"to\": \"dependency\"", "\"to\": \"nowhere\"")

        val result = compile(modelText = broken)

        assertThat(codes(result)).contains("CONNECTION_TYPE", "CONNECTION_ENDPOINT")
    }

    @Test
    fun `enforces exactly one client and a linear chain`() {
        val twoClients =
            model.replace(
                "\"gateway\": {",
                "\"spare\": {\"type\": \"client\", \"params\": {\"rate\": \"1/s\", \"deadline\": \"1s\"}}, \"gateway\": {",
            )
        assertThat(codes(compile(modelText = twoClients))).contains("TOPOLOGY_CLIENT")

        val orphan = """"orphan": {"type": "service", "params": {"handlers": 1, "processing": {"kind": "fixed", "mean": "1ms"}}}"""
        val unreachable = model.replace("\"dependency\": {", "$orphan, \"dependency\": {")
        val result = compile(modelText = unreachable)
        assertThat(result.diagnostics.single { it.code == "TOPOLOGY_CHAIN" }.path).isEqualTo("orphan")

        val back = """{"id": "back", "type": "call", "from": "dependency", "to": "gateway", "params": {"timeout": "10ms"}}"""
        val cycle = model.replace("]}", ", $back]}")
        assertThat(codes(compile(modelText = cycle))).contains("TOPOLOGY_CHAIN")
    }

    @Test
    fun `reports override paths that name no parameter`() {
        val broken = experiment.replace("gateway-to-dependency.attempts", "gateway-to-dependency.retries")

        val diagnostic = compile(experimentText = broken).diagnostics.single()

        assertThat(diagnostic.code).isEqualTo("OVERRIDE_PATH")
        assertThat(diagnostic.pointer).isEqualTo("/variants/1/overrides/gateway-to-dependency.retries")
        assertThat(diagnostic.document).isEqualTo("e.experiment.json")
    }

    @Test
    fun `applies nested overrides on top of defaults`() {
        val nested = experiment.replace("\"gateway-to-dependency.attempts\": 1", "\"gateway-to-dependency.network.mean\": \"3ms\"")

        val chain = compile(experimentText = nested).experiment!!.variants.last().chain

        assertThat(chain.calls.single().network.meanMs).isEqualTo(3.0)
    }

    @Test
    fun `checks faults and execution settings`() {
        val broken =
            experiment
                .replace("\"target\": \"dependency\"", "\"target\": \"client\"")
                .replace("\"seed\": 20261025", "\"seed\": -1")
                .replace("\"measurement\": \"1s\"", "\"measurement\": \"0ms\"")
                .replace("\"replications\": 2", "\"replications\": 0")
        assertThat(codes(compile(experimentText = broken))).contains("FAULT_TARGET", "SEED_RANGE", "EXECUTION_RANGE")

        val second = """{"target": "dependency", "from": "600ms", "to": "900ms", "processingMultiplier": 2.0}"""
        val overlapping = experiment.replace("\"failureRate\": \"5%\"}]", "\"failureRate\": \"5%\"}, $second]")
        assertThat(codes(compile(experimentText = overlapping))).containsExactly("FAULT_OVERLAP")

        val empty = experiment.replace(", \"processingMultiplier\": 6.0, \"failureRate\": \"5%\"", "")
        assertThat(codes(compile(experimentText = empty))).containsExactly("FAULT_EMPTY")
    }

    @Test
    fun `enforces distribution rules`() {
        val lognormalWithoutStdDev = model.replace("\"kind\": \"exponential\"", "\"kind\": \"lognormal\"")
        assertThat(compile(modelText = lognormalWithoutStdDev).diagnostics.single().code).isEqualTo("PARAM_MISSING")

        val zeroExponential = model.replace("\"mean\": \"8ms\"", "\"mean\": \"0ms\"")
        assertThat(compile(modelText = zeroExponential).diagnostics.single().code).isEqualTo("PARAM_RANGE")

        val fixedWithStdDev = model.replace("\"mean\": \"1ms\"", "\"mean\": \"1ms\", \"stdDev\": \"1ms\"")
        assertThat(compile(modelText = fixedWithStdDev).diagnostics.single().code).isEqualTo("DISTRIBUTION_RULE")
    }

    @Test
    fun `checks variant ids`() {
        val duplicate = experiment.replace("\"id\": \"no-retries\"", "\"id\": \"baseline\"")
        assertThat(codes(compile(experimentText = duplicate))).contains("VARIANT_DUPLICATE")

        val none = experiment.replace(Regex("\"variants\": \\[.*]}"), "\"variants\": []}")
        assertThat(codes(compile(experimentText = none))).contains("VARIANT_EMPTY")
    }
}
```

- [ ] **Step 2: Тест падает**

Run: `./gradlew :core:test --tests 'resiliencelab.core.compiler.ModelCompilerTest'`
Expected: FAIL — `Unresolved reference: ModelCompiler`.

- [ ] **Step 3: Реализация**

```kotlin
package resiliencelab.core.compiler

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import resiliencelab.core.catalog.Catalog
import resiliencelab.core.catalog.Dimension
import resiliencelab.core.catalog.ParamDescriptor
import resiliencelab.core.catalog.ParamKind
import resiliencelab.core.catalog.Quantities
import resiliencelab.core.catalog.Stage1Catalog
import resiliencelab.core.catalog.TypeCategory
import resiliencelab.core.document.ConnectionInstance
import resiliencelab.core.document.ExperimentFile
import resiliencelab.core.document.ModelFile
import resiliencelab.core.document.Variant
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.ChainIr
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.FaultSpan
import resiliencelab.core.ir.Origin
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode
import kotlin.math.ceil

/** One compiled variant. */
data class CompiledVariant(
    val id: String,
    val label: String,
    val chain: ChainIr,
)

/** All variants of an experiment with shared run settings. */
data class CompiledExperiment(
    val variants: List<CompiledVariant>,
    val run: RunSettings,
)

/** Compiler output: an experiment when there are no errors, and all diagnostics. */
data class CompileResult(
    val experiment: CompiledExperiment?,
    val diagnostics: List<Diagnostic>,
)

/**
 * Compiles a model and an experiment into one chain IR per variant (ADR 0002; stage 1 design §3–4):
 * variant overrides are applied by path, parameters are read against the catalog and the stage 1 topology —
 * one client, one request to the entry service and a linear chain of calls — is checked.
 */
class ModelCompiler(
    private val catalog: Catalog = Stage1Catalog.catalog,
) {
    fun compile(
        model: ModelFile,
        modelDocument: String,
        experiment: ExperimentFile,
        experimentDocument: String,
    ): CompileResult {
        val sink = Diagnostics()
        val structureOk = checkStructure(model, modelDocument, sink)
        val run = runSettings(experiment, experimentDocument, sink)
        val faults = faults(experiment, model, experimentDocument, sink)
        checkVariants(experiment, experimentDocument, sink)
        val variants =
            if (!structureOk) {
                emptyList()
            } else {
                experiment.variants.mapIndexedNotNull { index, variant ->
                    val patched = applyOverrides(model, variant, index, experimentDocument, sink) ?: return@mapIndexedNotNull null
                    val parts = buildChain(patched.model, modelDocument, patched.origins, sink) ?: return@mapIndexedNotNull null
                    run?.let {
                        CompiledVariant(
                            id = variant.id,
                            label = variant.label ?: variant.id,
                            chain = ChainIr(parts.client, parts.entry, parts.services, parts.calls, faults, it),
                        )
                    }
                }
            }
        val diagnostics = sink.items.distinct()
        val failed = diagnostics.any { it.severity == Severity.ERROR } || run == null
        return CompileResult(if (failed) null else CompiledExperiment(variants, run!!), diagnostics)
    }

    /** A variant's model and, per element, where its overridden values come from. */
    private class Patched(
        val model: ModelFile,
        val origins: Map<String, OverrideOrigins>,
    )

    private class ChainParts(
        val client: ClientNode,
        val entry: String,
        val services: List<ServiceNode>,
        val calls: List<CallEdge>,
    )

    private fun checkStructure(
        model: ModelFile,
        document: String,
        sink: Diagnostics,
    ): Boolean {
        val before = sink.errorCount()
        model.blocks.forEach { (id, block) ->
            val pointer = JsonPointer.of("blocks", id)
            if (!ID.matches(id)) sink.error("ID_INVALID", "Block id '$id' must match ${ID.pattern}", document, pointer, id)
            val type = catalog.type(block.type)
            if (type == null || type.category != TypeCategory.BLOCK) {
                sink.error("TYPE_UNKNOWN", "Unknown block type '${block.type}'", document, JsonPointer.child(pointer, "type"), id)
            }
        }
        val used = model.blocks.keys.toMutableSet()
        model.connections.forEachIndexed { index, connection ->
            val pointer = JsonPointer.of("connections", index)
            if (!ID.matches(connection.id)) {
                val message = "Connection id '${connection.id}' must match ${ID.pattern}"
                sink.error("ID_INVALID", message, document, "$pointer/id", connection.id)
            }
            if (!used.add(connection.id)) {
                sink.error("ID_DUPLICATE", "Id '${connection.id}' is already used", document, "$pointer/id", connection.id)
            }
            val type = catalog.type(connection.type)
            if (type == null || type.category != TypeCategory.CONNECTION) {
                sink.error("TYPE_UNKNOWN", "Unknown connection type '${connection.type}'", document, "$pointer/type", connection.id)
                return@forEachIndexed
            }
            val from = model.blocks[connection.from]
            val to = model.blocks[connection.to]
            if (from == null) {
                sink.error("CONNECTION_ENDPOINT", "Unknown source block '${connection.from}'", document, "$pointer/from", connection.id)
            }
            if (to == null) {
                sink.error("CONNECTION_ENDPOINT", "Unknown target block '${connection.to}'", document, "$pointer/to", connection.id)
            }
            val rule = type.connects
            if (from != null && to != null && rule != null && (from.type != rule.fromType || to.type != rule.toType)) {
                sink.error(
                    "CONNECTION_TYPE",
                    "Connection type '${type.id}' must connect ${rule.fromType} to ${rule.toType}",
                    document,
                    "$pointer/type",
                    connection.id,
                )
            }
        }
        return sink.errorCount() == before
    }

    private fun applyOverrides(
        model: ModelFile,
        variant: Variant,
        index: Int,
        document: String,
        sink: Diagnostics,
    ): Patched? {
        var blocks = model.blocks
        val connections = model.connections.toMutableList()
        val pointers = mutableMapOf<String, MutableMap<String, String>>()
        var ok = true
        variant.overrides.toSortedMap().forEach { (path, value) ->
            val segments = path.split('.')
            val target = segments.first()
            val paramPath = segments.drop(1)
            val block = blocks[target]
            val connectionIndex = connections.indexOfFirst { it.id == target }
            val typeId = block?.type ?: connections.getOrNull(connectionIndex)?.type
            val descriptors = typeId?.let { catalog.type(it)?.params }
            if (descriptors == null || paramPath.isEmpty() || !resolves(descriptors, paramPath)) {
                sink.error(
                    "OVERRIDE_PATH",
                    "Override '$path' does not name a parameter of a block or connection",
                    document,
                    JsonPointer.of("variants", index, "overrides", path),
                    target,
                )
                ok = false
                return@forEach
            }
            if (block != null) {
                blocks = blocks + (target to block.copy(params = setIn(block.params, descriptors, paramPath, value)))
            } else {
                val connection = connections[connectionIndex]
                connections[connectionIndex] = connection.copy(params = setIn(connection.params, descriptors, paramPath, value))
            }
            pointers.getOrPut(target) { mutableMapOf() }[paramPath.joinToString(".")] =
                JsonPointer.of("variants", index, "overrides", path)
        }
        if (!ok) return null
        return Patched(model.copy(blocks = blocks, connections = connections), pointers.mapValues { OverrideOrigins(document, it.value) })
    }

    private fun resolves(
        descriptors: List<ParamDescriptor>,
        path: List<String>,
    ): Boolean {
        val head = descriptors.firstOrNull { it.name == path.first() } ?: return false
        return path.size == 1 || (head.kind == ParamKind.OBJECT && resolves(head.fields, path.drop(1)))
    }

    private fun setIn(
        params: JsonObject,
        descriptors: List<ParamDescriptor>,
        path: List<String>,
        value: JsonElement,
    ): JsonObject {
        val name = path.first()
        if (path.size == 1) return JsonObject(params + (name to value))
        val descriptor = descriptors.first { it.name == name }
        val current = params[name] as? JsonObject ?: descriptor.default as? JsonObject ?: JsonObject(emptyMap())
        return JsonObject(params + (name to setIn(current, descriptor.fields, path.drop(1), value)))
    }

    private fun buildChain(
        model: ModelFile,
        document: String,
        origins: Map<String, OverrideOrigins>,
        sink: Diagnostics,
    ): ChainParts? {
        val before = sink.errorCount()
        val clients = model.blocks.filterValues { it.type == "client" }.toSortedMap()
        val services = model.blocks.filterValues { it.type == "service" }.toSortedMap()
        val clientNodes = clients.map { (id, block) -> readClient(id, block.params, document, origins[id], sink) }
        val serviceNodes = services.map { (id, block) -> readService(id, block.params, document, origins[id], sink) }
        val indexed = model.connections.withIndex()
        val requests = indexed.filter { it.value.type == "request" }
        requests.forEach { (index, connection) ->
            // A request has no parameters; reading them against the catalog reports any that are written.
            reader("request", connection.params, document, JsonPointer.of("connections", index, "params"), connection.id, sink)
        }
        val calls = indexed.filter { it.value.type == "call" }.sortedBy { it.value.id }
        val callEdges = calls.map { (index, connection) -> readCall(index, connection, document, origins[connection.id], sink) }
        if (clients.size != 1) {
            sink.error("TOPOLOGY_CLIENT", "The model must contain exactly one client block; found ${clients.size}", document, "/blocks")
        }
        if (requests.size != 1 || requests.single().value.from !in clients) {
            sink.error("TOPOLOGY_CHAIN", "Exactly one request connection must start at the client", document, "/connections")
        }
        val entry = requests.singleOrNull()?.value?.to
        if (entry != null) checkChain(entry, services.keys, calls.map { it.value }, document, sink)
        if (sink.errorCount() > before) return null
        return ChainParts(clientNodes.single()!!, entry!!, serviceNodes.map { it!! }, callEdges.map { it!! })
    }

    private fun checkChain(
        entry: String,
        services: Set<String>,
        calls: List<ConnectionInstance>,
        document: String,
        sink: Diagnostics,
    ) {
        val outgoing = calls.groupBy { it.from }
        val incoming = calls.groupBy { it.to }
        outgoing.filterValues { it.size > 1 }.keys.sorted().forEach {
            sink.error("TOPOLOGY_CHAIN", "Service '$it' has more than one outgoing call", document, JsonPointer.of("blocks", it), it)
        }
        incoming.filterValues { it.size > 1 }.keys.sorted().forEach {
            sink.error("TOPOLOGY_CHAIN", "Service '$it' has more than one incoming call", document, JsonPointer.of("blocks", it), it)
        }
        if (entry in incoming) {
            sink.error("TOPOLOGY_CHAIN", "Entry service '$entry' must not receive calls", document, JsonPointer.of("blocks", entry), entry)
        }
        val visited = linkedSetOf<String>()
        var current: String? = entry
        while (current != null && visited.add(current)) {
            current = outgoing[current]?.singleOrNull()?.to
        }
        if (current != null) {
            sink.error("TOPOLOGY_CHAIN", "Calls form a cycle through '$current'", document, JsonPointer.of("blocks", current), current)
        }
        (services - visited).sorted().forEach {
            sink.error("TOPOLOGY_CHAIN", "Service '$it' is not reachable from the client", document, JsonPointer.of("blocks", it), it)
        }
    }

    private fun readClient(
        id: String,
        params: JsonObject,
        document: String,
        overrides: OverrideOrigins?,
        sink: Diagnostics,
    ): ClientNode? {
        val reader = reader("client", params, document, JsonPointer.of("blocks", id, "params"), id, sink, overrides)
        val rate = reader.quantity("rate")
        val deadline = reader.quantity("deadline")
        if (rate != null && !(1.0 / rate).isFinite()) {
            return reader.fail("PARAM_RANGE", "rate", "Arrival rate is too small: the mean interval between requests is not finite")
        }
        if (rate == null || deadline == null) return null
        return ClientNode(id, rate, deadline, Origin(document, JsonPointer.of("blocks", id)))
    }

    private fun readService(
        id: String,
        params: JsonObject,
        document: String,
        overrides: OverrideOrigins?,
        sink: Diagnostics,
    ): ServiceNode? {
        val reader = reader("service", params, document, JsonPointer.of("blocks", id, "params"), id, sink, overrides)
        val handlers = reader.int("handlers")
        val queue = reader.int("queue")
        val processing = reader.obj("processing")?.let(::distribution)
        val failure = reader.quantity("failureRate")
        return if (handlers == null || queue == null || processing == null || failure == null) {
            null
        } else {
            ServiceNode(id, handlers, queue, processing, failure, Origin(document, JsonPointer.of("blocks", id)))
        }
    }

    private fun readCall(
        index: Int,
        connection: ConnectionInstance,
        document: String,
        overrides: OverrideOrigins?,
        sink: Diagnostics,
    ): CallEdge? {
        val pointer = JsonPointer.of("connections", index, "params")
        val reader = reader("call", connection.params, document, pointer, connection.id, sink, overrides)
        val network = reader.obj("network")?.let(::distribution)
        val timeout = reader.quantity("timeout")
        val attempts = reader.int("attempts")
        val backoff = reader.obj("backoff")?.let(::backoff)
        return if (network == null || timeout == null || attempts == null || backoff == null) {
            null
        } else {
            val origin = Origin(document, JsonPointer.of("connections", index))
            CallEdge(connection.id, connection.from, connection.to, network, timeout, attempts, backoff, origin)
        }
    }

    private fun distribution(reader: ParamReader): Distribution? {
        val kind = reader.choice("kind")
        val mean = reader.quantity("mean")
        val stdDev = reader.quantity("stdDev")
        if (kind == null || mean == null) return null
        if (kind != "lognormal" && reader.has("stdDev")) {
            return reader.fail("DISTRIBUTION_RULE", "stdDev", "stdDev applies only to lognormal")
        }
        if (kind != "fixed" && mean <= 0.0) {
            return reader.fail("PARAM_RANGE", "mean", "mean must be greater than zero for $kind")
        }
        return when (kind) {
            "fixed" -> Distribution(DistributionShape.FIXED, mean)
            "exponential" -> Distribution(DistributionShape.EXPONENTIAL, mean)
            else ->
                if (stdDev == null) {
                    if (reader.has("stdDev")) null else reader.fail("PARAM_MISSING", "stdDev", "lognormal requires stdDev")
                } else {
                    Distribution(DistributionShape.LOGNORMAL, mean, stdDev)
                }
        }
    }

    private fun backoff(reader: ParamReader): Backoff? {
        val kind = reader.choice("kind")
        val base = reader.quantity("base")
        val max = reader.quantity("max")
        val multiplier = reader.number("multiplier")
        if (kind == null || base == null || max == null || multiplier == null) return null
        val backoffKind =
            when (kind) {
                "none" -> BackoffKind.NONE
                "fixed" -> BackoffKind.FIXED
                else -> BackoffKind.EXPONENTIAL_FULL_JITTER
            }
        return Backoff(backoffKind, base, max, multiplier)
    }

    private fun reader(
        type: String,
        params: JsonObject,
        document: String,
        pointer: String,
        path: String,
        sink: Diagnostics,
        overrides: OverrideOrigins? = null,
    ) = ParamReader(params, catalog.type(type)!!.params, document, pointer, path, sink.items, overrides ?: OverrideOrigins.NONE)

    private fun runSettings(
        experiment: ExperimentFile,
        document: String,
        sink: Diagnostics,
    ): RunSettings? {
        val execution = experiment.execution
        val before = sink.errorCount()
        if (execution.replications < 1) {
            sink.error("EXECUTION_RANGE", "replications must be at least 1", document, "/execution/replications")
        }
        val warmup = duration(execution.warmup, "/execution/warmup", document, sink, allowZero = true)
        val measurement = duration(execution.measurement, "/execution/measurement", document, sink, allowZero = false)
        val maxRealTime = duration(execution.maxRealTime, "/execution/maxRealTime", document, sink, allowZero = false)
        if (execution.seed !in 0L..MAX_SEED) {
            sink.error("SEED_RANGE", "seed must be an integer from 0 to $MAX_SEED", document, "/execution/seed")
        }
        if (warmup != null && measurement != null && !(warmup + measurement).isFinite()) {
            sink.error("EXECUTION_RANGE", "warmup plus measurement must be finite", document, "/execution/measurement")
        }
        if (sink.errorCount() > before || warmup == null || measurement == null || maxRealTime == null) return null
        return RunSettings(execution.replications, warmup, measurement, execution.seed, ceil(maxRealTime / 1_000.0).toLong())
    }

    private fun faults(
        experiment: ExperimentFile,
        model: ModelFile,
        document: String,
        sink: Diagnostics,
    ): List<FaultSpan> {
        val spans =
            experiment.faults.mapIndexedNotNull { index, fault ->
                val pointer = JsonPointer.of("faults", index)
                val before = sink.errorCount()
                if (model.blocks[fault.target]?.type != "service") {
                    sink.error("FAULT_TARGET", "Fault target '${fault.target}' is not a service", document, "$pointer/target", fault.target)
                }
                val from = duration(fault.from, "$pointer/from", document, sink, allowZero = true)
                val to = duration(fault.to, "$pointer/to", document, sink, allowZero = false)
                if (from != null && to != null && to <= from) {
                    sink.error("FAULT_INTERVAL", "Fault must end after it starts", document, "$pointer/to", fault.target)
                }
                val multiplier = fault.processingMultiplier
                if (multiplier != null && !(multiplier > 0.0 && multiplier.isFinite())) {
                    sink.error(
                        "PARAM_RANGE",
                        "processingMultiplier must be greater than zero",
                        document,
                        "$pointer/processingMultiplier",
                        fault.target,
                    )
                }
                val failure =
                    fault.failureRate?.let { text ->
                        Quantities.parse(text, Dimension.PROBABILITY)?.takeIf { it <= 1.0 }.also {
                            if (it == null) {
                                sink.error(
                                    "QUANTITY_INVALID",
                                    "failureRate must be a percentage from 0% to 100%",
                                    document,
                                    "$pointer/failureRate",
                                    fault.target,
                                )
                            }
                        }
                    }
                if (multiplier == null && fault.failureRate == null) {
                    sink.error("FAULT_EMPTY", "Fault must set processingMultiplier or failureRate", document, pointer, fault.target)
                }
                if (sink.errorCount() > before) {
                    null
                } else {
                    FaultSpan(fault.target, from!!, to!!, multiplier, failure, Origin(document, pointer))
                }
            }
        spans.groupBy { it.target }.forEach { (target, list) ->
            val overlap = list.sortedBy { it.fromMs }.zipWithNext().any { (first, second) -> second.fromMs < first.toMs }
            if (overlap) sink.error("FAULT_OVERLAP", "Faults on '$target' overlap in time", document, "/faults", target)
        }
        return spans.sortedWith(compareBy({ it.target }, { it.fromMs }))
    }

    private fun checkVariants(
        experiment: ExperimentFile,
        document: String,
        sink: Diagnostics,
    ) {
        if (experiment.variants.isEmpty()) {
            sink.error("VARIANT_EMPTY", "The experiment must define at least one variant", document, "/variants")
        }
        val seen = mutableSetOf<String>()
        experiment.variants.forEachIndexed { index, variant ->
            val pointer = JsonPointer.of("variants", index, "id")
            if (!ID.matches(variant.id)) sink.error("ID_INVALID", "Variant id '${variant.id}' must match ${ID.pattern}", document, pointer)
            if (!seen.add(variant.id)) sink.error("VARIANT_DUPLICATE", "Variant id '${variant.id}' is repeated", document, pointer)
        }
    }

    private fun duration(
        text: String,
        pointer: String,
        document: String,
        sink: Diagnostics,
        allowZero: Boolean,
    ): Double? {
        val value = Quantities.parse(text, Dimension.DURATION)
        if (value == null) {
            sink.error("QUANTITY_INVALID", "'$text' is not a duration such as 250ms or 2s", document, pointer)
            return null
        }
        if (!allowZero && value <= 0.0) {
            sink.error("EXECUTION_RANGE", "Duration must be greater than zero", document, pointer)
            return null
        }
        return value
    }

    companion object {
        /** Largest seed that a browser reads without loss (ADR 0005, item 10). */
        const val MAX_SEED: Long = 9_007_199_254_740_991L

        /** Block, connection and variant ids: path segments without `/` or `.`. */
        val ID: Regex = Regex("^[A-Za-z0-9][A-Za-z0-9_-]*$")
    }
}
```

- [ ] **Step 4: Тест проходит**

Run: `./gradlew :core:test --tests 'resiliencelab.core.compiler.ModelCompilerTest'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
./gradlew :core:ktlintFormat
git add core/src/main/kotlin/resiliencelab/core/compiler/ModelCompiler.kt core/src/test/kotlin/resiliencelab/core/compiler/ModelCompilerTest.kt
git commit -m "feat(core): compile model documents into chain IR"
```

---

### Task 8: Потоки по путям блоков

**Files:**
- Create: `core/src/main/kotlin/resiliencelab/core/simulation/PathStreams.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/simulation/PathStreamsTest.kt`

Код переносится из прототипа исследования S4 (`research/ksl-streams/.../PathStreams.kt`) с теми же правилами кодирования ключа; эталонный адрес ниже получен независимым оракулом `research/ksl-streams/oracle.py`.

- [ ] **Step 1: Написать падающий тест**

```kotlin
package resiliencelab.core.simulation

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import kotlin.test.Test

class PathStreamsTest {
    private val key = StreamKey(seed = 42, replication = 0, path = listOf("system", "api"), role = "processing")

    @Test
    fun `matches the independent oracle address`() {
        assertThat(PathStreams.addressOf(key)).isEqualTo(5_391_452_259_724_126_168L)
    }

    @Test
    fun `rejects invalid keys`() {
        assertThatThrownBy { PathStreams.addressOf(key.copy(seed = -1)) }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { PathStreams.addressOf(key.copy(seed = 9_007_199_254_740_992)) }
            .isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { PathStreams.addressOf(key.copy(replication = -1)) }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { PathStreams.addressOf(key.copy(path = listOf("a", ""))) }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { PathStreams.addressOf(key.copy(role = "")) }.isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun `same key gives the same sequence in separately opened sources and other roles differ`() {
        val plan = StreamPlan(listOf(key, key.copy(role = "outcome")))
        val first = PathStreamSource(plan, seed = 42, replication = 0).stream("system/api", StreamRole.PROCESSING)
        val second = PathStreamSource(plan, seed = 42, replication = 0).stream("system/api", StreamRole.PROCESSING)
        val other = PathStreamSource(plan, seed = 42, replication = 0).stream("system/api", StreamRole.OUTCOME)

        val firstValues = DoubleArray(4) { first.randU01() }
        assertThat(DoubleArray(4) { second.randU01() }).containsExactly(*firstValues)
        assertThat(DoubleArray(4) { other.randU01() }).isNotEqualTo(firstValues)
    }

    @Test
    fun `extra keys in a plan do not change existing streams`() {
        val small = StreamPlan(listOf(key))
        val large = StreamPlan(listOf(key.copy(path = listOf("other")), key))

        val fromSmall = PathStreamSource(small, 42, 0).stream("system/api", StreamRole.PROCESSING)
        val fromLarge = PathStreamSource(large, 42, 0).stream("system/api", StreamRole.PROCESSING)

        assertThat(DoubleArray(4) { fromLarge.randU01() }).containsExactly(*DoubleArray(4) { fromSmall.randU01() })
    }

    @Test
    fun `a source returns the same stream object for repeated requests`() {
        val source = PathStreamSource(StreamPlan(listOf(key)), 42, 0)
        assertThat(source.stream("system/api", StreamRole.PROCESSING)).isSameAs(source.stream("system/api", StreamRole.PROCESSING))
    }

    @Test
    fun `different keys sharing an address stop the plan but identical keys are allowed`() {
        assertThatThrownBy { StreamPlan(listOf(key, key.copy(role = "outcome"))) { 7L } }
            .isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageContaining("collision")
        assertThat(StreamPlan(listOf(key, key)).size).isEqualTo(1)
    }

    @Test
    fun `keys outside the plan are rejected`() {
        val source = PathStreamSource(StreamPlan(listOf(key)), 42, 0)
        assertThatThrownBy { source.stream("system/db", StreamRole.PROCESSING) }
            .isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageContaining("absent")
    }
}
```

- [ ] **Step 2: Тест падает**

Run: `./gradlew :core:test --tests 'resiliencelab.core.simulation.PathStreamsTest'`
Expected: FAIL — `Unresolved reference: StreamKey`.

- [ ] **Step 3: Реализация**

```kotlin
package resiliencelab.core.simulation

import ksl.utilities.random.rng.RNStreamFactory
import ksl.utilities.random.rng.RNStreamIfc
import resiliencelab.core.ir.ChainIr
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest

/** Stable roles of random sources inside a block (ADR 0006; stage 1 design §4.2). */
enum class StreamRole(
    val id: String,
) {
    ARRIVALS("arrivals"),
    PROCESSING("processing"),
    OUTCOME("outcome"),
    NETWORK("network"),
    JITTER("jitter"),
}

/** Resolves the stream of one random source of one model. */
fun interface StreamSource {
    fun stream(
        path: String,
        role: StreamRole,
    ): RNStreamIfc
}

/** Full identity of a random source; [path] lists the segments of the block instance path. */
data class StreamKey(
    val seed: Long,
    val replication: Long,
    val path: List<String>,
    val role: String,
)

/** Path-based substream addressing (ADR 0006, research S4). */
object PathStreams {
    const val ASSIGNMENT_VERSION = "resilience-lab/ksl-path-substream/v1"
    private const val MAX_SEED = 9_007_199_254_740_991L

    /** First 63 non-sign bits of SHA-256 over the length-prefixed, big-endian encoding of [key]. */
    fun addressOf(key: StreamKey): Long {
        require(key.seed in 0..MAX_SEED) { "Seed outside JSON-safe nonnegative integer range" }
        require(key.replication >= 0) { "Replication ordinal must be nonnegative" }
        require(key.path.isNotEmpty() && key.path.all { it.isNotEmpty() }) { "Empty block path or segment" }
        require(key.role.isNotEmpty()) { "Empty source role" }
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { output ->
            fun field(value: String) {
                val buffer =
                    try {
                        UTF_8.newEncoder().encode(CharBuffer.wrap(value))
                    } catch (error: CharacterCodingException) {
                        throw IllegalArgumentException("Malformed Unicode in source identity", error)
                    }
                val encoded = ByteArray(buffer.remaining()).also { buffer.get(it) }
                output.writeInt(encoded.size)
                output.write(encoded)
            }
            field(ASSIGNMENT_VERSION)
            output.writeLong(key.seed)
            output.writeLong(key.replication)
            output.writeInt(key.path.size)
            key.path.forEach(::field)
            field(key.role)
        }
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes.toByteArray())
        return ByteBuffer.wrap(digest).long and Long.MAX_VALUE
    }

    /**
     * A fresh stream from the fixed MRG32k3a origin advanced to [address] substreams. The caller owns it: never attach it
     * through `RandomVariable`, reset or advance it.
     */
    fun streamAt(address: Long): RNStreamIfc = RNStreamFactory().nextStream().apply { advanceSubStreams(address) }

    /** Random sources the engine reads for [chain]. */
    fun sources(chain: ChainIr): List<Pair<String, StreamRole>> =
        buildList {
            add(chain.client.path to StreamRole.ARRIVALS)
            chain.services.forEach {
                add(it.path to StreamRole.PROCESSING)
                add(it.path to StreamRole.OUTCOME)
            }
            chain.calls.forEach {
                add(it.path to StreamRole.NETWORK)
                add(it.path to StreamRole.JITTER)
            }
        }

    /** Keys of all sources of [chain] for one replication. */
    fun keys(
        chain: ChainIr,
        replication: Int,
    ): List<StreamKey> =
        sources(chain).map { (path, role) -> StreamKey(chain.run.seed, replication.toLong(), path.split('/'), role.id) }
}

/**
 * Preflighted addresses of every key of an experiment (all variants and replications). Identical keys share an
 * address on purpose (common random numbers); different keys with one address stop the plan.
 */
class StreamPlan internal constructor(
    keys: Collection<StreamKey>,
    addressOf: (StreamKey) -> Long,
) {
    constructor(keys: Collection<StreamKey>) : this(keys, PathStreams::addressOf)

    private val addresses: Map<StreamKey, Long>

    init {
        val owners = HashMap<Long, StreamKey>()
        addresses =
            keys.distinct().associateWith { key ->
                addressOf(key).also { address ->
                    val previous = owners.putIfAbsent(address, key)
                    require(previous == null) { "Substream address collision at $address: $previous and $key" }
                }
            }
    }

    val size: Int get() = addresses.size

    fun address(key: StreamKey): Long =
        addresses[key] ?: throw IllegalArgumentException("Source $key is absent from the experiment stream plan")
}

/** Streams of one model of one replication; each source opens once. */
class PathStreamSource(
    private val plan: StreamPlan,
    private val seed: Long,
    private val replication: Long,
) : StreamSource {
    private val opened = HashMap<StreamKey, RNStreamIfc>()

    override fun stream(
        path: String,
        role: StreamRole,
    ): RNStreamIfc {
        val key = StreamKey(seed, replication, path.split('/'), role.id)
        return opened.getOrPut(key) { PathStreams.streamAt(plan.address(key)) }
    }
}
```

- [ ] **Step 4: Тест проходит**

Run: `./gradlew :core:test --tests 'resiliencelab.core.simulation.PathStreamsTest'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
./gradlew :core:ktlintFormat
git add core/src/main/kotlin/resiliencelab/core/simulation/PathStreams.kt core/src/test/kotlin/resiliencelab/core/simulation/PathStreamsTest.kt
git commit -m "feat(core): assign random streams by block path"
```

---

### Task 9: Движок принимает IR и источник потоков

Старые тесты пакета `simulation` остаются без изменений и должны проходить: старый конструктор `ReliabilityModel` переводит сценарий MVP в IR и сохраняет прежнюю нумерацию потоков. Выборки через `KSLRandom` с явным потоком дают те же числа, что `ExponentialRV`, `LognormalRV` и `UniformRV` с тем же потоком: их `generate()` вызывает те же функции.

Правила ADR 0006 для нового пути:

- потоки `PathStreamSource` создаются вне `model.streamProvider`, поэтому KSL не переводит их на следующий подпоток и не сбрасывает; `RandomVariable` в новом пути не используется;
- одновременные события упорядочены по каноническому пути: компилятор сортирует сервисы, вызовы и отказы, а движок планирует события в порядке IR.

**Files:**
- Create: `core/src/main/kotlin/resiliencelab/core/simulation/LegacyScenarioAdapter.kt`
- Modify: `core/src/main/kotlin/resiliencelab/core/simulation/DurationSampler.kt`
- Modify: `core/src/main/kotlin/resiliencelab/core/simulation/RetryPolicyEvaluator.kt`
- Modify: `core/src/main/kotlin/resiliencelab/core/simulation/ArrivalGenerator.kt`
- Modify: `core/src/main/kotlin/resiliencelab/core/simulation/ServiceRuntime.kt`
- Modify: `core/src/main/kotlin/resiliencelab/core/simulation/MetricsCollector.kt`
- Modify: `core/src/main/kotlin/resiliencelab/core/simulation/ReliabilityModel.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/simulation/ChainModelTest.kt`

- [ ] **Step 1: Написать падающий тест нового пути**

```kotlin
package resiliencelab.core.simulation

import ksl.modeling.entity.ProcessModel
import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.ChainIr
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.FaultSpan
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode
import kotlin.test.Test

class ChainModelTest {
    private fun chain(faults: List<FaultSpan> = emptyList()) =
        ChainIr(
            client = ClientNode("client", arrivalRatePerMs = 0.05, deadlineMs = 200.0),
            entry = "front",
            services =
                listOf(
                    ServiceNode("back", 1, 4, Distribution(DistributionShape.EXPONENTIAL, 5.0), 0.01),
                    ServiceNode("front", 2, 4, Distribution(DistributionShape.FIXED, 1.0), 0.0),
                ),
            calls =
                listOf(
                    CallEdge(
                        path = "front-to-back",
                        from = "front",
                        to = "back",
                        network = Distribution(DistributionShape.FIXED, 0.5),
                        timeoutMs = 20.0,
                        attempts = 2,
                        backoff = Backoff(BackoffKind.EXPONENTIAL_FULL_JITTER, 1.0, 5.0, 2.0),
                    ),
                ),
            faults = faults,
            run = RunSettings(replications = 2, warmupMs = 0.0, measurementMs = 500.0, seed = 7, maxRealTimeSeconds = 30),
        )

    private fun run(
        chain: ChainIr,
        replication: Int,
    ): ReplicationResult {
        val plan = StreamPlan(PathStreams.keys(chain, replication))
        val model = Model("ChainModelTest", autoCSVReports = false)
        return ReliabilityModel(model, chain, PathStreamSource(plan, chain.run.seed, replication.toLong())).runReplication()
    }

    @Test
    fun `runs a replication to full drain and repeats it exactly`() {
        val chain = chain()

        val first = run(chain, replication = 0)

        assertThat(first.originalArrivals).isGreaterThan(0)
        assertThat(first.successes + first.failures).isEqualTo(first.originalArrivals)
        assertThat(first.services.keys).containsExactly("back", "front")
        assertThat(run(chain, replication = 0)).isEqualTo(first)
        assertThat(run(chain, replication = 1).arrivalTimesMs).isNotEqualTo(first.arrivalTimesMs)
    }

    @Test
    fun `a fault multiplies processing only while it is active`() {
        val chain =
            chain(faults = listOf(FaultSpan("front", fromMs = 0.0, toMs = 50.0, processingMultiplier = 3.0, failureProbability = null)))
                .copy(calls = emptyList(), services = listOf(ServiceNode("front", 2, 4, Distribution(DistributionShape.FIXED, 10.0), 0.0)))
        val plan = StreamPlan(PathStreams.keys(chain, 0))
        val model = Model("FaultWindow", autoCSVReports = false)
        val reliabilityModel = ReliabilityModel(model, chain, PathStreamSource(plan, chain.run.seed, 0))
        val driver = Driver(model, reliabilityModel, arrivalsMs = listOf(0.0, 60.0))
        model.numberOfReplications = 1
        model.lengthOfReplication = 200.0

        model.simulate()

        assertThat(driver.created.map { it.work.processCompletionTime }).containsExactly(30.0, 70.0)
    }

    private class Driver(
        model: Model,
        private val reliabilityModel: ReliabilityModel,
        private val arrivalsMs: List<Double>,
    ) : ProcessModel(model) {
        val created = mutableListOf<ReliabilityModel.ServiceInvocation>()

        override fun initialize() {
            created.clear()
            arrivalsMs.forEach { created += reliabilityModel.invoke(serviceId = "front", timeUntilActivation = it) }
        }
    }
}
```

- [ ] **Step 2: Тест падает**

Run: `./gradlew :core:test --tests 'resiliencelab.core.simulation.ChainModelTest'`
Expected: FAIL — нет конструктора `ReliabilityModel(Model, ChainIr, StreamSource)`.

- [ ] **Step 3: `LegacyScenarioAdapter.kt`**

```kotlin
package resiliencelab.core.simulation

import ksl.simulation.Model
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.ChainIr
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.FaultSpan
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode
import resiliencelab.core.scenario.DistributionKind
import resiliencelab.core.scenario.DurationDistribution
import resiliencelab.core.scenario.Execution
import resiliencelab.core.scenario.RetryKind
import resiliencelab.core.scenario.RetrySpec
import resiliencelab.core.scenario.Scenario

/**
 * Maps MVP scenarios onto the chain IR and the MVP stream numbering, so the legacy API and its tests keep their
 * exact behaviour. Removed together with the `scenario` package once the web client leaves the MVP API.
 */
internal object LegacyScenarioAdapter {
    const val CLIENT_PATH = "workload"

    fun chain(
        scenario: Scenario,
        execution: Execution,
    ): ChainIr =
        ChainIr(
            client = ClientNode(CLIENT_PATH, scenario.workload.arrivalRate, scenario.workload.requestDeadlineMs),
            entry = scenario.entry,
            services =
                scenario.services.map {
                    ServiceNode(it.id, it.handlers, it.queueCapacity, distribution(it.processing), it.failureRate)
                },
            calls =
                scenario.links.map {
                    CallEdge(it.id, it.from, it.to, distribution(it.network), it.timeoutMs, it.maxAttempts, backoff(it.retry))
                },
            faults =
                listOfNotNull(
                    scenario.degradation?.let {
                        FaultSpan(it.serviceId, it.startMs, it.endMs, it.processingMultiplier, it.failureRate)
                    },
                ),
            run =
                RunSettings(
                    replications = execution.replications,
                    warmupMs = execution.warmupMs,
                    measurementMs = execution.measurementMs,
                    seed = execution.seed,
                    maxRealTimeSeconds = execution.maxRealTimeSeconds,
                ),
        )

    fun distribution(spec: DurationDistribution): Distribution =
        Distribution(
            shape =
                when (spec.kind) {
                    DistributionKind.FIXED -> DistributionShape.FIXED
                    DistributionKind.EXPONENTIAL -> DistributionShape.EXPONENTIAL
                    DistributionKind.LOGNORMAL -> DistributionShape.LOGNORMAL
                },
            meanMs = spec.meanMs,
            stdDevMs = spec.stdDevMs,
        )

    fun backoff(retry: RetrySpec): Backoff =
        Backoff(
            kind =
                when (retry.kind) {
                    RetryKind.NONE -> BackoffKind.NONE
                    RetryKind.FIXED -> BackoffKind.FIXED
                    RetryKind.EXPONENTIAL_FULL_JITTER -> BackoffKind.EXPONENTIAL_FULL_JITTER
                },
            baseMs = retry.baseBackoffMs,
            maxMs = retry.maxBackoffMs,
            multiplier = retry.base,
        )

    /** MVP numbering: services by index, then links, then arrivals, on the model provider seeded from [seed]. */
    fun streams(
        model: Model,
        scenario: Scenario,
        seed: Long,
    ): StreamSource {
        val provider = model.streamProvider.apply { initialSeed(SeedFactory.seedVector(seed)) }
        val services = scenario.services.size
        val links = scenario.links.size
        val numbers = HashMap<Pair<String, StreamRole>, Int>()
        scenario.services.forEachIndexed { index, service ->
            numbers[service.id to StreamRole.PROCESSING] = index * 2 + 1
            numbers[service.id to StreamRole.OUTCOME] = index * 2 + 2
        }
        scenario.links.forEachIndexed { index, link ->
            numbers[link.id to StreamRole.NETWORK] = services * 2 + index + 1
            numbers[link.id to StreamRole.JITTER] = services * 2 + links + index + 1
        }
        numbers[CLIENT_PATH to StreamRole.ARRIVALS] = services * 2 + links * 2 + 1
        return StreamSource { path, role -> provider.rnStream(numbers.getValue(path to role)) }
    }
}
```

- [ ] **Step 4: `DurationSampler.kt` — заменить файл целиком**

```kotlin
package resiliencelab.core.simulation

import ksl.utilities.random.rng.RNStreamIfc
import ksl.utilities.random.rng.RNStreamProvider
import ksl.utilities.random.rvariable.KSLRandom
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.scenario.DurationDistribution

/** Draws processing or one-way network durations in milliseconds from a configured distribution. */
fun interface DurationSampler {
    fun next(): Double
}

/** Draws durations from an explicitly owned stream; fixed durations consume no random numbers (ADR 0006). */
object DurationSamplerFactory {
    fun create(
        distribution: Distribution,
        stream: RNStreamIfc,
    ): DurationSampler =
        when (distribution.shape) {
            DistributionShape.FIXED -> DurationSampler { distribution.meanMs }
            DistributionShape.EXPONENTIAL -> DurationSampler { KSLRandom.rExponential(distribution.meanMs, stream) }
            DistributionShape.LOGNORMAL -> {
                val stdDev = requireNotNull(distribution.stdDevMs) { "Lognormal distribution requires stdDevMs" }
                DurationSampler { KSLRandom.rLogNormal(distribution.meanMs, stdDev * stdDev, stream) }
            }
        }

    /** MVP overload; removed with the `scenario` package. */
    fun create(
        spec: DurationDistribution,
        streamNum: Int,
        provider: RNStreamProvider,
    ): DurationSampler = create(LegacyScenarioAdapter.distribution(spec), provider.rnStream(streamNum))
}
```

- [ ] **Step 5: `RetryPolicyEvaluator.kt` — заменить файл целиком**

```kotlin
package resiliencelab.core.simulation

import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.scenario.RetrySpec
import kotlin.math.pow

/**
 * Computes capped retry delays for one-based failed-attempt numbers.
 * Exponential full jitter samples uniformly between zero and the capped exponential delay.
 */
object RetryPolicyEvaluator {
    fun backoffMs(
        backoff: Backoff,
        failedAttemptNumber: Int,
        jitter: () -> Double,
    ): Double {
        require(failedAttemptNumber >= 1) { "failedAttemptNumber must be at least 1" }
        return when (backoff.kind) {
            BackoffKind.NONE -> 0.0
            BackoffKind.FIXED -> minOf(backoff.baseMs, backoff.maxMs)
            BackoffKind.EXPONENTIAL_FULL_JITTER -> {
                val uncappedMs =
                    if (backoff.baseMs == 0.0) {
                        0.0
                    } else {
                        backoff.baseMs * backoff.multiplier.pow(failedAttemptNumber - 1)
                    }
                jitter() * minOf(backoff.maxMs, uncappedMs)
            }
        }
    }

    /** MVP overload; removed with the `scenario` package. */
    fun backoffMs(
        retry: RetrySpec,
        failedAttemptNumber: Int,
        jitter: () -> Double,
    ): Double = backoffMs(LegacyScenarioAdapter.backoff(retry), failedAttemptNumber, jitter)
}
```

- [ ] **Step 6: `ArrivalGenerator.kt` — заменить файл целиком**

```kotlin
package resiliencelab.core.simulation

import ksl.simulation.ModelElement
import ksl.utilities.random.rng.RNStreamIfc
import ksl.utilities.random.rvariable.KSLRandom

/**
 * Generates the open Poisson stream of original requests through warm-up and the measurement interval.
 * Warm-up requests affect system state but are outside the measured cohort; no arrivals are created at or after
 * the arrival boundary, leaving subsequent simulation time for completion and run-out.
 */
internal class ArrivalGenerator(
    private val reliabilityModel: ReliabilityModel,
    private val entryServiceId: String,
    arrivalRate: Double,
    private val warmupMs: Double,
    measurementMs: Double,
    private val stream: RNStreamIfc,
) : ModelElement(reliabilityModel, "workload:arrival-generator") {
    /** MVP overload; removed with the `scenario` package. */
    constructor(
        reliabilityModel: ReliabilityModel,
        entryServiceId: String,
        arrivalRate: Double,
        warmupMs: Double,
        measurementMs: Double,
        streamNum: Int,
    ) : this(
        reliabilityModel,
        entryServiceId,
        arrivalRate,
        warmupMs,
        measurementMs,
        reliabilityModel.streamProvider.rnStream(streamNum),
    )

    private val meanInterArrivalMs = 1 / arrivalRate
    private val arrivalEndMs = warmupMs + measurementMs
    private val arrivalAction =
        EventActionIfc<Nothing> {
            reliabilityModel.invoke(
                serviceId = entryServiceId,
                originalRequest = true,
                measurementCohort = time >= warmupMs && time < arrivalEndMs,
            )
            scheduleNext()
        }

    init {
        require(meanInterArrivalMs > 0.0) { "Exponential mean must be > 0.0" }
    }

    override fun initialize() {
        scheduleNext()
    }

    private fun scheduleNext() {
        val delayMs = KSLRandom.rExponential(meanInterArrivalMs, stream)
        val nextArrivalMs = time + delayMs
        if (!nextArrivalMs.isFinite()) {
            throw ExperimentExecutionException("Next arrival time must be finite")
        }
        if (nextArrivalMs < arrivalEndMs) {
            schedule(arrivalAction, delayMs)
        }
    }
}
```

- [ ] **Step 7: `ServiceRuntime.kt` — заменить файл целиком**

```kotlin
package resiliencelab.core.simulation

import ksl.modeling.entity.Allocation
import ksl.modeling.entity.AllocationListenerIfc
import ksl.modeling.entity.ProcessModel
import ksl.modeling.entity.RequestQ
import ksl.modeling.entity.ResourceWithQ
import ksl.modeling.queue.Queue
import ksl.modeling.queue.QueueListenerIfc
import ksl.simulation.ModelElement
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.FaultSpan
import resiliencelab.core.ir.ServiceNode

/**
 * Owns a service's bounded FIFO admission path, blocking handler pool, and its random sources.
 * A fault is evaluated when local processing starts; its sampled duration and failure outcome are unaffected
 * by the fault interval ending while that attempt continues.
 */
internal class ServiceRuntime(
    parent: ModelElement,
    private val node: ServiceNode,
    streams: StreamSource,
    val outgoingCall: CallEdge?,
    onAdmitted: (ProcessModel.Entity) -> Unit,
    onQueueLengthChanged: (Int) -> Unit,
    onBusyHandlersChanged: (Int) -> Unit,
) {
    val serviceId: String = node.path
    private val durationSampler =
        DurationSamplerFactory.create(node.processing, streams.stream(node.path, StreamRole.PROCESSING))
    private val outcomeStream = streams.stream(node.path, StreamRole.OUTCOME)
    private val networkSampler =
        outgoingCall?.let { DurationSamplerFactory.create(it.network, streams.stream(it.path, StreamRole.NETWORK)) }
    private val jitterStream = outgoingCall?.let { streams.stream(it.path, StreamRole.JITTER) }
    private var activeFault: FaultSpan? = null

    val resource: ResourceWithQ
    val queue: RequestQ =
        BoundedRequestQ(
            parent = parent,
            name = "$serviceId:queue",
            waitingCapacity = node.queueCapacity,
            resourceProvider = { resource },
        )

    init {
        resource =
            FifoResourceWithQ(
                parent = parent,
                name = serviceId,
                capacity = node.handlers,
                queue = queue,
            )
        queue.addQueueListener(
            object : QueueListenerIfc<ProcessModel.Entity.Request> {
                override fun update(
                    status: Queue.Status,
                    queue: Queue<ProcessModel.Entity.Request>,
                    qObject: ProcessModel.Entity.Request?,
                ) {
                    onQueueLengthChanged(queue.size)
                    if (status == Queue.Status.ENQUEUED && qObject != null) {
                        onAdmitted(qObject.entity)
                    }
                }
            },
        )
        resource.addAllocationListener(
            object : AllocationListenerIfc {
                override fun allocate(allocation: Allocation) {
                    onBusyHandlersChanged(resource.numBusy)
                }

                override fun deallocate(allocation: Allocation) {
                    onBusyHandlersChanged(resource.numBusy)
                }
            },
        )
    }

    fun resetFaults() {
        activeFault = null
    }

    fun startFault(fault: FaultSpan) {
        activeFault = fault
    }

    fun endFault(fault: FaultSpan) {
        if (activeFault == fault) activeFault = null
    }

    fun nextDurationMs(): Double = durationSampler.next() * (activeFault?.processingMultiplier ?: 1.0)

    fun nextLocalFailure(): Boolean {
        val failureProbability = activeFault?.failureProbability ?: node.failureProbability
        return outcomeStream.randU01() < failureProbability
    }

    fun nextNetworkDelayMs(): Double = requireNotNull(networkSampler).next()

    fun nextJitter(): Double = requireNotNull(jitterStream).randU01()
}
```

- [ ] **Step 8: `MetricsCollector.kt` — две точечные замены**

Заменить импорт:

```kotlin
import resiliencelab.core.scenario.ServiceSpec
```

на:

```kotlin
import resiliencelab.core.ir.ServiceNode
```

Заменить начало класса:

```kotlin
class MetricsCollector(
    services: List<ServiceSpec>,
```

на:

```kotlin
class MetricsCollector(
    services: List<ServiceNode>,
```

и строку

```kotlin
            service.id to MutableServiceMetrics(service.handlers, measurementStartMs, measurementEndMs)
```

на:

```kotlin
            service.path to MutableServiceMetrics(service.handlers, measurementStartMs, measurementEndMs)
```

- [ ] **Step 9: `ReliabilityModel.kt` — точечные замены**

Заменить блок импортов:

```kotlin
import ksl.modeling.entity.KSLProcess
import ksl.modeling.entity.ProcessModel
import ksl.simulation.KSLEvent
import ksl.simulation.Model
import ksl.simulation.ModelElement
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.scenario.Execution
import resiliencelab.core.scenario.Scenario
import kotlin.time.Duration.Companion.seconds
```

на:

```kotlin
import ksl.modeling.entity.KSLProcess
import ksl.modeling.entity.ProcessModel
import ksl.simulation.KSLEvent
import ksl.simulation.Model
import ksl.simulation.ModelElement
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.ChainIr
import resiliencelab.core.scenario.Execution
import resiliencelab.core.scenario.Scenario
import kotlin.time.Duration.Companion.seconds
```

Заменить заголовок класса и поля до `var activeInvocations` (от `class ReliabilityModel(` до закрывающей скобки `associateBy { it.serviceId }` включительно) на:

```kotlin
class ReliabilityModel(
    model: Model,
    private val chain: ChainIr,
    private val streams: StreamSource,
    private val onReplicationCompleted: ((Int, ReplicationResult) -> Unit)? = null,
) : ProcessModel(model) {
    /** MVP constructor: maps [scenario] onto the chain IR with the MVP stream numbering; removed together with the MVP API. */
    constructor(
        model: Model,
        scenario: Scenario,
        execution: Execution,
        onReplicationCompleted: ((Int, ReplicationResult) -> Unit)? = null,
    ) : this(
        model,
        LegacyScenarioAdapter.chain(scenario, execution),
        LegacyScenarioAdapter.streams(model, scenario, execution.seed),
        onReplicationCompleted,
    )

    private val measurementStartMs = chain.run.warmupMs
    private val measurementEndMs = chain.run.warmupMs + chain.run.measurementMs

    val metrics =
        MetricsCollector(
            services = chain.services,
            measurementStartMs = measurementStartMs,
            measurementEndMs = measurementEndMs,
            currentTimeMs = { time },
        )
    private val runtimes =
        chain.services
            .map { service ->
                ServiceRuntime(
                    parent = this,
                    node = service,
                    streams = streams,
                    outgoingCall = chain.outgoingCall(service.path),
                    onAdmitted = ::recordAdmission,
                    onQueueLengthChanged = { queueLength ->
                        metrics.recordQueueLength(service.path, this@ReliabilityModel.time, queueLength)
                    },
                    onBusyHandlersChanged = { busyHandlers ->
                        metrics.recordBusyHandlers(service.path, this@ReliabilityModel.time, busyHandlers)
                    },
                )
            }.associateBy { it.serviceId }
```

Заменить блок `init { ... }`:

```kotlin
    init {
        model.lengthOfReplication = Double.POSITIVE_INFINITY
        model.maximumAllowedExecutionTimePerReplication = execution.maxRealTimeSeconds.seconds
    }
```

на:

```kotlin
    init {
        model.lengthOfReplication = Double.POSITIVE_INFINITY
        model.maximumAllowedExecutionTimePerReplication = chain.run.maxRealTimeSeconds.seconds
    }
```

В `initialize()` заменить:

```kotlin
        runtimes.values.forEach { it.resetDegradation() }
        val measurementStartMs = execution.warmupMs
        val measurementEndMs = execution.warmupMs + execution.measurementMs
```

на:

```kotlin
        runtimes.values.forEach { it.resetFaults() }
```

и блок от `val degradation = scenario.degradation` до конца `if (degradation != null) { ... }` на:

```kotlin
        chain.faults.forEach { fault ->
            val runtime = runtimes.getValue(fault.target)
            schedule(
                eventAction = ModelElement.EventActionIfc<Nothing> { runtime.startFault(fault) },
                timeToEvent = fault.fromMs,
                priority = KSLEvent.DEFAULT_PRIORITY - 1,
            )
            schedule(
                eventAction = ModelElement.EventActionIfc<Nothing> { runtime.endFault(fault) },
                timeToEvent = fault.toMs,
                priority = KSLEvent.DEFAULT_PRIORITY - 1,
            )
        }
```

Заменить тело `prepareWorkload()` после `if (workloadPrepared) return`:

```kotlin
        ArrivalGenerator(
            reliabilityModel = this,
            entryServiceId = scenario.entry,
            arrivalRate = scenario.workload.arrivalRate,
            warmupMs = execution.warmupMs,
            measurementMs = execution.measurementMs,
            streamNum = scenario.services.size * 2 + scenario.links.size * 2 + 1,
        )
        CompletionMonitor(
            reliabilityModel = this,
            arrivalEndMs = execution.warmupMs + execution.measurementMs,
        )
```

на:

```kotlin
        ArrivalGenerator(
            reliabilityModel = this,
            entryServiceId = chain.entry,
            arrivalRate = chain.client.arrivalRatePerMs,
            warmupMs = chain.run.warmupMs,
            measurementMs = chain.run.measurementMs,
            stream = streams.stream(chain.client.path, StreamRole.ARRIVALS),
        )
        CompletionMonitor(
            reliabilityModel = this,
            arrivalEndMs = measurementEndMs,
        )
```

В `isFullyDrained()` заменить `time >= execution.warmupMs + execution.measurementMs &&` на `time >= measurementEndMs &&`.

В `invoke(...)` заменить `(arrivalTimeMs + scenario.workload.requestDeadlineMs)` на `(arrivalTimeMs + chain.client.deadlineMs)`.

В процессе `work` заменить:

```kotlin
                                val link = runtime.outgoingLink
                                if (link == null) {
```

на:

```kotlin
                                val call = runtime.outgoingCall
                                if (call == null) {
```

и внутри цикла попыток: `serviceId = link.to,` → `serviceId = call.to,`; `timeoutMs = minOf(link.timeoutMs, originalDeadlineMs - time),` → `timeoutMs = minOf(call.timeoutMs, originalDeadlineMs - time),`; `if (attemptNumber == link.maxAttempts) {` → `if (attemptNumber == call.attempts) {`; `retry = link.retry,` → `backoff = call.backoff,`.

- [ ] **Step 10: Новый и старые тесты проходят**

Run: `./gradlew :core:test`
Expected: PASS — `ChainModelTest` и все прежние тесты `simulation`, `experiment`, `scenario` без изменений.

- [ ] **Step 11: Commit**

```bash
./gradlew :core:ktlintFormat
git add core/src/main/kotlin/resiliencelab/core/simulation core/src/test/kotlin/resiliencelab/core/simulation/ChainModelTest.kt
git commit -m "refactor(core): run the engine on chain IR with injected streams"
```

---

### Task 10: Исполнение задач

**Files:**
- Create: `core/src/main/kotlin/resiliencelab/core/execution/ExperimentExecutor.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/execution/ExperimentExecutorTest.kt`

- [ ] **Step 1: Написать падающий тест**

```kotlin
package resiliencelab.core.execution

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import resiliencelab.core.compiler.CompiledExperiment
import resiliencelab.core.compiler.CompiledVariant
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.ChainIr
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode
import java.util.Collections
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.test.Test

class ExperimentExecutorTest {
    private val run = RunSettings(replications = 3, warmupMs = 0.0, measurementMs = 300.0, seed = 11, maxRealTimeSeconds = 30)

    private fun chain(attempts: Int) =
        ChainIr(
            client = ClientNode("client", 0.05, 200.0),
            entry = "front",
            services =
                listOf(
                    ServiceNode("back", 1, 2, Distribution(DistributionShape.EXPONENTIAL, 6.0), 0.02),
                    ServiceNode("front", 2, 4, Distribution(DistributionShape.FIXED, 1.0), 0.0),
                ),
            calls =
                listOf(
                    CallEdge(
                        path = "front-to-back",
                        from = "front",
                        to = "back",
                        network = Distribution(DistributionShape.FIXED, 0.5),
                        timeoutMs = 15.0,
                        attempts = attempts,
                        backoff = Backoff(BackoffKind.EXPONENTIAL_FULL_JITTER, 1.0, 4.0, 2.0),
                    ),
                ),
            faults = emptyList(),
            run = run,
        )

    private val experiment =
        CompiledExperiment(
            variants = listOf(CompiledVariant("baseline", "Baseline", chain(3)), CompiledVariant("single", "Single", chain(1))),
            run = run,
        )

    @Test
    fun `results do not depend on the number of workers`() {
        val sequential = ExperimentExecutor(workers = 1).run(experiment)
        val parallel = ExperimentExecutor(workers = 4).run(experiment)

        assertThat(parallel).isEqualTo(sequential)
        assertThat(sequential.variants.map { it.id }).containsExactly("baseline", "single")
        assertThat(sequential.variants.first().replications).hasSize(3)
    }

    @Test
    fun `identical variants share common random numbers`() {
        val twins =
            experiment.copy(variants = listOf(CompiledVariant("a", "A", chain(2)), CompiledVariant("b", "B", chain(2))))

        val result = ExperimentExecutor(workers = 2).run(twins)

        assertThat(result.variants[0].replications).isEqualTo(result.variants[1].replications)
    }

    @Test
    fun `reports progress for every task in increasing order`() {
        val progress = Collections.synchronizedList(mutableListOf<Pair<Int, Int>>())

        ExperimentExecutor(workers = 3).run(experiment) { completed, total -> progress += completed to total }

        assertThat(progress).containsExactly(1 to 6, 2 to 6, 3 to 6, 4 to 6, 5 to 6, 6 to 6)
    }

    @Test
    fun `concurrent runs of one executor share its workers`() {
        val active = AtomicInteger()
        val peak = AtomicInteger()
        val executor =
            ExperimentExecutor(workers = 1) { _, _, _, _ ->
                peak.accumulateAndGet(active.incrementAndGet()) { a, b -> maxOf(a, b) }
                Thread.sleep(20)
                active.decrementAndGet()
                ReplicationResult(emptyList(), emptyList(), emptyList(), emptyList(), 0, 0, 0, emptyMap())
            }

        val runs = (1..2).map { thread { executor.run(experiment) } }
        runs.forEach { it.join() }

        assertThat(peak.get()).isEqualTo(1)
    }

    @Test
    fun `a closed executor accepts no runs`() {
        val executor = ExperimentExecutor(workers = 1)
        executor.close()

        assertThatThrownBy { executor.run(experiment) }.isInstanceOf(RejectedExecutionException::class.java)
    }

    @Test
    fun `rethrows the failure of a task`() {
        val failing = ExperimentExecutor(workers = 2) { _, _, _, _ -> throw IllegalStateException("boom") }

        assertThatThrownBy { failing.run(experiment) }.isInstanceOf(IllegalStateException::class.java).hasMessage("boom")
    }
}
```

- [ ] **Step 2: Тест падает**

Run: `./gradlew :core:test --tests 'resiliencelab.core.execution.ExperimentExecutorTest'`
Expected: FAIL — `Unresolved reference: ExperimentExecutor`.

- [ ] **Step 3: Реализация**

```kotlin
package resiliencelab.core.execution

import ksl.simulation.Model
import resiliencelab.core.compiler.CompiledExperiment
import resiliencelab.core.experiment.AggregateMetrics
import resiliencelab.core.experiment.MetricsAggregator
import resiliencelab.core.experiment.ReplicationResult
import resiliencelab.core.ir.ChainIr
import resiliencelab.core.simulation.PathStreamSource
import resiliencelab.core.simulation.PathStreams
import resiliencelab.core.simulation.ReliabilityModel
import resiliencelab.core.simulation.StreamPlan
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Replications of one variant and their aggregate. */
data class VariantRun(
    val id: String,
    val label: String,
    val replications: List<ReplicationResult>,
    val aggregate: AggregateMetrics,
)

/** Result of all tasks of an experiment, in variant order. */
data class ExperimentRun(
    val variants: List<VariantRun>,
)

/**
 * Runs every (variant, replication) task in a fresh KSL model with path-based streams (ADR 0006). All runs of one
 * executor share its [workers] threads (ADR 0009; interleaving tasks of different jobs is a later step). The stream
 * plan of all tasks is checked for collisions before any model runs, so results do not depend on the number of workers
 * or on the order of task completion. Worker threads are daemons; [close] stops them.
 */
class ExperimentExecutor internal constructor(
    private val workers: Int,
    private val replicate: (ChainIr, StreamPlan, Long, Int) -> ReplicationResult,
) : AutoCloseable {
    constructor(workers: Int = defaultWorkers()) : this(workers, ::runReplication)

    init {
        require(workers >= 1) { "workers must be at least 1" }
    }

    private val pool: ExecutorService =
        Executors.newFixedThreadPool(workers) { task -> Thread(task, "experiment-task").apply { isDaemon = true } }

    fun run(
        experiment: CompiledExperiment,
        onProgress: (completed: Int, total: Int) -> Unit = { _, _ -> },
    ): ExperimentRun {
        val replications = experiment.run.replications
        val plan =
            StreamPlan(
                experiment.variants.flatMap { variant -> (0 until replications).flatMap { PathStreams.keys(variant.chain, it) } },
            )
        val tasks = experiment.variants.indices.flatMap { variant -> (0 until replications).map { variant to it } }
        val results = Array(experiment.variants.size) { arrayOfNulls<ReplicationResult>(replications) }
        val progress = Progress(tasks.size, onProgress)
        val futures =
            tasks.map { (variant, replication) ->
                pool.submit(
                    Callable {
                        val result = replicate(experiment.variants[variant].chain, plan, experiment.run.seed, replication)
                        synchronized(results) { results[variant][replication] = result }
                        progress.completeOne()
                    },
                )
            }
        try {
            futures.forEach { future ->
                try {
                    future.get()
                } catch (exception: ExecutionException) {
                    throw exception.cause ?: exception
                }
            }
        } finally {
            futures.forEach { it.cancel(true) }
        }
        return ExperimentRun(
            experiment.variants.mapIndexed { index, variant ->
                val variantReplications = results[index].map { requireNotNull(it) }
                VariantRun(variant.id, variant.label, variantReplications, MetricsAggregator.aggregate(variantReplications))
            },
        )
    }

    /** Stops the worker threads; tasks still running are interrupted. */
    override fun close() {
        pool.shutdownNow()
    }

    companion object {
        /** All cores but one, so the server stays responsive (ADR 0009). */
        fun defaultWorkers(): Int = maxOf(1, Runtime.getRuntime().availableProcessors() - 1)
    }
}

/** Finished tasks of one run; the count and its notification change together, so reported counts only grow. */
private class Progress(
    private val total: Int,
    private val onProgress: (Int, Int) -> Unit,
) {
    private var completed = 0

    @Synchronized
    fun completeOne() {
        completed += 1
        onProgress(completed, total)
    }
}

/** One task: a fresh KSL model, one replication, streams of this replication only. */
private fun runReplication(
    chain: ChainIr,
    plan: StreamPlan,
    seed: Long,
    replication: Int,
): ReplicationResult {
    val model = Model("resilience-lab-task", autoCSVReports = false)
    return ReliabilityModel(model, chain, PathStreamSource(plan, seed, replication.toLong())).runReplication()
}
```

- [ ] **Step 4: Тест проходит**

Run: `./gradlew :core:test --tests 'resiliencelab.core.execution.ExperimentExecutorTest'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
./gradlew :core:ktlintFormat
git add core/src/main/kotlin/resiliencelab/core/execution core/src/test/kotlin/resiliencelab/core/execution
git commit -m "feat(core): execute variant replications as parallel tasks"
```

---

### Task 11: Файловая рабочая область

**Files:**
- Create: `core/src/main/kotlin/resiliencelab/core/workspace/Workspace.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/workspace/FileWorkspaceTest.kt`

- [ ] **Step 1: Написать падающий тест**

```kotlin
package resiliencelab.core.workspace

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import kotlin.test.Test

class FileWorkspaceTest {
    private val root = Files.createTempDirectory("workspace-test")
    private val workspace = FileWorkspace(root)

    @Test
    fun `writes, reads and versions documents`() {
        val version = workspace.write("models/a.model.json", "{}\n")

        val document = workspace.read("models/a.model.json")

        assertThat(document.text).isEqualTo("{}\n")
        assertThat(document.version).isEqualTo(version).isEqualTo(DocumentVersion.of("{}\n"))
        assertThat(workspace.exists("models/a.model.json")).isTrue()
        assertThat(workspace.exists("models/missing.model.json")).isFalse()
    }

    @Test
    fun `rejects writes against a stale version`() {
        val first = workspace.write("a.model.json", "1\n")
        workspace.write("a.model.json", "2\n", expectedVersion = first)

        assertThatThrownBy { workspace.write("a.model.json", "3\n", expectedVersion = first) }
            .isInstanceOf(VersionConflictException::class.java)
        assertThatThrownBy { workspace.write("new.model.json", "x\n", expectedVersion = first) }
            .isInstanceOf(VersionConflictException::class.java)
    }

    @Test
    fun `lists json documents outside hidden directories`() {
        workspace.write("b.experiment.json", "{}\n")
        workspace.write("a/x.model.json", "{}\n")
        workspace.write(".results/run/summary.json", "{}\n")
        Files.writeString(root.resolve("notes.txt"), "x")

        assertThat(workspace.list()).containsExactly("a/x.model.json", "b.experiment.json")
    }

    @Test
    fun `rejects paths that leave the workspace and missing documents`() {
        listOf("../x.json", "/abs.json", "a/../../x.json", "", "a\\b.json", "\u0000.layout.json").forEach { path ->
            assertThatThrownBy { workspace.read(path) }.describedAs(path).isInstanceOf(InvalidDocumentPathException::class.java)
        }
        assertThatThrownBy { workspace.read("missing.json") }.isInstanceOf(DocumentNotFoundException::class.java)
    }

    @Test
    fun `rejects paths that escape through symbolic links`() {
        val outside = Files.createTempDirectory("workspace-outside")
        Files.writeString(outside.resolve("outside.layout.json"), "{}\n")
        Files.createSymbolicLink(root.resolve("external"), outside)

        assertThatThrownBy { workspace.read("external/outside.layout.json") }.isInstanceOf(InvalidDocumentPathException::class.java)
        assertThatThrownBy { workspace.write("external/outside.layout.json", "x\n") }.isInstanceOf(InvalidDocumentPathException::class.java)
        assertThatThrownBy { workspace.create("external/new.layout.json", "x\n") }.isInstanceOf(InvalidDocumentPathException::class.java)
        assertThat(Files.readString(outside.resolve("outside.layout.json"))).isEqualTo("{}\n")
        assertThat(workspace.list()).isEmpty()
    }

    @Test
    fun `creates a document once even under concurrent requests`() {
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        val attempts =
            (1..2).map { n ->
                pool.submit(
                    Callable {
                        start.await()
                        runCatching { workspace.create("race.layout.json", "$n\n") }
                    },
                )
            }
        start.countDown()
        val results = attempts.map { it.get() }
        pool.shutdown()

        assertThat(results.count { it.isSuccess }).isEqualTo(1)
        assertThat(results.single { it.isFailure }.exceptionOrNull()).isInstanceOf(DocumentExistsException::class.java)
        assertThat(workspace.read("race.layout.json").version).isEqualTo(results.single { it.isSuccess }.getOrThrow())
    }

    @Test
    fun `rejects documents that are not UTF-8`() {
        Files.write(root.resolve("broken.model.json"), byteArrayOf(0x7b, 0xC3.toByte(), 0x28, 0x7d))

        assertThatThrownBy { workspace.read("broken.model.json") }.isInstanceOf(IOException::class.java)
    }
}
```

- [ ] **Step 2: Тест падает**

Run: `./gradlew :core:test --tests 'resiliencelab.core.workspace.FileWorkspaceTest'`
Expected: FAIL — `Unresolved reference: FileWorkspace`.

- [ ] **Step 3: Реализация**

```kotlin
package resiliencelab.core.workspace

import java.nio.file.Files
import java.nio.file.InvalidPathException
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.security.MessageDigest
import kotlin.io.path.isRegularFile

/** Document text with its version — the SHA-256 of its UTF-8 bytes. */
data class VersionedDocument(
    val path: String,
    val text: String,
    val version: String,
)

class DocumentNotFoundException(
    path: String,
) : RuntimeException("Document '$path' does not exist")

class VersionConflictException(
    path: String,
    expected: String,
    actual: String?,
) : RuntimeException("Document '$path' has version ${actual ?: "none"}, not the expected $expected")

class InvalidDocumentPathException(
    path: String,
) : IllegalArgumentException("Path '$path' is not a relative path inside the workspace")

class DocumentExistsException(
    path: String,
) : RuntimeException("Document '$path' already exists")

/** Versions of document text. */
object DocumentVersion {
    fun of(text: String): String =
        MessageDigest
            .getInstance("SHA-256")
            .digest(text.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
}

/** Storage of workspace documents addressed by relative paths with `/` separators (ADR 0003). */
interface Workspace {
    /** Relative paths of `.json` documents outside hidden directories, sorted. */
    fun list(): List<String>

    fun read(path: String): VersionedDocument

    fun exists(path: String): Boolean

    /**
     * Writes [text] and returns its version. When [expectedVersion] is set, the current version must match it;
     * otherwise [VersionConflictException] is thrown and nothing is written.
     */
    fun write(
        path: String,
        text: String,
        expectedVersion: String? = null,
    ): String

    /**
     * Writes a new document and returns its version. Throws [DocumentExistsException] when the document exists;
     * the check and the write are one atomic step, so of two concurrent creations exactly one succeeds.
     */
    fun create(
        path: String,
        text: String,
    ): String
}

/**
 * Workspace in a directory, usually a git repository. Paths may not leave the directory, also through symbolic links;
 * listings skip symbolic links.
 */
class FileWorkspace(
    root: Path,
) : Workspace {
    private val root: Path = root.toAbsolutePath().normalize()
    private val realRoot: Path = this.root.toRealPath()

    override fun list(): List<String> =
        Files.walk(root).use { paths ->
            paths
                .filter { it.isRegularFile(NOFOLLOW_LINKS) && it.fileName.toString().endsWith(".json") }
                .map { root.relativize(it) }
                .filter { relative -> relative.none { it.toString().startsWith(".") } }
                .map { it.joinToString("/") }
                .sorted()
                .toList()
        }

    override fun read(path: String): VersionedDocument {
        val file = resolve(path)
        if (!file.isRegularFile()) throw DocumentNotFoundException(path)
        val text = Files.readString(file)
        return VersionedDocument(path, text, DocumentVersion.of(text))
    }

    override fun exists(path: String): Boolean = resolve(path).isRegularFile()

    @Synchronized
    override fun write(
        path: String,
        text: String,
        expectedVersion: String?,
    ): String {
        val file = resolve(path)
        if (expectedVersion != null) {
            val current = if (file.isRegularFile()) DocumentVersion.of(Files.readString(file)) else null
            if (current != expectedVersion) throw VersionConflictException(path, expectedVersion, current)
        }
        return store(file, text)
    }

    @Synchronized
    override fun create(
        path: String,
        text: String,
    ): String {
        val file = resolve(path)
        if (Files.exists(file, NOFOLLOW_LINKS)) throw DocumentExistsException(path)
        return store(file, text)
    }

    private fun store(
        file: Path,
        text: String,
    ): String {
        Files.createDirectories(file.parent)
        val temporary = Files.createTempFile(file.parent, ".write-", ".tmp")
        Files.writeString(temporary, text)
        Files.move(temporary, file, REPLACE_EXISTING, ATOMIC_MOVE)
        return DocumentVersion.of(text)
    }

    /**
     * Maps a workspace path to a file inside the root. The deepest existing component of the path must resolve inside
     * the real root, so a symbolic link cannot lead reads or writes outside the workspace.
     */
    private fun resolve(path: String): Path {
        if (path.isBlank() || path.startsWith("/") || path.contains('\\')) throw InvalidDocumentPathException(path)
        val file =
            try {
                root.resolve(path).normalize()
            } catch (exception: InvalidPathException) {
                throw InvalidDocumentPathException(path)
            }
        if (!file.startsWith(root) || file == root) throw InvalidDocumentPathException(path)
        var existing = file
        while (!Files.exists(existing, NOFOLLOW_LINKS)) existing = existing.parent
        val real = runCatching { existing.toRealPath() }.getOrNull()
        if (real == null || !real.startsWith(realRoot)) throw InvalidDocumentPathException(path)
        return file
    }
}
```

- [ ] **Step 4: Тест проходит**

Run: `./gradlew :core:test --tests 'resiliencelab.core.workspace.FileWorkspaceTest'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
./gradlew :core:ktlintFormat
git add core/src/main/kotlin/resiliencelab/core/workspace core/src/test/kotlin/resiliencelab/core/workspace
git commit -m "feat(core): add file workspace with document versions"
```

---

### Task 12: Артефакт прогона

**Files:**
- Create: `core/src/main/kotlin/resiliencelab/core/results/RunArtifact.kt`
- Modify: `.gitignore`
- Test: `core/src/test/kotlin/resiliencelab/core/results/RunArtifactTest.kt`

Прогоны пишутся в `.results/` рабочей области, а этот каталог не попадает в git (ADR 0008, п. 9): в конец `.gitignore` добавить строку `.results/`.

- [ ] **Step 1: Написать падающий тест**

```kotlin
package resiliencelab.core.results

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import resiliencelab.core.experiment.AggregateMetrics
import resiliencelab.core.experiment.LatencySummary
import resiliencelab.core.workspace.DocumentVersion
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import kotlin.test.Test

class RunArtifactTest {
    @Test
    fun `places runs under the results directory by experiment name`() {
        assertThat(ResultsLayout.runDirectory("examples/retry-storm.experiment.json", "run-1"))
            .isEqualTo(".results/retry-storm/run-1")
        assertThat(ResultsLayout.runDirectory("plain.json", "r")).isEqualTo(".results/plain.json/r")
    }

    @Test
    fun `rejects run ids and experiment names that leave the results directory`() {
        listOf("../..", "..", ".", "a/b", "", ".hidden").forEach { runId ->
            assertThatThrownBy { ResultsLayout.runDirectory("e.experiment.json", runId) }
                .describedAs(runId)
                .isInstanceOf(IllegalArgumentException::class.java)
        }
        assertThatThrownBy { ResultsLayout.runDirectory("..experiment.json", "run-1") }
            .isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun `writes canonical summary, then the manifest with the summary checksum`() {
        val workspace = FileWorkspace(Files.createTempDirectory("artifact-test"))
        val aggregate = AggregateMetrics(LatencySummary(null, null, null), null, null, null, emptyMap())
        val summary = RunSummary(1, "e.experiment.json", listOf(VariantSummary("baseline", "Baseline", 2, aggregate)))
        val manifest =
            RunManifest(
                schemaVersion = 1,
                applicationVersion = Versions.APPLICATION,
                kslVersion = Versions.KSL,
                streamAssignment = "v1",
                experiment = "e.experiment.json",
                documents = mapOf("m.model.json" to "b", "e.experiment.json" to "a"),
                seed = 7,
                replications = 2,
                variants = listOf("baseline"),
                parts = emptyMap(),
                complete = true,
            )

        val written = ArtifactWriter(workspace).write(".results/e/run-1", manifest, summary)

        val summaryText = workspace.read(".results/e/run-1/summary.json").text
        val manifestText = workspace.read(".results/e/run-1/manifest.json").text
        assertThat(summaryText).contains("\"replications\": 2").endsWith("}\n")
        assertThat(written.parts).containsExactlyEntriesOf(mapOf("summary.json" to DocumentVersion.of(summaryText)))
        assertThat(manifestText).contains("\"complete\": true").contains(DocumentVersion.of(summaryText))
        assertThat(manifestText.indexOf("e.experiment.json\": \"a\"")).isLessThan(manifestText.indexOf("m.model.json\": \"b\""))
    }
}
```

- [ ] **Step 2: Тест падает**

Run: `./gradlew :core:test --tests 'resiliencelab.core.results.RunArtifactTest'`
Expected: FAIL — `Unresolved reference: ResultsLayout`.

- [ ] **Step 3: Реализация**

```kotlin
package resiliencelab.core.results

import kotlinx.serialization.Serializable
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.experiment.AggregateMetrics
import resiliencelab.core.workspace.Workspace

/** Versions recorded in every manifest (ADR 0008; D6). */
object Versions {
    const val APPLICATION = "0.1.0"
    const val KSL = "R1.8.1"
}

/**
 * Reproducibility record of a run (ADR 0008): versions, stream assignment, versions of the documents read,
 * seed, SHA-256 of every part file and completeness. Contains no timestamps, so equal inputs give byte-identical
 * manifests.
 */
@Serializable
data class RunManifest(
    val schemaVersion: Int,
    val applicationVersion: String,
    val kslVersion: String,
    val streamAssignment: String,
    val experiment: String,
    val documents: Map<String, String>,
    val seed: Long,
    val replications: Int,
    val variants: List<String>,
    val parts: Map<String, String>,
    val complete: Boolean,
)

/** Aggregated metrics of one variant. */
@Serializable
data class VariantSummary(
    val id: String,
    val label: String,
    val replications: Int,
    val aggregate: AggregateMetrics,
)

/** Summary of a run, loaded first by the UI. */
@Serializable
data class RunSummary(
    val schemaVersion: Int,
    val experiment: String,
    val variants: List<VariantSummary>,
)

/** Workspace locations of run artifacts (ADR 0008, item 1). */
object ResultsLayout {
    private val segment = Regex("^[A-Za-z0-9][A-Za-z0-9._-]*$")

    /**
     * `.results/<experiment name without .experiment.json>/<runId>`. Both parts must be single plain path segments, so
     * an artifact can never be written outside `.results/`.
     */
    fun runDirectory(
        experimentPath: String,
        runId: String,
    ): String {
        val name = experimentPath.substringAfterLast('/').removeSuffix(".experiment.json")
        require(segment.matches(name)) { "Experiment name '$name' cannot name a results directory" }
        require(segment.matches(runId)) { "Run id '$runId' must match ${segment.pattern}" }
        return ".results/$name/$runId"
    }
}

/** Writes the artifact; the manifest goes last so that its presence marks a finished run. */
class ArtifactWriter(
    private val workspace: Workspace,
) {
    /** Writes [summary], then [manifest] with the checksums of the written parts, and returns that manifest. */
    fun write(
        runDirectory: String,
        manifest: RunManifest,
        summary: RunSummary,
    ): RunManifest {
        val summaryVersion = workspace.write("$runDirectory/summary.json", DocumentCodec.encode(RunSummary.serializer(), summary))
        val written = manifest.copy(parts = mapOf("summary.json" to summaryVersion))
        workspace.write("$runDirectory/manifest.json", DocumentCodec.encode(RunManifest.serializer(), written))
        return written
    }
}
```

- [ ] **Step 4: Тест проходит**

Run: `./gradlew :core:test --tests 'resiliencelab.core.results.RunArtifactTest'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
./gradlew :core:ktlintFormat
git add .gitignore core/src/main/kotlin/resiliencelab/core/results core/src/test/kotlin/resiliencelab/core/results
git commit -m "feat(core): write run manifest and summary artifacts"
```

---

### Task 13: Пример retry storm в новом формате

**Files:**
- Create: `examples/retry-storm/retry-storm.model.json`
- Create: `examples/retry-storm/retry-storm.layout.json`
- Create: `examples/retry-storm/retry-storm.experiment.json`
- Test: `core/src/test/kotlin/resiliencelab/core/document/ExampleDocumentsTest.kt`

Значения перенесены из `examples/retry-storm.json`: интенсивность 0.12 запроса/мс = `120/s`. Файлы записаны в канонической форме `DocumentCodec` — ключи по алфавиту, два пробела, перевод строки в конце.

- [ ] **Step 1: `retry-storm.model.json`**

```json
{
  "blocks": {
    "client": {
      "params": {
        "deadline": "250ms",
        "rate": "120/s"
      },
      "type": "client"
    },
    "dependency": {
      "params": {
        "handlers": 2,
        "processing": {
          "kind": "fixed",
          "mean": "8ms"
        },
        "queue": 8
      },
      "type": "service"
    },
    "gateway": {
      "params": {
        "handlers": 4,
        "processing": {
          "kind": "fixed",
          "mean": "1ms"
        },
        "queue": 16
      },
      "type": "service"
    },
    "middle": {
      "params": {
        "handlers": 4,
        "processing": {
          "kind": "fixed",
          "mean": "2ms"
        },
        "queue": 12
      },
      "type": "service"
    }
  },
  "connections": [
    {
      "from": "client",
      "id": "client-to-gateway",
      "to": "gateway",
      "type": "request"
    },
    {
      "from": "gateway",
      "id": "gateway-to-middle",
      "params": {
        "attempts": 3,
        "backoff": {
          "base": "2ms",
          "kind": "exponential-full-jitter",
          "max": "20ms",
          "multiplier": 2
        },
        "network": {
          "kind": "fixed",
          "mean": "0.5ms"
        },
        "timeout": "80ms"
      },
      "to": "middle",
      "type": "call"
    },
    {
      "from": "middle",
      "id": "middle-to-dependency",
      "params": {
        "attempts": 3,
        "backoff": {
          "base": "2ms",
          "kind": "exponential-full-jitter",
          "max": "20ms",
          "multiplier": 2
        },
        "network": {
          "kind": "fixed",
          "mean": "0.5ms"
        },
        "timeout": "60ms"
      },
      "to": "dependency",
      "type": "call"
    }
  ],
  "description": "Retry storm on a three-service chain with a degraded dependency.",
  "schemaVersion": 1
}
```

- [ ] **Step 2: `retry-storm.layout.json` и `retry-storm.experiment.json`**

```json
{
  "positions": {
    "client": {
      "x": 0.0,
      "y": 100.0
    },
    "dependency": {
      "x": 780.0,
      "y": 100.0
    },
    "gateway": {
      "x": 260.0,
      "y": 100.0
    },
    "middle": {
      "x": 520.0,
      "y": 100.0
    }
  },
  "schemaVersion": 1
}
```

```json
{
  "description": "Compares retries with no retries while the dependency is six times slower.",
  "execution": {
    "measurement": "1s",
    "replications": 2,
    "seed": 20261025,
    "warmup": "0ms"
  },
  "faults": [
    {
      "failureRate": "5%",
      "from": "200ms",
      "processingMultiplier": 6.0,
      "target": "dependency",
      "to": "700ms"
    }
  ],
  "layoutRef": "retry-storm.layout.json",
  "modelRef": "retry-storm.model.json",
  "schemaVersion": 1,
  "variants": [
    {
      "id": "baseline",
      "label": "Baseline"
    },
    {
      "id": "no-retries",
      "label": "No retries",
      "overrides": {
        "gateway-to-middle.attempts": 1,
        "middle-to-dependency.attempts": 1
      }
    }
  ]
}
```

`maxRealTime` не записан: значение по умолчанию `30s` каноническая запись опускает.

- [ ] **Step 3: Написать тест**

```kotlin
package resiliencelab.core.document

import org.assertj.core.api.Assertions.assertThat
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test

class ExampleDocumentsTest {
    private val directory = Path.of("../examples/retry-storm")

    @Test
    fun `example documents are in canonical form`() {
        val model = Files.readString(directory.resolve("retry-storm.model.json"))
        val layout = Files.readString(directory.resolve("retry-storm.layout.json"))
        val experiment = Files.readString(directory.resolve("retry-storm.experiment.json"))

        assertThat(DocumentCodec.encodeModel((DocumentCodec.decodeModel(model, "m") as DecodeResult.Ok).value)).isEqualTo(model)
        assertThat(DocumentCodec.encodeLayout((DocumentCodec.decodeLayout(layout, "l") as DecodeResult.Ok).value)).isEqualTo(layout)
        assertThat(DocumentCodec.encodeExperiment((DocumentCodec.decodeExperiment(experiment, "e") as DecodeResult.Ok).value))
            .isEqualTo(experiment)
    }
}
```

- [ ] **Step 4: Тест примера проходит**

Run: `./gradlew :core:test --tests 'resiliencelab.core.document.ExampleDocumentsTest'`
Expected: PASS. Если каноническая запись отличается от файла только форматированием, исправить файл примера по выводу `DocumentCodec`, а не правила записи.

- [ ] **Step 5: Commit**

```bash
./gradlew :core:ktlintFormat
git add examples/retry-storm core/src/test/kotlin/resiliencelab/core/document/ExampleDocumentsTest.kt
git commit -m "feat(examples): add retry storm in the stage 1 document format"
```

---

### Task 14: Фасад `Lab`

**Files:**
- Create: `core/src/main/kotlin/resiliencelab/core/lab/Lab.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/lab/LabTest.kt`

Тест запускает пример из Task 13.

- [ ] **Step 1: Написать падающий тест**

```kotlin
package resiliencelab.core.lab

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.copyTo
import kotlin.io.path.createDirectories
import kotlin.test.Test

class LabTest {
    private val experiment = "retry-storm/retry-storm.experiment.json"
    private val model = "retry-storm/retry-storm.model.json"

    private fun exampleWorkspace(): Path {
        val target = Files.createTempDirectory("lab-test")
        val source = Path.of("../examples")
        Files.walk(source.resolve("retry-storm")).use { paths ->
            paths.filter { Files.isRegularFile(it) }.forEach { file ->
                val destination = target.resolve(source.relativize(file).toString())
                destination.parent.createDirectories()
                file.copyTo(destination)
            }
        }
        return target
    }

    @Test
    fun `validates the example without diagnostics`() {
        val report = Lab(FileWorkspace(exampleWorkspace())).validate(experiment)

        assertThat(report.diagnostics).isEmpty()
        assertThat(report.valid).isTrue()
    }

    @Test
    fun `reports missing and unreadable documents and broken references`() {
        val root = exampleWorkspace()
        val lab = Lab(FileWorkspace(root))

        val experimentFile = root.resolve(experiment)
        val original = Files.readString(experimentFile)

        assertThat(lab.validate("missing.experiment.json").diagnostics.single().code).isEqualTo("DOCUMENT_MISSING")

        Files.writeString(experimentFile, original.replace("retry-storm.model.json", "gone.model.json"))
        assertThat(lab.validate(experiment).diagnostics.single().code).isEqualTo("MODEL_REF")

        Files.writeString(experimentFile, original.replace("retry-storm.model.json", "../../x.model.json"))
        assertThat(lab.validate(experiment).diagnostics.single().code).isEqualTo("MODEL_REF")

        Files.writeString(experimentFile, original)
        Files.writeString(root.resolve(model), "{")
        assertThat(lab.validate(experiment).diagnostics.single().code).isEqualTo("JSON_SYNTAX")

        Files.write(root.resolve(model), byteArrayOf(0x7b, 0xC3.toByte(), 0x28, 0x7d))
        assertThat(lab.validate(experiment).diagnostics.single().code).isEqualTo("DOCUMENT_UNREADABLE")
    }

    @Test
    fun `checks the layout reference and the layout document`() {
        val root = exampleWorkspace()
        val lab = Lab(FileWorkspace(root))
        val experimentFile = root.resolve(experiment)
        val original = Files.readString(experimentFile)

        Files.writeString(experimentFile, original.replace("retry-storm.layout.json", "https://example.invalid/layout.json"))
        val remote = lab.validate(experiment).diagnostics.single()
        assertThat(remote.code to remote.pointer).isEqualTo("LAYOUT_REF" to "/layoutRef")

        Files.writeString(experimentFile, original.replace("retry-storm.layout.json", "gone.layout.json"))
        assertThat(lab.validate(experiment).diagnostics.single().code).isEqualTo("LAYOUT_REF")

        Files.writeString(experimentFile, original)
        Files.writeString(root.resolve("retry-storm/retry-storm.layout.json"), "{")
        val broken = lab.validate(experiment)
        assertThat(broken.valid).isFalse()
        assertThat(broken.diagnostics.single().code).isEqualTo("JSON_SYNTAX")
    }

    @Test
    fun `refuses run ids that would leave the results directory before computing`() {
        val root = exampleWorkspace()

        assertThatThrownBy { Lab(FileWorkspace(root)).run(experiment, "../..") }.isInstanceOf(IllegalArgumentException::class.java)
        assertThat(root.resolve(".results")).doesNotExist()
        assertThat(root.resolve("summary.json")).doesNotExist()
    }

    @Test
    fun `refuses to run an invalid experiment`() {
        val lab = Lab(FileWorkspace(exampleWorkspace()))

        assertThatThrownBy { lab.run("missing.experiment.json", "run-1") }.isInstanceOf(InvalidExperimentException::class.java)
    }

    @Test
    fun `runs the example into a reproducible artifact`() {
        val sequentialRoot = exampleWorkspace()
        val parallelRoot = exampleWorkspace()

        val outcome = Lab(FileWorkspace(sequentialRoot), executor = ExperimentExecutor(workers = 1)).run(experiment, "run-1")
        Lab(FileWorkspace(parallelRoot), executor = ExperimentExecutor(workers = 3)).run(experiment, "run-1")

        assertThat(outcome.runDirectory).isEqualTo(".results/retry-storm/run-1")
        assertThat(outcome.summary.variants.map { it.id }).containsExactly("baseline", "no-retries")
        assertThat(outcome.manifest.documents.keys).containsExactly(experiment, model)
        listOf("summary.json", "manifest.json").forEach { file ->
            val relative = ".results/retry-storm/run-1/$file"
            assertThat(Files.readString(parallelRoot.resolve(relative))).isEqualTo(Files.readString(sequentialRoot.resolve(relative)))
        }
    }

    @Test
    fun `block order in the model does not change the summary`() {
        val originalRoot = exampleWorkspace()
        val reorderedRoot = exampleWorkspace()
        val reordered =
            Files.readString(reorderedRoot.resolve(model)).let { text ->
                val start = text.indexOf("\"blocks\": {")
                val end = text.indexOf("\n  },\n  \"connections\"")
                val body = text.substring(start + "\"blocks\": {".length, end)
                val entries = Regex("""\n    "[^"]+": \{[\s\S]*?\n    }""").findAll(body).map { it.value }.toList()
                text.substring(0, start) + "\"blocks\": {" + entries.reversed().joinToString(",") + text.substring(end)
            }
        Files.writeString(reorderedRoot.resolve(model), reordered)

        Lab(FileWorkspace(originalRoot)).run(experiment, "run-1")
        Lab(FileWorkspace(reorderedRoot)).run(experiment, "run-1")

        val summary = ".results/retry-storm/run-1/summary.json"
        assertThat(Files.readString(reorderedRoot.resolve(summary))).isEqualTo(Files.readString(originalRoot.resolve(summary)))
    }

    @Test
    fun `resolves references relative to the document directory`() {
        assertThat(Lab.resolveRef("a/b.experiment.json", "m.model.json")).isEqualTo("a/m.model.json")
        assertThat(Lab.resolveRef("a/b.experiment.json", "../m.model.json")).isEqualTo("m.model.json")
        assertThat(Lab.resolveRef("b.experiment.json", "./x/m.model.json")).isEqualTo("x/m.model.json")
        assertThat(Lab.resolveRef("b.experiment.json", "../m.model.json")).isNull()
        assertThat(Lab.resolveRef("b.experiment.json", "/m.model.json")).isNull()
        assertThat(Lab.resolveRef("b.experiment.json", "https://x/m.model.json")).isNull()
    }
}
```

- [ ] **Step 2: Тест падает**

Run: `./gradlew :core:test --tests 'resiliencelab.core.lab.LabTest'`
Expected: FAIL — `Unresolved reference: Lab`.

- [ ] **Step 3: Реализация**

```kotlin
package resiliencelab.core.lab

import resiliencelab.core.compiler.CompiledExperiment
import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.compiler.ModelCompiler
import resiliencelab.core.compiler.Severity
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.results.ArtifactWriter
import resiliencelab.core.results.ResultsLayout
import resiliencelab.core.results.RunManifest
import resiliencelab.core.results.RunSummary
import resiliencelab.core.results.VariantSummary
import resiliencelab.core.results.Versions
import resiliencelab.core.simulation.PathStreams
import resiliencelab.core.workspace.InvalidDocumentPathException
import resiliencelab.core.workspace.VersionedDocument
import resiliencelab.core.workspace.Workspace
import java.io.IOException

/** Diagnostics of one experiment. */
data class ValidationReport(
    val experimentPath: String,
    val diagnostics: List<Diagnostic>,
) {
    val valid: Boolean get() = diagnostics.none { it.severity == Severity.ERROR }
}

/** Location and contents of a finished run. */
data class RunOutcome(
    val runDirectory: String,
    val manifest: RunManifest,
    val summary: RunSummary,
)

class InvalidExperimentException(
    val diagnostics: List<Diagnostic>,
) : RuntimeException(
        "Experiment has errors: " + diagnostics.filter { it.severity == Severity.ERROR }.joinToString("; ") { it.message },
    )

/** Entry point for the server and the CLI: validates and runs workspace experiments (stage 1 design §4–5). */
class Lab(
    private val workspace: Workspace,
    private val compiler: ModelCompiler = ModelCompiler(),
    private val executor: ExperimentExecutor = ExperimentExecutor(),
) {
    fun validate(experimentPath: String): ValidationReport = ValidationReport(experimentPath, load(experimentPath).diagnostics)

    fun run(
        experimentPath: String,
        runId: String,
        onProgress: (completed: Int, total: Int) -> Unit = { _, _ -> },
    ): RunOutcome {
        val runDirectory = ResultsLayout.runDirectory(experimentPath, runId)
        val loaded = load(experimentPath)
        val compiled = loaded.experiment ?: throw InvalidExperimentException(loaded.diagnostics)
        val result = executor.run(compiled, onProgress)
        val summary =
            RunSummary(
                schemaVersion = 1,
                experiment = experimentPath,
                variants = result.variants.map { VariantSummary(it.id, it.label, it.replications.size, it.aggregate) },
            )
        val manifest =
            RunManifest(
                schemaVersion = 1,
                applicationVersion = Versions.APPLICATION,
                kslVersion = Versions.KSL,
                streamAssignment = PathStreams.ASSIGNMENT_VERSION,
                experiment = experimentPath,
                documents = loaded.versions,
                seed = compiled.run.seed,
                replications = compiled.run.replications,
                variants = compiled.variants.map { it.id },
                parts = emptyMap(),
                complete = true,
            )
        return RunOutcome(runDirectory, ArtifactWriter(workspace).write(runDirectory, manifest, summary), summary)
    }

    private class Loaded(
        val experiment: CompiledExperiment?,
        val diagnostics: List<Diagnostic>,
        val versions: Map<String, String>,
    )

    private fun load(experimentPath: String): Loaded =
        try {
            loadDocuments(experimentPath)
        } catch (exception: UnreadableDocumentException) {
            failed(exception.diagnostic)
        }

    private fun loadDocuments(experimentPath: String): Loaded {
        val experimentDocument =
            read(experimentPath)
                ?: return failed(
                    Diagnostic("DOCUMENT_MISSING", Severity.ERROR, "Document '$experimentPath' does not exist", experimentPath),
                )
        val experiment =
            when (val decoded = DocumentCodec.decodeExperiment(experimentDocument.text, experimentPath)) {
                is DecodeResult.Ok -> decoded.value
                is DecodeResult.Failed -> return Loaded(null, decoded.diagnostics, emptyMap())
            }
        val modelPath = resolveRef(experimentPath, experiment.modelRef)
        val modelDocument =
            modelPath?.let(::read)
                ?: return failed(
                    Diagnostic(
                        "MODEL_REF",
                        Severity.ERROR,
                        "modelRef '${experiment.modelRef}' does not name a model in the workspace",
                        experimentPath,
                        "/modelRef",
                    ),
                )
        val model =
            when (val decoded = DocumentCodec.decodeModel(modelDocument.text, modelDocument.path)) {
                is DecodeResult.Ok -> decoded.value
                is DecodeResult.Failed -> return Loaded(null, decoded.diagnostics, emptyMap())
            }
        val result = compiler.compile(model, modelDocument.path, experiment, experimentPath)
        val layout = experiment.layoutRef?.let { checkLayout(experimentPath, it) }.orEmpty()
        val versions = sortedMapOf(experimentPath to experimentDocument.version, modelDocument.path to modelDocument.version)
        return Loaded(result.experiment.takeIf { layout.isEmpty() }, result.diagnostics + layout, versions)
    }

    /** The optional layout must be a readable layout document inside the workspace (ADR 0005, item 3). */
    private fun checkLayout(
        experimentPath: String,
        layoutRef: String,
    ): List<Diagnostic> {
        val layoutDocument =
            resolveRef(experimentPath, layoutRef)?.let(::read)
                ?: return listOf(
                    Diagnostic(
                        "LAYOUT_REF",
                        Severity.ERROR,
                        "layoutRef '$layoutRef' does not name a layout in the workspace",
                        experimentPath,
                        "/layoutRef",
                    ),
                )
        return when (val decoded = DocumentCodec.decodeLayout(layoutDocument.text, layoutDocument.path)) {
            is DecodeResult.Ok -> emptyList()
            is DecodeResult.Failed -> decoded.diagnostics
        }
    }

    /** The document, or null when it does not exist or its path is invalid; a failed read is a diagnostic, not a crash. */
    private fun read(path: String): VersionedDocument? =
        try {
            if (workspace.exists(path)) workspace.read(path) else null
        } catch (exception: InvalidDocumentPathException) {
            null
        } catch (exception: IOException) {
            val reason = exception.message ?: exception.javaClass.simpleName
            val diagnostic = Diagnostic("DOCUMENT_UNREADABLE", Severity.ERROR, "Document '$path' cannot be read: $reason", path)
            throw UnreadableDocumentException(diagnostic)
        }

    private fun failed(diagnostic: Diagnostic) = Loaded(null, listOf(diagnostic), emptyMap())

    private class UnreadableDocumentException(
        val diagnostic: Diagnostic,
    ) : RuntimeException(diagnostic.message)

    companion object {
        /** Resolves [ref] against the directory of [documentPath]; null when it leaves the workspace or is not relative. */
        fun resolveRef(
            documentPath: String,
            ref: String,
        ): String? {
            if (ref.startsWith("/") || ref.contains('\\') || ref.contains("://")) return null
            val base = documentPath.substringBeforeLast('/', "")
            val segments = ArrayDeque<String>()
            val joined = if (base.isEmpty()) ref else "$base/$ref"
            for (segment in joined.split('/')) {
                when (segment) {
                    "", "." -> Unit
                    ".." -> if (segments.isEmpty()) return null else segments.removeLast()
                    else -> segments.addLast(segment)
                }
            }
            return segments.joinToString("/").ifEmpty { null }
        }
    }
}
```

- [ ] **Step 4: Тест проходит**

Run: `./gradlew :core:test --tests 'resiliencelab.core.lab.LabTest'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
./gradlew :core:ktlintFormat
git add core/src/main/kotlin/resiliencelab/core/lab core/src/test/kotlin/resiliencelab/core/lab
git commit -m "feat(core): add Lab facade for validating and running experiments"
```

---

### Task 15: Полная проверка

- [ ] **Step 1: Полная сборка**

Run: `./gradlew clean build`
Expected: BUILD SUCCESSFUL — тесты, KtLint и отчёты JaCoCo всех модулей.

- [ ] **Step 2: Web и E2E не затронуты**

Run (из `web`): `npm ci && npm run lint && npm test -- --run && npm run build && npm run test:e2e`
Expected: всё проходит — старое API сервера не менялось.

- [ ] **Step 3: Просмотр диффа**

Run: `git diff --check origin/main && git diff --stat origin/main`
Expected: изменения только в `core/`, `examples/retry-storm/` и `core/build.gradle.kts`.

- [ ] **Step 4: PR**

Открыть PR в `main` по правилам `AGENTS.md` (раздел «Работа по issue») с `Closes #<issue среза ядра>`.
