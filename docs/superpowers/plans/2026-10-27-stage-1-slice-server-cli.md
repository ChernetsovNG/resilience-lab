# Срез этапа 1: сервер и CLI — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Открыть API этапа 1 (каталог, документы рабочей области, проверка, задания, прогоны) с генерируемой спецификацией OpenAPI и перевести CLI на документы рабочей области через `Lab`.

**Architecture:** Новые ручки живут в пакете `resiliencelab.server.lab` рядом с ручками MVP: нынешний web и обязательная проверка `e2e` пользуются старыми ручками до плана 3, а удаляет их план 4. Сервер отдаёт классы ядра через kotlinx-конвертер Spring; springdoc строит схему OpenAPI по тем же классам, а настройка JSON и тест-сверка держат их согласованными. CLI переписывается целиком: `validate` и `run` работают с текущим каталогом как с рабочей областью.

**Tech Stack:** Kotlin 2.4.21, JDK 25, Spring Boot 4.1.2 (Spring Framework 7.0.10), springdoc-openapi 3.2.0 (собран на Spring Boot 4.1.2, swagger-core 2.2.55), kotlinx.serialization 1.12.0, AssertJ, MockMvc.

---

## Источники

- Дизайн этапа 1: `docs/superpowers/specs/2026-10-27-stage-1-design.md` — §4.1 (диагностика), §5 (сервер, рабочая область, CLI), §7.1 (срез).
- ADR 0003 (рабочая область), 0008 (артефакт), 0009 (исполнение), 0010 (контракт API) — `docs/architecture/adr/`.
- План 1 — `docs/superpowers/plans/2026-10-27-stage-1-slice-core.md`: этот план опирается на его `Lab`, `Workspace`, `DocumentCodec`, `RunManifest`, `RunSummary`, `ArtifactWriter`, `Stage1Catalog`.

## Предусловие

План 1 выполнен и смержен в `main`: в ядре есть пакеты `catalog`, `document`, `compiler`, `lab`, `results`, `workspace` и пример `examples/retry-storm/`.

## Проверено пробой (2026-10-27)

Пробный сервер на Spring Boot 4.1.2 со springdoc 3.2.0 во временном worktree показал:

- `@Serializable`-классы Spring пишет и читает kotlinx-конвертером, остальные — Jackson. Поле `JsonObject` проходит в обе стороны без потерь.
- Без настройки springdoc выбрасывает из схемы поля `JsonObject` и помечает обязательными поля со значением по умолчанию, которые kotlinx по умолчанию не пишет. Бин `Json { encodeDefaults = true }` подхватывается конвертером Spring Boot, а `SpringDocUtils.replaceWithSchema` для `JsonObject` и `JsonElement` возвращает поля в схему; после этого JSON и схема совпадают.
- `springdoc.packages-to-scan` оставляет в спецификации только новый пакет; `@RestControllerAdvice(assignableTypes = ...)` ограничивает старый обработчик ошибок его контроллерами.
- Ответы-ошибки попадают в схему только из обработчиков с `@ResponseStatus`; обработчики, возвращающие `ResponseEntity`, springdoc не описывает.
- Путь документа с `/` проходит в параметре запроса; `ResponseEntity.eTag(...)` сам ставит кавычки.
- `writer-with-order-by-keys` и `writer-with-default-pretty-printer` дают стабильный многострочный JSON спецификации.

Ревью плана (2026-10-27) и повторная проба добавили:

- Пустая `JsonSchema()` для `JsonElement` превращается в `type: object`, и валидатор JSON Schema 2020-12 отвергает реальные значения `default: 0`, `"0%"` и `overrides: { "…attempts": 1 }`. Схема «любой JSON» — `types` из всех семи типов JSON плюс `additionalProperties: true`; с ней ответы проходят `Draft202012Validator`, а openapi-typescript даёт тип «любое JSON-значение».
- У nullable enum (`dimension: Dimension?`) springdoc пишет `type: ["string", "null"]`, но в `enum` нет `null`, и ответ с `null` не проходит валидатор. `OpenApiCustomizer` добавляет `null` в такие `enum`.

## Правила для типов API

- Типы API — обычные `@Serializable` data-классы и enum без `@SerialName`, `@Transient`, собственных сериализаторов и полиморфизма: схему строит springdoc по свойствам Kotlin, JSON пишет kotlinx, и имена полей обязаны совпадать.
- Ответы содержат все поля; отсутствующее значение пишется как `null`. Это даёт бин `apiJson`.
- Имена методов контроллеров уникальны во всём пакете: из них springdoc делает `operationId`, а совпадения он нумерует в порядке обхода.
- Ответы-ошибки — `ApiProblem` из обработчиков с `@ResponseStatus` (400, 404, 409, 500).
- Поля `JsonElement` описываются схемой «любой JSON», nullable enum — с `null` в `enum` (см. `LabConfiguration`); `OpenApiConformance` в тестах проверяет типы, `enum`, `null` и обязательные поля ответов.

## Границы плана

- **Входит:** рабочая область из параметра запуска; ручки `health`, `catalog`, документов (список, чтение, запись с `If-Match`), `validate`, `jobs`, `runs`; `apps/server/openapi.json` и тест его актуальности; CLI `validate` и `run [--workers N]`; образ Docker с рабочей областью; документация.
- **Не входит:** TS-типы и web (план 3); удаление ручек MVP, пакета `scenario`, `ExperimentRunner`, `SweepExpander`, `SeedFactory` и адаптера, перенос смысловых тестов на IR, переименование `simulation` в `engine.ksl` (план 4). Дорожке T2 остаются `DELETE` документа, отслеживание внешних изменений, `estimate`, отмена и досчёт заданий, части рядов и подключение каталога хоста в Compose.
- **Отличие от §5.2 дизайна:** путь документа передаётся параметром `?path=`, потому что содержит `/`, а закодированный `%2F` в пути URL сервер отвергает. Дизайн уже поправлен.
- **Задания:** одно задание за раз, каждое раскладывает свои задачи на пул ядра; чередование заданий — дорожка T1.

## Карта файлов

| Файл | Ответственность |
|---|---|
| `core/.../workspace/Workspace.kt` (изменение) | `listFiles(directory)` для поиска прогонов |
| `core/.../lab/RunIds.kt` | Идентификаторы прогонов: время UTC и случайный суффикс |
| `core/.../results/RunCatalog.kt` | Поиск законченных прогонов в `.results/` |
| `apps/server/build.gradle.kts` | springdoc, рабочий каталог `bootRun`, рабочая область тестов |
| `apps/server/src/main/resources/application.yml` | Настройки springdoc и рабочей области |
| `apps/server/.../lab/LabConfiguration.kt` | Бины: JSON API, OpenAPI, рабочая область, `Lab`, задания |
| `apps/server/.../lab/ApiTypes.kt` | Типы запросов и ответов |
| `apps/server/.../lab/LabExceptionHandler.kt` | Исключения API и `ApiProblem` |
| `apps/server/.../lab/HealthController.kt` | Перенос `health` в новый пакет |
| `apps/server/.../lab/CatalogController.kt` | `GET /catalog` |
| `apps/server/.../lab/DocumentController.kt`, `Documents.kt`, `IfMatch.kt` | Документы рабочей области, строгое сравнение `If-Match` |
| `apps/server/.../lab/ValidationController.kt` | `POST /validate` |
| `apps/server/.../lab/JobService.kt`, `JobController.kt` | Задания |
| `apps/server/.../lab/RunController.kt` | Прогоны |
| `apps/server/.../api/ApiExceptionHandler.kt` (изменение) | Ограничить старый обработчик старыми контроллерами |
| `apps/server/openapi.json` | Сгенерированная спецификация |
| `apps/server/Dockerfile`, `.dockerignore` | Рабочая область в образе, `.results/` вне образа (вне git — с плана ядра) |
| `apps/cli/src/main/kotlin/resiliencelab/cli/Main.kt` | CLI на `Lab` |
| `AGENTS.md`, `README.md` | Команды и поведение |

Многоточие `...` в путях — `src/main/kotlin/resiliencelab/<модуль>` или `src/test/kotlin/resiliencelab/<модуль>`; тесты лежат в тех же пакетах.

Общие команды:

- один тест: `./gradlew :<модуль>:test --tests '<полное.имя.Класса>'`
- форматирование: `./gradlew ktlintFormat`
- проверка модуля: `./gradlew :<модуль>:check`

---

### Task 1: Список файлов каталога в рабочей области

**Files:**
- Modify: `core/src/main/kotlin/resiliencelab/core/workspace/Workspace.kt`
- Modify: `core/src/test/kotlin/resiliencelab/core/workspace/FileWorkspaceTest.kt`

- [ ] **Step 1: Добавить падающий тест в `FileWorkspaceTest`**

```kotlin
    @Test
    fun `lists every file under a directory, hidden ones included`() {
        workspace.write(".results/e/run-1/manifest.json", "{}\n")
        workspace.write(".results/e/run-1/summary.json", "{}\n")
        workspace.write("a.model.json", "{}\n")

        assertThat(workspace.listFiles(".results"))
            .containsExactly(".results/e/run-1/manifest.json", ".results/e/run-1/summary.json")
        assertThat(workspace.listFiles("missing")).isEmpty()
        assertThatThrownBy { workspace.listFiles("../outside") }.isInstanceOf(InvalidDocumentPathException::class.java)
    }
```

- [ ] **Step 2: Тест падает**

Run: `./gradlew :core:test --tests 'resiliencelab.core.workspace.FileWorkspaceTest'`
Expected: FAIL — `Unresolved reference: listFiles`.

- [ ] **Step 3: Реализация**

В интерфейс `Workspace` после `fun list(): List<String>` добавить:

```kotlin
    /** Relative paths of all files under [directory], hidden ones included, sorted; empty when it does not exist. */
    fun listFiles(directory: String): List<String>
```

В `FileWorkspace` после `override fun list()` добавить:

```kotlin
    override fun listFiles(directory: String): List<String> {
        val start = resolve(directory)
        if (!start.isDirectory()) return emptyList()
        return Files.walk(start).use { paths ->
            paths
                .filter { it.isRegularFile(NOFOLLOW_LINKS) }
                .map { root.relativize(it).joinToString("/") }
                .sorted()
                .toList()
        }
    }
```

и импорт `kotlin.io.path.isDirectory`. Символьные ссылки пропускаются, как в `list()`.

- [ ] **Step 4: Тест проходит**

Run: `./gradlew :core:test --tests 'resiliencelab.core.workspace.FileWorkspaceTest'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
./gradlew :core:ktlintFormat
git add core/src/main/kotlin/resiliencelab/core/workspace/Workspace.kt core/src/test/kotlin/resiliencelab/core/workspace/FileWorkspaceTest.kt
git commit -m "feat(core): list files under a workspace directory"
```

---

### Task 2: Идентификаторы прогонов

**Files:**
- Create: `core/src/main/kotlin/resiliencelab/core/lab/RunIds.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/lab/RunIdsTest.kt`

- [ ] **Step 1: Написать падающий тест**

```kotlin
package resiliencelab.core.lab

import org.assertj.core.api.Assertions.assertThat
import java.time.Instant
import kotlin.random.Random
import kotlin.test.Test

class RunIdsTest {
    @Test
    fun `formats UTC time with a hexadecimal suffix`() {
        assertThat(RunIds.next(Instant.parse("2026-10-27T15:30:12.345Z"), Random(1)))
            .matches("20261027-153012-345-[0-9a-f]{4}")
    }

    @Test
    fun `ids sort by start time`() {
        val earlier = RunIds.next(Instant.parse("2026-10-27T09:00:00Z"), Random(1))
        val later = RunIds.next(Instant.parse("2026-10-27T10:00:00Z"), Random(2))

        assertThat(earlier).isLessThan(later)
    }
}
```

- [ ] **Step 2: Тест падает**

Run: `./gradlew :core:test --tests 'resiliencelab.core.lab.RunIdsTest'`
Expected: FAIL — `Unresolved reference: RunIds`.

- [ ] **Step 3: Реализация**

```kotlin
package resiliencelab.core.lab

import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.random.Random

/**
 * Run ids shared by the server and the CLI: UTC start time to the millisecond and a random suffix, so that ids are
 * single path segments and sort by start time (ADR 0008).
 */
object RunIds {
    private val timestamp = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss-SSS").withZone(ZoneOffset.UTC)

    fun next(
        now: Instant = Instant.now(),
        random: Random = Random.Default,
    ): String = timestamp.format(now) + "-" + random.nextInt(0x10000).toString(16).padStart(4, '0')
}
```

- [ ] **Step 4: Тест проходит**

Run: `./gradlew :core:test --tests 'resiliencelab.core.lab.RunIdsTest'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
./gradlew :core:ktlintFormat
git add core/src/main/kotlin/resiliencelab/core/lab/RunIds.kt core/src/test/kotlin/resiliencelab/core/lab/RunIdsTest.kt
git commit -m "feat(core): generate sortable run ids"
```

---

### Task 3: Каталог прогонов

**Files:**
- Create: `core/src/main/kotlin/resiliencelab/core/results/RunCatalog.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/results/RunCatalogTest.kt`

- [ ] **Step 1: Написать падающий тест**

```kotlin
package resiliencelab.core.results

import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import kotlin.test.Test

class RunCatalogTest {
    private val workspace = FileWorkspace(Files.createTempDirectory("run-catalog"))
    private val catalog = RunCatalog(workspace)

    private fun finish(
        directory: String,
        experiment: String,
        complete: Boolean = true,
    ) {
        val manifest =
            RunManifest(
                schemaVersion = 1,
                applicationVersion = Versions.APPLICATION,
                kslVersion = Versions.KSL,
                streamAssignment = "v1",
                experiment = experiment,
                documents = emptyMap(),
                seed = 7,
                replications = 1,
                variants = emptyList(),
                parts = emptyMap(),
                complete = complete,
            )
        ArtifactWriter(workspace).write(directory, manifest, RunSummary(1, experiment, emptyList()))
    }

    @Test
    fun `lists finished runs newest first and reads their parts`() {
        finish(".results/a/20261027-090000-000-0001", "a.experiment.json")
        finish(".results/b/20261027-100000-000-0002", "b.experiment.json")
        workspace.write(".results/a/20261027-110000-000-0003/summary.json", "{}\n")

        assertThat(catalog.list().map { it.id }).containsExactly("20261027-100000-000-0002", "20261027-090000-000-0001")
        assertThat(catalog.list().first())
            .isEqualTo(RunEntry("20261027-100000-000-0002", "b.experiment.json", ".results/b/20261027-100000-000-0002"))
        assertThat(catalog.manifest("20261027-090000-000-0001")!!.experiment).isEqualTo("a.experiment.json")
        assertThat(catalog.summary("20261027-090000-000-0001")!!.experiment).isEqualTo("a.experiment.json")
        assertThat(catalog.manifest("missing")).isNull()
        assertThat(catalog.summary("missing")).isNull()
    }

    @Test
    fun `skips runs with unreadable manifests`() {
        finish(".results/a/r1", "a.experiment.json")
        workspace.write(".results/a/r2/manifest.json", "{")

        assertThat(catalog.list().map { it.id }).containsExactly("r1")
    }

    @Test
    fun `does not present an incomplete run as finished`() {
        finish(".results/a/r1", "a.experiment.json", complete = false)

        assertThat(catalog.list()).isEmpty()
        assertThat(catalog.manifest("r1")).isNull()
        assertThat(catalog.summary("r1")).isNull()
    }

    @Test
    fun `is empty without results`() {
        assertThat(catalog.list()).isEmpty()
    }
}
```

- [ ] **Step 2: Тест падает**

Run: `./gradlew :core:test --tests 'resiliencelab.core.results.RunCatalogTest'`
Expected: FAIL — `Unresolved reference: RunCatalog`.

- [ ] **Step 3: Реализация**

```kotlin
package resiliencelab.core.results

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import resiliencelab.core.workspace.Workspace

/** A finished run: its manifest exists and says the run is complete (ADR 0008). */
@Serializable
data class RunEntry(
    val id: String,
    val experiment: String,
    val directory: String,
)

/** Finds finished runs under `.results/<experiment>/<run>/`. */
class RunCatalog(
    private val workspace: Workspace,
) {
    /** Parts are written without `null` values, so missing nullable fields read as `null`. */
    @OptIn(ExperimentalSerializationApi::class)
    private val json = Json { explicitNulls = false }

    /** Finished runs, newest first; incomplete runs and runs whose manifest cannot be read are skipped. */
    fun list(): List<RunEntry> =
        workspace
            .listFiles(RESULTS)
            .filter { MANIFEST.matches(it) }
            .mapNotNull { path ->
                val directory = path.removeSuffix("/$MANIFEST_FILE")
                runCatching { readManifest(directory) }
                    .getOrNull()
                    ?.takeIf { it.complete }
                    ?.let { RunEntry(directory.substringAfterLast('/'), it.experiment, directory) }
            }.sortedWith(compareByDescending<RunEntry> { it.id }.thenBy { it.directory })

    fun manifest(id: String): RunManifest? = find(id)?.let { readManifest(it.directory) }

    fun summary(id: String): RunSummary? =
        find(id)?.let { json.decodeFromString(RunSummary.serializer(), workspace.read("${it.directory}/$SUMMARY_FILE").text) }

    private fun find(id: String): RunEntry? = list().firstOrNull { it.id == id }

    private fun readManifest(directory: String): RunManifest =
        json.decodeFromString(RunManifest.serializer(), workspace.read("$directory/$MANIFEST_FILE").text)

    private companion object {
        const val RESULTS = ".results"
        const val MANIFEST_FILE = "manifest.json"
        const val SUMMARY_FILE = "summary.json"
        val MANIFEST = Regex("""^\.results/[^/]+/[^/]+/manifest\.json$""")
    }
}
```

- [ ] **Step 4: Тест проходит**

Run: `./gradlew :core:test --tests 'resiliencelab.core.results.RunCatalogTest'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
./gradlew :core:ktlintFormat
git add core/src/main/kotlin/resiliencelab/core/results/RunCatalog.kt core/src/test/kotlin/resiliencelab/core/results/RunCatalogTest.kt
git commit -m "feat(core): find finished runs in the workspace"
```

---

### Task 4: Конфигурация сервера и общие типы API

**Files:**
- Modify: `apps/server/build.gradle.kts`, `apps/server/src/main/resources/application.yml`, `.dockerignore`
- Modify: `apps/server/src/main/kotlin/resiliencelab/server/api/ApiExceptionHandler.kt`
- Delete: `apps/server/src/main/kotlin/resiliencelab/server/api/HealthController.kt`, `apps/server/src/test/kotlin/resiliencelab/server/api/HealthControllerTest.kt`
- Create: `apps/server/src/main/kotlin/resiliencelab/server/lab/LabConfiguration.kt`, `ApiTypes.kt`, `LabExceptionHandler.kt`, `HealthController.kt`, `JobService.kt` (заготовка; полная реализация — Task 7)
- Test: `apps/server/src/test/kotlin/resiliencelab/server/lab/HealthControllerTest.kt`, `LabConfigurationTest.kt`

- [ ] **Step 1: Сборка**

В `apps/server/build.gradle.kts` после строки `implementation("com.fasterxml.jackson.module:jackson-module-kotlin")` добавить:

```kotlin
    implementation("org.springdoc:springdoc-openapi-starter-webmvc-api:3.2.0")
```

Заменить блок `tasks.test { ... }` на:

```kotlin
tasks.test {
    useJUnitPlatform()
    systemProperty("resilience-lab.workspace", rootProject.file("examples").absolutePath)
}

tasks.named<org.springframework.boot.gradle.tasks.run.BootRun>("bootRun") {
    workingDir = rootProject.projectDir
}
```

`bootRun` по умолчанию запускается из `apps/server`, где нет `examples/`; Playwright запускает его же, поэтому без `workingDir` E2E упадут при старте сервера.

- [ ] **Step 2: Настройки**

`apps/server/src/main/resources/application.yml` целиком:

```yaml
server:
  address: 127.0.0.1
  port: 8080
  shutdown: graceful

spring:
  main:
    banner-mode: off

springdoc:
  packages-to-scan: resiliencelab.server.lab
  writer-with-order-by-keys: true
  writer-with-default-pretty-printer: true
  default-produces-media-type: application/json

resilience-lab:
  workspace: examples
```

В конец `.dockerignore` добавить строку `**/.results/`: прогоны `bootRun` пишутся в `examples/.results/` и не должны попадать в образ. В git они не попадают с плана ядра, который добавил `.results/` в `.gitignore`.

- [ ] **Step 3: Написать падающие тесты**

`apps/server/src/test/kotlin/resiliencelab/server/lab/HealthControllerTest.kt` (перенос из пакета `api`):

```kotlin
package resiliencelab.server.lab

import com.jayway.jsonpath.JsonPath
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get

@WebMvcTest(HealthController::class)
class HealthControllerTest {
    @Autowired
    private lateinit var mockMvc: MockMvc

    @Test
    fun `health returns exact application status and versions`() {
        val response = mockMvc.perform(get("/api/v1/health")).andReturn().response
        val body: Map<String, String> = JsonPath.read(response.contentAsString, "$")

        assertThat(response.status).isEqualTo(200)
        assertThat(body).containsExactlyInAnyOrderEntriesOf(
            mapOf(
                "status" to "ok",
                "applicationVersion" to "0.1.0",
                "kslVersion" to "R1.8.1",
            ),
        )
    }
}
```

`apps/server/src/test/kotlin/resiliencelab/server/lab/LabConfigurationTest.kt`:

```kotlin
package resiliencelab.server.lab

import io.swagger.v3.oas.models.Components
import io.swagger.v3.oas.models.OpenAPI
import io.swagger.v3.oas.models.media.JsonSchema
import io.swagger.v3.oas.models.media.ObjectSchema
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class LabConfigurationTest {
    @Test
    fun `rejects a missing workspace directory`() {
        assertThatThrownBy { LabConfiguration().workspace("does-not-exist") }
            .isInstanceOf(IllegalStateException::class.java)
            .hasMessageContaining("does not exist")
    }

    @Test
    fun `API JSON writes every property, absent values as null`() {
        val job = JobView("j", "e.experiment.json", "r", JobStatus.QUEUED, 0, 0)

        assertThat(LabConfiguration().apiJson().encodeToString(JobView.serializer(), job)).isEqualTo(
            """{"id":"j","experiment":"e.experiment.json","runId":"r","status":"QUEUED",""" +
                """"completedTasks":0,"totalTasks":0,"error":null,"diagnostics":[]}""",
        )
    }

    @Test
    fun `nullable enums accept null in the schema`() {
        val dimension = JsonSchema().types(setOf("string", "null"))
        dimension.enum = listOf("DURATION", "RATE")
        val required = JsonSchema().types(setOf("string"))
        required.enum = listOf("ERROR", "WARNING")
        val descriptor = ObjectSchema().addProperty("dimension", dimension).addProperty("severity", required)
        val openApi = OpenAPI().components(Components().addSchemas("Descriptor", descriptor))

        LabConfiguration().nullableEnums().customise(openApi)

        assertThat(dimension.enum).containsExactly("DURATION", "RATE", null)
        assertThat(required.enum).containsExactly("ERROR", "WARNING")
    }
}
```

- [ ] **Step 4: Реализация**

`ApiTypes.kt`:

```kotlin
package resiliencelab.server.lab

import kotlinx.serialization.Serializable
import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.document.ExperimentFile
import resiliencelab.core.document.LayoutFile
import resiliencelab.core.document.ModelFile

// API types follow the rules of the server plan: plain @Serializable classes, no @SerialName, @Transient, custom
// serializers or polymorphism, because springdoc derives the schema from Kotlin properties and kotlinx writes the JSON.

/** Error body of the stage 1 API (stage 1 design §4.1). */
@Serializable
data class ApiProblem(
    val code: String,
    val message: String,
    val diagnostics: List<Diagnostic> = emptyList(),
)

/** Server status and versions. */
@Serializable
data class HealthView(
    val status: String,
    val applicationVersion: String,
    val kslVersion: String,
)

/** Workspace document kinds by file suffix (ADR 0005). */
@Serializable
enum class DocumentKind(
    val suffix: String,
) {
    MODEL(".model.json"),
    LAYOUT(".layout.json"),
    EXPERIMENT(".experiment.json"),
    ;

    companion object {
        fun of(path: String): DocumentKind? = entries.firstOrNull { path.endsWith(it.suffix) }
    }
}

/** A workspace document without its content. */
@Serializable
data class DocumentEntry(
    val path: String,
    val kind: DocumentKind,
    val version: String,
)

/** Document content: exactly the property of the document kind is set. */
@Serializable
data class DocumentContent(
    val model: ModelFile? = null,
    val layout: LayoutFile? = null,
    val experiment: ExperimentFile? = null,
)

/** A document with its version; the same version is sent as `ETag`. */
@Serializable
data class DocumentView(
    val path: String,
    val kind: DocumentKind,
    val version: String,
    val content: DocumentContent,
)

/** Names an experiment document of the workspace. */
@Serializable
data class ExperimentRequest(
    val experiment: String,
)

/** Diagnostics of one experiment; [valid] is false when any diagnostic is an error. */
@Serializable
data class ValidationView(
    val experiment: String,
    val valid: Boolean,
    val diagnostics: List<Diagnostic>,
)

/** Lifecycle of a process-local job. */
@Serializable
enum class JobStatus {
    QUEUED,
    RUNNING,
    COMPLETED,
    FAILED,
}

/** Snapshot of a job: one run of one experiment; [totalTasks] is known after the first task finishes. */
@Serializable
data class JobView(
    val id: String,
    val experiment: String,
    val runId: String,
    val status: JobStatus,
    val completedTasks: Int,
    val totalTasks: Int,
    val error: String? = null,
    val diagnostics: List<Diagnostic> = emptyList(),
)
```

`LabExceptionHandler.kt`:

```kotlin
package resiliencelab.server.lab

import org.slf4j.LoggerFactory
import org.springframework.http.HttpStatus
import org.springframework.http.converter.HttpMessageNotReadableException
import org.springframework.web.bind.MissingServletRequestParameterException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestControllerAdvice
import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.lab.InvalidExperimentException
import resiliencelab.core.workspace.DocumentExistsException
import resiliencelab.core.workspace.DocumentNotFoundException
import resiliencelab.core.workspace.InvalidDocumentPathException
import resiliencelab.core.workspace.VersionConflictException
import java.io.IOException

/** Failures of the stage 1 API; each subclass maps to one documented status. */
sealed class ApiException(
    val code: String,
    override val message: String,
    val diagnostics: List<Diagnostic> = emptyList(),
) : RuntimeException(message) {
    fun problem(): ApiProblem = ApiProblem(code, message, diagnostics)
}

class BadRequest(
    code: String,
    message: String,
    diagnostics: List<Diagnostic> = emptyList(),
) : ApiException(code, message, diagnostics)

class NotFound(
    code: String,
    message: String,
) : ApiException(code, message)

class Conflict(
    code: String,
    message: String,
    diagnostics: List<Diagnostic> = emptyList(),
) : ApiException(code, message, diagnostics)

/**
 * Maps failures of the stage 1 endpoints to [ApiProblem]. Every handler declares its status with `@ResponseStatus`,
 * so springdoc documents the error responses; MVP endpoints keep their own handler until they are removed.
 */
@RestControllerAdvice(basePackageClasses = [LabExceptionHandler::class])
class LabExceptionHandler {
    @ExceptionHandler(BadRequest::class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    fun badRequest(exception: BadRequest): ApiProblem = exception.problem()

    @ExceptionHandler(InvalidExperimentException::class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    fun invalidExperiment(exception: InvalidExperimentException): ApiProblem =
        ApiProblem("EXPERIMENT_INVALID", "Experiment has errors", exception.diagnostics)

    @ExceptionHandler(InvalidDocumentPathException::class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    fun invalidPath(exception: InvalidDocumentPathException): ApiProblem =
        ApiProblem("DOCUMENT_PATH", exception.message ?: "Invalid document path")

    @ExceptionHandler(HttpMessageNotReadableException::class, MissingServletRequestParameterException::class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    fun unreadable(): ApiProblem = ApiProblem("REQUEST_INVALID", "Request body or parameters are invalid")

    @ExceptionHandler(NotFound::class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    fun notFound(exception: NotFound): ApiProblem = exception.problem()

    @ExceptionHandler(DocumentNotFoundException::class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    fun documentNotFound(exception: DocumentNotFoundException): ApiProblem =
        ApiProblem("DOCUMENT_NOT_FOUND", exception.message ?: "Document not found")

    @ExceptionHandler(Conflict::class)
    @ResponseStatus(HttpStatus.CONFLICT)
    fun conflict(exception: Conflict): ApiProblem = exception.problem()

    @ExceptionHandler(VersionConflictException::class)
    @ResponseStatus(HttpStatus.CONFLICT)
    fun versionConflict(exception: VersionConflictException): ApiProblem =
        ApiProblem("VERSION_CONFLICT", exception.message ?: "Document version conflict")

    @ExceptionHandler(DocumentExistsException::class)
    @ResponseStatus(HttpStatus.CONFLICT)
    fun documentExists(exception: DocumentExistsException): ApiProblem =
        ApiProblem("VERSION_REQUIRED", "${exception.message}; send If-Match with its version")

    @ExceptionHandler(IOException::class)
    @ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)
    fun storageFailure(exception: IOException): ApiProblem {
        logger.error("Workspace storage failed", exception)
        return ApiProblem("STORAGE_ERROR", "Workspace storage failed")
    }

    private companion object {
        val logger = LoggerFactory.getLogger(LabExceptionHandler::class.java)
    }
}
```

`HealthController.kt`:

```kotlin
package resiliencelab.server.lab

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController
import resiliencelab.core.results.Versions

/** Exposes health information independently of jobs. */
@RestController
class HealthController {
    @GetMapping("/api/v1/health")
    fun health(): HealthView = HealthView("ok", Versions.APPLICATION, Versions.KSL)
}
```

`LabConfiguration.kt`:

```kotlin
package resiliencelab.server.lab

import io.swagger.v3.oas.models.OpenAPI
import io.swagger.v3.oas.models.info.Info
import io.swagger.v3.oas.models.media.JsonSchema
import io.swagger.v3.oas.models.media.Schema
import io.swagger.v3.oas.models.servers.Server
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.springdoc.core.customizers.OpenApiCustomizer
import org.springdoc.core.utils.SpringDocUtils
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.lab.Lab
import resiliencelab.core.lab.RunIds
import resiliencelab.core.results.RunCatalog
import resiliencelab.core.results.Versions
import resiliencelab.core.workspace.FileWorkspace
import resiliencelab.core.workspace.Workspace
import java.nio.file.Files
import java.nio.file.Path

/**
 * Beans of the stage 1 API (ADR 0010): the workspace directory, the core [Lab], jobs, and the JSON and OpenAPI
 * settings that keep kotlinx responses and the springdoc schema in agreement.
 */
@Configuration(proxyBeanMethods = false)
class LabConfiguration {
    init {
        // Any JSON value. An empty schema is emitted as `type: object` and would reject numbers and strings.
        val anyJson = JsonSchema().types(setOf("array", "boolean", "integer", "null", "number", "object", "string"))
        SpringDocUtils
            .getConfig()
            .replaceWithSchema(JsonObject::class.java, JsonSchema().types(setOf("object")).additionalProperties(true))
            .replaceWithSchema(JsonElement::class.java, anyJson.additionalProperties(true))
    }

    /** Adds `null` to the `enum` of nullable enum properties: springdoc lists only the constants (JSON Schema 2020-12). */
    @Bean
    fun nullableEnums(): OpenApiCustomizer =
        OpenApiCustomizer { openApi ->
            openApi.components?.schemas?.values?.forEach { schema ->
                schema.properties?.values?.forEach { property ->
                    @Suppress("UNCHECKED_CAST")
                    val typed = property as Schema<Any?>
                    val values = typed.enum
                    if (typed.types?.contains("null") == true && values != null && null !in values) typed.enum = values + null
                }
            }
        }

    /**
     * JSON of `@Serializable` requests and responses, picked up by the Spring Boot kotlinx converter. Every property is
     * written and absent values are `null`, so a response holds exactly what the schema marks as required.
     */
    @Bean
    fun apiJson(): Json = Json { encodeDefaults = true }

    @Bean
    fun openApi(): OpenAPI =
        OpenAPI()
            .info(Info().title("resilience-lab API").version(Versions.APPLICATION))
            .servers(listOf(Server().url("/")))

    /** The workspace directory from `resilience-lab.workspace` or `RESILIENCE_LAB_WORKSPACE`; it must exist. */
    @Bean
    fun workspace(
        @Value("\${resilience-lab.workspace}") directory: String,
    ): Workspace {
        val root = Path.of(directory).toAbsolutePath().normalize()
        check(Files.isDirectory(root)) { "Workspace directory $root does not exist" }
        return FileWorkspace(root)
    }

    /** One pool of simulation tasks for all jobs (ADR 0009); Spring closes it with the context. */
    @Bean
    fun experimentExecutor(): ExperimentExecutor = ExperimentExecutor()

    @Bean
    fun lab(
        workspace: Workspace,
        experimentExecutor: ExperimentExecutor,
    ): Lab = Lab(workspace, executor = experimentExecutor)

    @Bean
    fun runCatalog(workspace: Workspace): RunCatalog = RunCatalog(workspace)

    /** One job at a time; each job spreads its tasks over the core pool (stage 1 slice: no interleaving). */
    @Bean
    fun labJobExecutor(): ThreadPoolTaskExecutor =
        ThreadPoolTaskExecutor().apply {
            setCorePoolSize(1)
            setMaxPoolSize(1)
            setQueueCapacity(100)
            setThreadNamePrefix("lab-job-")
            setWaitForTasksToCompleteOnShutdown(true)
            setAwaitTerminationSeconds(30)
        }

    @Bean
    fun jobService(
        lab: Lab,
        @Qualifier("labJobExecutor") executor: ThreadPoolTaskExecutor,
    ): JobService = JobService(lab, executor) { RunIds.next() }
}
```

Бин `jobService` ссылается на `JobService` из Task 7. Чтобы Task 4 собиралась сама, создать в `JobService.kt` минимальный класс с той же сигнатурой конструктора; Task 7 заменит файл целиком:

```kotlin
package resiliencelab.server.lab

import resiliencelab.core.lab.Lab
import java.util.concurrent.Executor

/** Process-local jobs; implemented in the jobs task of the server plan. */
class JobService(
    private val lab: Lab,
    private val executor: Executor,
    private val maxTerminalJobs: Int = 100,
    private val newRunId: () -> String,
)
```

В `apps/server/src/main/kotlin/resiliencelab/server/api/ApiExceptionHandler.kt` заменить строку `@RestControllerAdvice` на:

```kotlin
@RestControllerAdvice(assignableTypes = [ExperimentController::class, ScenarioController::class])
```

Иначе старый обработчик перехватывает `IllegalArgumentException` (а `InvalidDocumentPathException` — его наследник) и в новых ручках.

Удалить старые файлы:

```bash
git rm apps/server/src/main/kotlin/resiliencelab/server/api/HealthController.kt apps/server/src/test/kotlin/resiliencelab/server/api/HealthControllerTest.kt
```

- [ ] **Step 5: Тесты проходят, старые тоже**

Run: `./gradlew :apps:server:test`
Expected: PASS — новые тесты и все тесты MVP без изменений. `RealExperimentApiTest` поднимает полный контекст: рабочая область берётся из системного свойства, заданного в Step 1. Бин `apiJson` теперь пишет у старого результата `"sweepParameter": null` и `"sweepValue": null`; типы старого web (`web/src/api/types.ts`) как раз ждут `null`.

- [ ] **Step 6: Commit**

```bash
./gradlew ktlintFormat
git add .dockerignore apps/server
git commit -m "feat(server): configure stage 1 API, workspace and OpenAPI"
```

---

### Task 5: Каталог и документы рабочей области

**Files:**
- Create: `apps/server/src/main/kotlin/resiliencelab/server/lab/CatalogController.kt`, `Documents.kt`, `IfMatch.kt`, `DocumentController.kt`
- Test: `apps/server/src/test/kotlin/resiliencelab/server/lab/TestWorkspace.kt`, `OpenApiConformance.kt`, `IfMatchTest.kt`, `WorkspaceApiTest.kt`

- [ ] **Step 1: Тестовые помощники**

`TestWorkspace.kt`:

```kotlin
package resiliencelab.server.lab

import java.nio.file.Files
import java.nio.file.Path

/** Copies the example workspace into a temporary directory, so tests may change documents and write runs. */
object TestWorkspace {
    fun copy(): Path {
        val source = Path.of(requireNotNull(System.getProperty("resilience-lab.workspace")))
        val target = Files.createTempDirectory("lab-api")
        Files.walk(source).use { paths ->
            paths
                .filter { Files.isRegularFile(it) }
                .map { source.relativize(it) }
                .filter { relative -> relative.none { it.toString().startsWith(".") } }
                .forEach { relative ->
                    val destination = target.resolve(relative.toString())
                    Files.createDirectories(destination.parent)
                    Files.copy(source.resolve(relative), destination)
                }
        }
        return target
    }
}
```

`OpenApiConformance.kt`:

```kotlin
package resiliencelab.server.lab

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.assertj.core.api.Assertions.assertThat
import org.springframework.mock.web.MockHttpServletResponse

/**
 * Checks responses against the generated OpenAPI document with the JSON Schema rules the API uses: `$ref`,
 * `oneOf`/`anyOf`, `type` (also as a list), `enum` including `null`, `required`, `properties`, `additionalProperties`
 * and `items`. Guards the agreement between kotlinx, which writes the JSON, and springdoc, which derives the schema.
 */
class OpenApiConformance(
    document: String,
) {
    private val root = Json.parseToJsonElement(document).jsonObject
    private val schemas = root.getValue("components").jsonObject.getValue("schemas").jsonObject

    fun assertResponse(
        method: String,
        path: String,
        response: MockHttpServletResponse,
    ) {
        val operation = root.getValue("paths").jsonObject.getValue(path).jsonObject.getValue(method).jsonObject
        val documented = operation.getValue("responses").jsonObject[response.status.toString()]?.jsonObject
        assertThat(documented).describedAs("$method $path ${response.status} is not documented").isNotNull()
        val schema =
            documented!!
                .getValue("content")
                .jsonObject
                .getValue("application/json")
                .jsonObject
                .getValue("schema")
                .jsonObject
        check(schema, Json.parseToJsonElement(response.getContentAsString(Charsets.UTF_8)), "$method $path ${response.status}")
    }

    private fun check(
        schema: JsonObject,
        value: JsonElement,
        at: String,
    ) {
        (schema["\$ref"] as? JsonPrimitive)?.let { reference ->
            return check(schemas.getValue(reference.content.substringAfterLast('/')).jsonObject, value, at)
        }
        ((schema["oneOf"] ?: schema["anyOf"]) as? JsonArray)?.let { alternatives ->
            val matching = alternatives.count { runCatching { check(it.jsonObject, value, at) }.isSuccess }
            assertThat(matching).describedAs("$at: $value matches none of the alternatives").isPositive()
            return
        }
        val types =
            when (val type = schema["type"]) {
                is JsonPrimitive -> setOf(type.content)
                is JsonArray -> type.map { it.jsonPrimitive.content }.toSet()
                else -> null
            }
        if (types != null) {
            val actual = typeOf(value)
            assertThat(actual in types || (actual == "integer" && "number" in types))
                .describedAs("$at: $actual is not one of $types")
                .isTrue()
        }
        (schema["enum"] as? JsonArray)?.let { values -> assertThat(values).describedAs("$at: $value is not in the enum").contains(value) }
        when (value) {
            is JsonObject -> checkObject(schema, value, at)
            is JsonArray -> {
                val items = schema["items"] as? JsonObject
                if (items != null) value.forEachIndexed { index, item -> check(items, item, "$at[$index]") }
            }
            else -> Unit
        }
    }

    private fun checkObject(
        schema: JsonObject,
        value: JsonObject,
        at: String,
    ) {
        val properties = schema["properties"]?.jsonObject ?: JsonObject(emptyMap())
        val required = schema["required"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()
        assertThat(value.keys).describedAs("$at: missing required properties").containsAll(required)
        val additional = schema["additionalProperties"]
        value.forEach { (name, item) ->
            val property = properties[name] as? JsonObject
            when {
                property != null -> check(property, item, "$at.$name")
                additional is JsonObject -> check(additional, item, "$at.$name")
                else -> assertThat(additional).describedAs("$at.$name is not declared").isEqualTo(JsonPrimitive(true))
            }
        }
    }

    private fun typeOf(value: JsonElement): String =
        when (value) {
            JsonNull -> "null"
            is JsonObject -> "object"
            is JsonArray -> "array"
            is JsonPrimitive ->
                when {
                    value.isString -> "string"
                    value.booleanOrNull != null -> "boolean"
                    value.longOrNull != null -> "integer"
                    else -> "number"
                }
        }
}
```

- [ ] **Step 2: Написать падающий тест**

`WorkspaceApiTest.kt`:

```kotlin
package resiliencelab.server.lab

import com.jayway.jsonpath.JsonPath
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType.APPLICATION_JSON
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec
import resiliencelab.core.document.LayoutFile
import resiliencelab.core.document.ModelFile
import resiliencelab.core.document.Position
import resiliencelab.core.workspace.DocumentVersion
import java.nio.file.Files

@SpringBootTest
@AutoConfigureMockMvc
class WorkspaceApiTest {
    @Autowired
    private lateinit var mockMvc: MockMvc

    private val apiJson = Json { encodeDefaults = true }
    private val model = "retry-storm/retry-storm.model.json"
    private val layout = "retry-storm/retry-storm.layout.json"
    private val experiment = "retry-storm/retry-storm.experiment.json"
    private val openApi by lazy {
        OpenApiConformance(mockMvc.perform(get("/v3/api-docs")).andReturn().response.getContentAsString(Charsets.UTF_8))
    }

    @Test
    fun `serves the catalog`() {
        val response = mockMvc.perform(get("/api/v1/catalog")).andReturn().response

        assertThat(response.status).isEqualTo(200)
        assertThat(JsonPath.read<List<String>>(response.contentAsString, "$.types[*].id"))
            .containsExactly("client", "service", "request", "call")
        openApi.assertResponse("get", "/api/v1/catalog", response)
    }

    @Test
    fun `lists documents with kinds and versions`() {
        val response = mockMvc.perform(get("/api/v1/workspace/documents")).andReturn().response

        val entries = apiJson.decodeFromString(ListSerializer(DocumentEntry.serializer()), response.contentAsString)
        assertThat(entries).contains(
            DocumentEntry(model, DocumentKind.MODEL, version(model)),
            DocumentEntry(layout, DocumentKind.LAYOUT, version(layout)),
            DocumentEntry(experiment, DocumentKind.EXPERIMENT, version(experiment)),
        )
        openApi.assertResponse("get", "/api/v1/workspace/documents", response)
    }

    @Test
    fun `returns a document with its version`() {
        val response = getDocument(model)

        assertThat(response.status).isEqualTo(200)
        assertThat(response.getHeader(HttpHeaders.ETAG)).isEqualTo("\"${version(model)}\"")
        assertThat(JsonPath.read<Int>(response.contentAsString, "$.content.model.blocks.gateway.params.handlers")).isEqualTo(4)
        assertThat(JsonPath.read<Any?>(response.contentAsString, "$.content.layout")).isNull()
        openApi.assertResponse("get", "/api/v1/workspace/document", response)

        val experimentView = getDocument(experiment)
        val attempts = "$.content.experiment.variants[1].overrides['gateway-to-middle.attempts']"
        assertThat(JsonPath.read<Int>(experimentView.contentAsString, attempts)).isEqualTo(1)
        openApi.assertResponse("get", "/api/v1/workspace/document", experimentView)
    }

    @Test
    fun `compares If-Match strongly`() {
        val current = (DocumentCodec.decodeLayout(read(layout), layout) as DecodeResult.Ok).value
        val body = apiJson.encodeToString(DocumentContent.serializer(), DocumentContent(layout = current))
        val version = version(layout)

        assertThat(code(putDocument(layout, body, ifMatch = "W/\"$version\""))).isEqualTo("VERSION_CONFLICT")
        assertThat(putDocument(layout, body, ifMatch = "\"stale\", \"$version\"").status).isEqualTo(200)
        assertThat(putDocument(layout, body, ifMatch = "*").status).isEqualTo(200)
        assertThat(code(putDocument("drafts/absent.layout.json", body, ifMatch = "*"))).isEqualTo("VERSION_CONFLICT")
    }

    @Test
    fun `saves canonical documents and guards versions`() {
        val current = (DocumentCodec.decodeLayout(read(layout), layout) as DecodeResult.Ok).value
        val changed = current.copy(positions = current.positions + ("client" to Position(40.0, 100.0)))
        val body = apiJson.encodeToString(DocumentContent.serializer(), DocumentContent(layout = changed))
        val before = version(layout)

        val saved = putDocument(layout, body, ifMatch = "\"$before\"")

        assertThat(saved.status).isEqualTo(200)
        assertThat(read(layout)).isEqualTo(DocumentCodec.encodeLayout(changed))
        assertThat(saved.getHeader(HttpHeaders.ETAG)).isEqualTo("\"${version(layout)}\"")
        openApi.assertResponse("put", "/api/v1/workspace/document", saved)

        val stale = putDocument(layout, body, ifMatch = "\"$before\"")
        assertThat(stale.status).isEqualTo(409)
        assertThat(code(stale)).isEqualTo("VERSION_CONFLICT")
        openApi.assertResponse("put", "/api/v1/workspace/document", stale)

        assertThat(code(putDocument(layout, body, ifMatch = null))).isEqualTo("VERSION_REQUIRED")

        val created = putDocument("drafts/new.layout.json", body, ifMatch = null)
        assertThat(created.status).isEqualTo(200)
        assertThat(read("drafts/new.layout.json")).isEqualTo(DocumentCodec.encodeLayout(changed))
    }

    @Test
    fun `rejects wrong kinds, invalid content, bad paths and missing documents`() {
        val modelBody =
            apiJson.encodeToString(DocumentContent.serializer(), DocumentContent(model = ModelFile(schemaVersion = 1, blocks = emptyMap())))
        assertThat(code(putDocument("drafts/x.layout.json", modelBody, ifMatch = null))).isEqualTo("DOCUMENT_KIND")

        val futureBody = apiJson.encodeToString(DocumentContent.serializer(), DocumentContent(layout = LayoutFile(schemaVersion = 2)))
        val invalid = putDocument("drafts/future.layout.json", futureBody, ifMatch = null)
        assertThat(invalid.status).isEqualTo(400)
        assertThat(code(invalid)).isEqualTo("DOCUMENT_INVALID")
        assertThat(JsonPath.read<String>(invalid.contentAsString, "$.diagnostics[0].code")).isEqualTo("SCHEMA_VERSION")
        openApi.assertResponse("put", "/api/v1/workspace/document", invalid)

        val malformed =
            mockMvc
                .perform(put("/api/v1/workspace/document").param("path", "drafts/x.layout.json").contentType(APPLICATION_JSON).content("{"))
                .andReturn()
                .response
        assertThat(code(malformed)).isEqualTo("REQUEST_INVALID")

        assertThat(code(getDocument("notes.txt"))).isEqualTo("DOCUMENT_KIND")
        assertThat(code(getDocument("../outside.model.json"))).isEqualTo("DOCUMENT_PATH")
        assertThat(code(getDocument("\u0000.layout.json"))).isEqualTo("DOCUMENT_PATH")

        val missing = getDocument("missing.model.json")
        assertThat(missing.status).isEqualTo(404)
        assertThat(code(missing)).isEqualTo("DOCUMENT_NOT_FOUND")
        openApi.assertResponse("get", "/api/v1/workspace/document", missing)

        Files.writeString(root.resolve("broken.model.json"), "{")
        val broken = getDocument("broken.model.json")
        assertThat(broken.status).isEqualTo(409)
        assertThat(code(broken)).isEqualTo("DOCUMENT_INVALID")
        assertThat(JsonPath.read<String>(broken.contentAsString, "$.diagnostics[0].code")).isEqualTo("JSON_SYNTAX")
    }

    private fun getDocument(path: String): MockHttpServletResponse =
        mockMvc.perform(get("/api/v1/workspace/document").param("path", path)).andReturn().response

    private fun putDocument(
        path: String,
        body: String,
        ifMatch: String?,
    ): MockHttpServletResponse {
        val request = put("/api/v1/workspace/document").param("path", path).contentType(APPLICATION_JSON).content(body)
        ifMatch?.let { request.header(HttpHeaders.IF_MATCH, it) }
        return mockMvc.perform(request).andReturn().response
    }

    private fun code(response: MockHttpServletResponse): String = JsonPath.read(response.contentAsString, "$.code")

    private fun read(path: String): String = Files.readString(root.resolve(path))

    private fun version(path: String): String = DocumentVersion.of(read(path))

    companion object {
        private val root = TestWorkspace.copy()

        @JvmStatic
        @DynamicPropertySource
        fun workspace(registry: DynamicPropertyRegistry) {
            registry.add("resilience-lab.workspace") { root.toString() }
        }
    }
}
```

`IfMatchTest.kt`:

```kotlin
package resiliencelab.server.lab

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class IfMatchTest {
    @Test
    fun `compares entity tags strongly`() {
        assertThat(IfMatch.accepts("\"v1\"", "v1")).isTrue()
        assertThat(IfMatch.accepts("\"v0\", \"v1\"", "v1")).isTrue()
        assertThat(IfMatch.accepts("*", "v1")).isTrue()
        assertThat(IfMatch.accepts("W/\"v1\"", "v1")).isFalse()
        assertThat(IfMatch.accepts("v1", "v1")).isFalse()
        assertThat(IfMatch.accepts("\"v2\"", "v1")).isFalse()
    }
}
```

- [ ] **Step 3: Тест падает**

Run: `./gradlew :apps:server:test --tests 'resiliencelab.server.lab.WorkspaceApiTest' --tests 'resiliencelab.server.lab.IfMatchTest'`
Expected: FAIL — ручки отвечают 404, а `assertResponse` не находит путей в спецификации.

- [ ] **Step 4: Реализация**

`CatalogController.kt`:

```kotlin
package resiliencelab.server.lab

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController
import resiliencelab.core.catalog.Catalog
import resiliencelab.core.catalog.Stage1Catalog

/** Computable block and connection types (ADR 0001). */
@RestController
class CatalogController {
    @GetMapping("/api/v1/catalog")
    fun getCatalog(): Catalog = Stage1Catalog.catalog
}
```

`Documents.kt`:

```kotlin
package resiliencelab.server.lab

import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec

/** Converts between [DocumentContent] and the stored canonical text of each document kind. */
internal object Documents {
    fun decode(
        kind: DocumentKind,
        text: String,
        path: String,
    ): DecodeResult<DocumentContent> =
        when (kind) {
            DocumentKind.MODEL -> DocumentCodec.decodeModel(text, path).toContent { DocumentContent(model = it) }
            DocumentKind.LAYOUT -> DocumentCodec.decodeLayout(text, path).toContent { DocumentContent(layout = it) }
            DocumentKind.EXPERIMENT -> DocumentCodec.decodeExperiment(text, path).toContent { DocumentContent(experiment = it) }
        }

    /** Canonical text, or null when [content] does not hold exactly the property of [kind]. */
    fun encode(
        kind: DocumentKind,
        content: DocumentContent,
    ): String? {
        if (listOfNotNull(content.model, content.layout, content.experiment).size != 1) return null
        return when (kind) {
            DocumentKind.MODEL -> content.model?.let(DocumentCodec::encodeModel)
            DocumentKind.LAYOUT -> content.layout?.let(DocumentCodec::encodeLayout)
            DocumentKind.EXPERIMENT -> content.experiment?.let(DocumentCodec::encodeExperiment)
        }
    }

    private inline fun <T> DecodeResult<T>.toContent(wrap: (T) -> DocumentContent): DecodeResult<DocumentContent> =
        when (this) {
            is DecodeResult.Ok -> DecodeResult.Ok(wrap(value))
            is DecodeResult.Failed -> this
        }
}
```

`IfMatch.kt`:

```kotlin
package resiliencelab.server.lab

/** `If-Match` with strong comparison (RFC 9110 §13.1.1): `*` matches any stored version, weak tags never match. */
internal object IfMatch {
    fun accepts(
        header: String,
        current: String,
    ): Boolean {
        val tags = header.split(',').map { it.trim() }.filter { it.isNotEmpty() }
        return tags == listOf("*") || tags.any { it == "\"$current\"" }
    }
}
```

`DocumentController.kt`:

```kotlin
package resiliencelab.server.lab

import org.springframework.http.HttpHeaders
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import resiliencelab.core.document.DecodeResult
import resiliencelab.core.workspace.Workspace

/**
 * Workspace documents with versions (ADR 0003, ADR 0010). The path is a query parameter because it contains `/`.
 * Without `If-Match` a write only creates a new document; with it the stored version must match. A failed condition
 * is 409, as the project decided. Stored text is always canonical.
 */
@RestController
@RequestMapping("/api/v1/workspace")
class DocumentController(
    private val workspace: Workspace,
) {
    @GetMapping("/documents")
    fun listDocuments(): List<DocumentEntry> =
        workspace.list().mapNotNull { path ->
            DocumentKind.of(path)?.let { kind -> DocumentEntry(path, kind, workspace.read(path).version) }
        }

    @GetMapping("/document")
    fun getDocument(
        @RequestParam path: String,
    ): ResponseEntity<DocumentView> {
        val kind = kindOf(path)
        val document = workspace.read(path)
        val content =
            when (val decoded = Documents.decode(kind, document.text, path)) {
                is DecodeResult.Ok -> decoded.value
                is DecodeResult.Failed -> throw Conflict("DOCUMENT_INVALID", "Stored document '$path' is invalid", decoded.diagnostics)
            }
        return ResponseEntity.ok().eTag(document.version).body(DocumentView(path, kind, document.version, content))
    }

    @PutMapping("/document")
    fun putDocument(
        @RequestParam path: String,
        @RequestHeader(HttpHeaders.IF_MATCH, required = false) ifMatch: String?,
        @RequestBody content: DocumentContent,
    ): ResponseEntity<DocumentEntry> {
        val kind = kindOf(path)
        val text =
            Documents.encode(kind, content)
                ?: throw BadRequest("DOCUMENT_KIND", "Content must hold exactly one document of the kind of '$path'")
        val checked = Documents.decode(kind, text, path)
        if (checked is DecodeResult.Failed) throw BadRequest("DOCUMENT_INVALID", "Document '$path' is invalid", checked.diagnostics)
        val version = if (ifMatch == null) workspace.create(path, text) else replace(path, text, ifMatch)
        return ResponseEntity.ok().eTag(version).body(DocumentEntry(path, kind, version))
    }

    /** Writes over the stored document when [ifMatch] accepts its version; the write itself rechecks that version. */
    private fun replace(
        path: String,
        text: String,
        ifMatch: String,
    ): String {
        val current = if (workspace.exists(path)) workspace.read(path).version else null
        if (current == null || !IfMatch.accepts(ifMatch, current)) {
            throw Conflict("VERSION_CONFLICT", "Document '$path' is not at a version that If-Match accepts")
        }
        return workspace.write(path, text, expectedVersion = current)
    }

    private fun kindOf(path: String): DocumentKind =
        DocumentKind.of(path) ?: throw BadRequest("DOCUMENT_KIND", "'$path' is not a model, layout or experiment document")
}
```

- [ ] **Step 5: Тест проходит**

Run: `./gradlew :apps:server:test --tests 'resiliencelab.server.lab.WorkspaceApiTest'`
Expected: PASS. Если `assertResponse` сообщает о необъявленном или недостающем свойстве, причина в нарушении правил для типов API, а не в тесте.

- [ ] **Step 6: Commit**

```bash
./gradlew ktlintFormat
git add apps/server
git commit -m "feat(server): serve catalog and workspace documents"
```

---

### Task 6: Проверка эксперимента

**Files:**
- Create: `apps/server/src/main/kotlin/resiliencelab/server/lab/ValidationController.kt`
- Test: `apps/server/src/test/kotlin/resiliencelab/server/lab/ExperimentApiTest.kt`

- [ ] **Step 1: Написать падающий тест**

```kotlin
package resiliencelab.server.lab

import com.jayway.jsonpath.JsonPath
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.http.MediaType.APPLICATION_JSON
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post

@SpringBootTest
@AutoConfigureMockMvc
class ExperimentApiTest {
    @Autowired
    private lateinit var mockMvc: MockMvc

    private val experiment = "retry-storm/retry-storm.experiment.json"
    private val openApi by lazy {
        OpenApiConformance(mockMvc.perform(get("/v3/api-docs")).andReturn().response.getContentAsString(Charsets.UTF_8))
    }

    @Test
    fun `validates experiments by workspace path`() {
        val valid = postJson("/api/v1/validate", """{"experiment":"$experiment"}""")

        assertThat(valid.status).isEqualTo(200)
        assertThat(JsonPath.read<Boolean>(valid.contentAsString, "$.valid")).isTrue()
        assertThat(JsonPath.read<List<Any>>(valid.contentAsString, "$.diagnostics")).isEmpty()
        openApi.assertResponse("post", "/api/v1/validate", valid)

        val missing = postJson("/api/v1/validate", """{"experiment":"missing.experiment.json"}""")
        assertThat(JsonPath.read<Boolean>(missing.contentAsString, "$.valid")).isFalse()
        assertThat(JsonPath.read<String>(missing.contentAsString, "$.diagnostics[0].code")).isEqualTo("DOCUMENT_MISSING")
        openApi.assertResponse("post", "/api/v1/validate", missing)
    }

    private fun postJson(
        path: String,
        body: String,
    ): MockHttpServletResponse = mockMvc.perform(post(path).contentType(APPLICATION_JSON).content(body)).andReturn().response

    companion object {
        private val root = TestWorkspace.copy()

        @JvmStatic
        @DynamicPropertySource
        fun workspace(registry: DynamicPropertyRegistry) {
            registry.add("resilience-lab.workspace") { root.toString() }
        }
    }
}
```

- [ ] **Step 2: Тест падает**

Run: `./gradlew :apps:server:test --tests 'resiliencelab.server.lab.ExperimentApiTest'`
Expected: FAIL — `/api/v1/validate` отвечает 404.

- [ ] **Step 3: Реализация**

```kotlin
package resiliencelab.server.lab

import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RestController
import resiliencelab.core.lab.Lab

/** Diagnostics of an experiment of the workspace; missing documents are diagnostics too. */
@RestController
class ValidationController(
    private val lab: Lab,
) {
    @PostMapping("/api/v1/validate")
    fun validateExperiment(
        @RequestBody request: ExperimentRequest,
    ): ValidationView {
        val report = lab.validate(request.experiment)
        return ValidationView(report.experimentPath, report.valid, report.diagnostics)
    }
}
```

- [ ] **Step 4: Тест проходит**

Run: `./gradlew :apps:server:test --tests 'resiliencelab.server.lab.ExperimentApiTest'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
./gradlew ktlintFormat
git add apps/server
git commit -m "feat(server): validate workspace experiments"
```

---

### Task 7: Задания

**Files:**
- Modify: `apps/server/src/main/kotlin/resiliencelab/server/lab/JobService.kt` (заменить заготовку целиком)
- Create: `apps/server/src/main/kotlin/resiliencelab/server/lab/JobController.kt`
- Test: `apps/server/src/test/kotlin/resiliencelab/server/lab/JobServiceTest.kt`, дополнить `ExperimentApiTest.kt`

- [ ] **Step 1: Написать падающие тесты**

`JobServiceTest.kt`:

```kotlin
package resiliencelab.server.lab

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.lab.InvalidExperimentException
import resiliencelab.core.lab.Lab
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.Files
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException

class JobServiceTest {
    private val experiment = "retry-storm/retry-storm.experiment.json"
    private val root = TestWorkspace.copy()
    private val lab = Lab(FileWorkspace(root), executor = ExperimentExecutor(workers = 2))
    private var runs = 0

    private fun service(
        executor: Executor = Executor { it.run() },
        maxTerminalJobs: Int = 100,
    ) = JobService(lab, executor, maxTerminalJobs) { "run-${++runs}" }

    @Test
    fun `runs a job to completion and records progress`() {
        val job = service().submit(experiment)

        assertThat(job.status).isEqualTo(JobStatus.COMPLETED)
        assertThat(job.runId).isEqualTo("run-1")
        assertThat(job.completedTasks).isEqualTo(4)
        assertThat(job.totalTasks).isEqualTo(4)
        assertThat(root.resolve(".results/retry-storm/run-1/manifest.json")).exists()
    }

    @Test
    fun `rejects an invalid experiment before queueing`() {
        assertThatThrownBy { service().submit("missing.experiment.json") }
            .isInstanceOf(InvalidExperimentException::class.java)
    }

    @Test
    fun `reports an experiment that became invalid before its job ran`() {
        val queued = mutableListOf<Runnable>()
        val jobs = service(Executor { queued += it })
        val job = jobs.submit(experiment)
        assertThat(job.status).isEqualTo(JobStatus.QUEUED)

        Files.writeString(root.resolve("retry-storm/retry-storm.model.json"), "{")
        queued.single().run()

        val failed = jobs.get(job.id)!!
        assertThat(failed.status).isEqualTo(JobStatus.FAILED)
        assertThat(failed.error).isEqualTo("Experiment has errors")
        assertThat(failed.diagnostics.single().code).isEqualTo("JSON_SYNTAX")
    }

    @Test
    fun `reports execution failures without details`() {
        Files.writeString(root.resolve(".results"), "not a directory")

        val job = service().submit(experiment)

        assertThat(job.status).isEqualTo(JobStatus.FAILED)
        assertThat(job.error).isEqualTo("Experiment execution failed")
        assertThat(job.diagnostics).isEmpty()
    }

    @Test
    fun `reports a full queue`() {
        val job = service(Executor { throw RejectedExecutionException() }).submit(experiment)

        assertThat(job.status).isEqualTo(JobStatus.FAILED)
        assertThat(job.error).isEqualTo("Job queue is full")
    }

    @Test
    fun `keeps the newest finished jobs and lists newest first`() {
        val jobs = service(maxTerminalJobs = 2)
        val first = jobs.submit(experiment)
        val second = jobs.submit(experiment)
        val third = jobs.submit(experiment)

        assertThat(jobs.get(first.id)).isNull()
        assertThat(jobs.list().map { it.id }).containsExactly(third.id, second.id)
    }
}
```

В `ExperimentApiTest` добавить тесты и помощник ожидания (импорт `java.util.concurrent.TimeUnit.SECONDS`):

```kotlin
    @Test
    fun `runs a job to completion`() {
        val submitted = postJson("/api/v1/jobs", """{"experiment":"$experiment"}""")
        assertThat(submitted.status).isEqualTo(202)
        openApi.assertResponse("post", "/api/v1/jobs", submitted)

        val finished = awaitJob(JsonPath.read<String>(submitted.contentAsString, "$.id"))

        assertThat(JsonPath.read<String>(finished.contentAsString, "$.status")).isEqualTo("COMPLETED")
        assertThat(JsonPath.read<Int>(finished.contentAsString, "$.completedTasks")).isEqualTo(4)
        assertThat(JsonPath.read<Int>(finished.contentAsString, "$.totalTasks")).isEqualTo(4)
        openApi.assertResponse("get", "/api/v1/jobs/{id}", finished)

        val jobs = mockMvc.perform(get("/api/v1/jobs")).andReturn().response
        assertThat(JsonPath.read<List<String>>(jobs.contentAsString, "$[*].id"))
            .contains(JsonPath.read<String>(finished.contentAsString, "$.id"))
        openApi.assertResponse("get", "/api/v1/jobs", jobs)
    }

    @Test
    fun `rejects invalid jobs, malformed requests and unknown ids`() {
        val invalid = postJson("/api/v1/jobs", """{"experiment":"missing.experiment.json"}""")
        assertThat(invalid.status).isEqualTo(400)
        assertThat(JsonPath.read<String>(invalid.contentAsString, "$.code")).isEqualTo("EXPERIMENT_INVALID")
        assertThat(JsonPath.read<String>(invalid.contentAsString, "$.diagnostics[0].code")).isEqualTo("DOCUMENT_MISSING")
        openApi.assertResponse("post", "/api/v1/jobs", invalid)

        val malformed = postJson("/api/v1/jobs", "{}")
        assertThat(malformed.status).isEqualTo(400)
        assertThat(JsonPath.read<String>(malformed.contentAsString, "$.code")).isEqualTo("REQUEST_INVALID")

        val unknown = mockMvc.perform(get("/api/v1/jobs/{id}", "unknown")).andReturn().response
        assertThat(unknown.status).isEqualTo(404)
        assertThat(JsonPath.read<String>(unknown.contentAsString, "$.code")).isEqualTo("JOB_NOT_FOUND")
        openApi.assertResponse("get", "/api/v1/jobs/{id}", unknown)
    }

    private fun awaitJob(id: String): MockHttpServletResponse {
        val deadline = System.nanoTime() + SECONDS.toNanos(60)
        while (true) {
            val response = mockMvc.perform(get("/api/v1/jobs/{id}", id)).andReturn().response
            val status = JsonPath.read<String>(response.contentAsString, "$.status")
            if (status == "COMPLETED" || status == "FAILED") return response
            check(System.nanoTime() < deadline) { "Job $id did not finish: ${response.contentAsString}" }
            Thread.sleep(50)
        }
    }
```

- [ ] **Step 2: Тесты падают**

Run: `./gradlew :apps:server:test --tests 'resiliencelab.server.lab.JobServiceTest' --tests 'resiliencelab.server.lab.ExperimentApiTest'`
Expected: FAIL — у заготовки `JobService` нет `submit`, `get`, `list`.

- [ ] **Step 3: Реализация**

`JobService.kt` целиком:

```kotlin
package resiliencelab.server.lab

import org.slf4j.LoggerFactory
import resiliencelab.core.lab.InvalidExperimentException
import resiliencelab.core.lab.Lab
import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException

/**
 * Process-local jobs (ADR 0009, stage 1 slice): a job validates its experiment on submission and then runs it through
 * [Lab] on [executor]. At most [maxTerminalJobs] finished jobs are kept, oldest evicted first; active jobs stay.
 */
class JobService(
    private val lab: Lab,
    private val executor: Executor,
    private val maxTerminalJobs: Int = 100,
    private val newRunId: () -> String,
) {
    private val lock = Any()
    private val jobs = LinkedHashMap<String, JobView>()
    private val terminal = ArrayDeque<String>()

    init {
        require(maxTerminalJobs >= 1) { "maxTerminalJobs must be at least 1" }
    }

    /** Queues a run of [experiment]; throws [InvalidExperimentException] when the experiment has errors. */
    fun submit(experiment: String): JobView {
        val report = lab.validate(experiment)
        if (!report.valid) throw InvalidExperimentException(report.diagnostics)
        val job = JobView(UUID.randomUUID().toString(), experiment, newRunId(), JobStatus.QUEUED, 0, 0)
        synchronized(lock) { jobs[job.id] = job }
        try {
            executor.execute { execute(job.id) }
        } catch (exception: RejectedExecutionException) {
            finish(job.id) { it.copy(status = JobStatus.FAILED, error = "Job queue is full") }
        }
        return get(job.id) ?: job
    }

    fun get(id: String): JobView? = synchronized(lock) { jobs[id] }

    /** Jobs, newest first. */
    fun list(): List<JobView> = synchronized(lock) { jobs.values.reversed() }

    private fun execute(id: String) {
        val job = update(id) { it.copy(status = JobStatus.RUNNING) } ?: return
        try {
            lab.run(job.experiment, job.runId) { completed, total ->
                update(id) { it.copy(completedTasks = maxOf(it.completedTasks, completed), totalTasks = total) }
            }
            finish(id) { it.copy(status = JobStatus.COMPLETED) }
        } catch (exception: InvalidExperimentException) {
            finish(id) { it.copy(status = JobStatus.FAILED, error = "Experiment has errors", diagnostics = exception.diagnostics) }
        } catch (exception: Exception) {
            logger.error("Job {} failed", id, exception)
            finish(id) { it.copy(status = JobStatus.FAILED, error = "Experiment execution failed") }
        }
    }

    private fun update(
        id: String,
        change: (JobView) -> JobView,
    ): JobView? = synchronized(lock) { jobs[id]?.let(change)?.also { jobs[id] = it } }

    private fun finish(
        id: String,
        change: (JobView) -> JobView,
    ) {
        synchronized(lock) {
            update(id, change) ?: return
            terminal.addLast(id)
            while (terminal.size > maxTerminalJobs) jobs.remove(terminal.removeFirst())
        }
    }

    private companion object {
        val logger = LoggerFactory.getLogger(JobService::class.java)
    }
}
```

`JobController.kt`:

```kotlin
package resiliencelab.server.lab

import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

/** Jobs: the UI polls `GET /jobs/{id}` (ADR 0010, item 4). */
@RestController
@RequestMapping("/api/v1/jobs")
class JobController(
    private val jobs: JobService,
) {
    @PostMapping
    @ResponseStatus(HttpStatus.ACCEPTED)
    fun submitJob(
        @RequestBody request: ExperimentRequest,
    ): JobView = jobs.submit(request.experiment)

    @GetMapping
    fun listJobs(): List<JobView> = jobs.list()

    @GetMapping("/{id}")
    fun getJob(
        @PathVariable id: String,
    ): JobView = jobs.get(id) ?: throw NotFound("JOB_NOT_FOUND", "Job '$id' does not exist")
}
```

- [ ] **Step 4: Тесты проходят**

Run: `./gradlew :apps:server:test --tests 'resiliencelab.server.lab.JobServiceTest' --tests 'resiliencelab.server.lab.ExperimentApiTest'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
./gradlew ktlintFormat
git add apps/server
git commit -m "feat(server): run experiments as process-local jobs"
```

---

### Task 8: Прогоны

**Files:**
- Create: `apps/server/src/main/kotlin/resiliencelab/server/lab/RunController.kt`
- Modify: `apps/server/src/test/kotlin/resiliencelab/server/lab/ExperimentApiTest.kt`

- [ ] **Step 1: Добавить падающий тест в `ExperimentApiTest`**

```kotlin
    @Test
    fun `serves finished runs`() {
        val submitted = postJson("/api/v1/jobs", """{"experiment":"$experiment"}""")
        val finished = awaitJob(JsonPath.read<String>(submitted.contentAsString, "$.id"))
        val runId = JsonPath.read<String>(finished.contentAsString, "$.runId")

        val runs = mockMvc.perform(get("/api/v1/runs")).andReturn().response
        assertThat(JsonPath.read<List<String>>(runs.contentAsString, "$[*].id")).contains(runId)
        openApi.assertResponse("get", "/api/v1/runs", runs)

        val summary = mockMvc.perform(get("/api/v1/runs/{id}/summary", runId)).andReturn().response
        assertThat(summary.status).isEqualTo(200)
        assertThat(JsonPath.read<List<String>>(summary.contentAsString, "$.variants[*].id")).containsExactly("baseline", "no-retries")
        openApi.assertResponse("get", "/api/v1/runs/{id}/summary", summary)

        val manifest = mockMvc.perform(get("/api/v1/runs/{id}/manifest", runId)).andReturn().response
        assertThat(JsonPath.read<String>(manifest.contentAsString, "$.experiment")).isEqualTo(experiment)
        assertThat(JsonPath.read<Map<String, String>>(manifest.contentAsString, "$.documents"))
            .containsOnlyKeys(experiment, "retry-storm/retry-storm.model.json")
        openApi.assertResponse("get", "/api/v1/runs/{id}/manifest", manifest)

        val missing = mockMvc.perform(get("/api/v1/runs/{id}/summary", "missing")).andReturn().response
        assertThat(missing.status).isEqualTo(404)
        assertThat(JsonPath.read<String>(missing.contentAsString, "$.code")).isEqualTo("RUN_NOT_FOUND")
    }
```

- [ ] **Step 2: Тест падает**

Run: `./gradlew :apps:server:test --tests 'resiliencelab.server.lab.ExperimentApiTest'`
Expected: FAIL — `/api/v1/runs` отвечает 404.

- [ ] **Step 3: Реализация**

```kotlin
package resiliencelab.server.lab

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import resiliencelab.core.results.RunCatalog
import resiliencelab.core.results.RunEntry
import resiliencelab.core.results.RunManifest
import resiliencelab.core.results.RunSummary

/** Finished runs from `.results/` (ADR 0008); they outlive server restarts, jobs do not. */
@RestController
@RequestMapping("/api/v1/runs")
class RunController(
    private val runs: RunCatalog,
) {
    @GetMapping
    fun listRuns(): List<RunEntry> = runs.list()

    @GetMapping("/{id}/manifest")
    fun getRunManifest(
        @PathVariable id: String,
    ): RunManifest = runs.manifest(id) ?: throw notFound(id)

    @GetMapping("/{id}/summary")
    fun getRunSummary(
        @PathVariable id: String,
    ): RunSummary = runs.summary(id) ?: throw notFound(id)

    private fun notFound(id: String) = NotFound("RUN_NOT_FOUND", "Run '$id' does not exist")
}
```

- [ ] **Step 4: Тест проходит**

Run: `./gradlew :apps:server:test --tests 'resiliencelab.server.lab.ExperimentApiTest'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
./gradlew ktlintFormat
git add apps/server
git commit -m "feat(server): serve finished runs"
```

---

### Task 9: Спецификация OpenAPI в репозитории

**Files:**
- Create: `apps/server/openapi.json` (генерируется)
- Test: `apps/server/src/test/kotlin/resiliencelab/server/lab/OpenApiSpecTest.kt`

- [ ] **Step 1: Написать тест**

```kotlin
package resiliencelab.server.lab

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import java.nio.file.Files
import java.nio.file.Path

/**
 * The committed `apps/server/openapi.json` must equal the document generated from the code (ADR 0010, item 2).
 * Regenerate with `UPDATE_OPENAPI=1 ./gradlew :apps:server:test --tests 'resiliencelab.server.lab.OpenApiSpecTest' --rerun`.
 */
@SpringBootTest
@AutoConfigureMockMvc
class OpenApiSpecTest {
    @Autowired
    private lateinit var mockMvc: MockMvc

    private val file = Path.of("openapi.json")

    private fun generated(): String =
        mockMvc
            .perform(get("/v3/api-docs"))
            .andReturn()
            .response
            .getContentAsString(Charsets.UTF_8)
            .replace("\r\n", "\n") + "\n"

    @Test
    fun `committed OpenAPI document matches the code`() {
        val generated = generated()
        if (System.getenv("UPDATE_OPENAPI") == "1") Files.writeString(file, generated)

        assertThat(file).exists()
        assertThat(Files.readString(file)).describedAs("apps/server/openapi.json is stale; regenerate it").isEqualTo(generated)
    }

    @Test
    fun `document covers exactly the stage 1 API`() {
        val document = Json.parseToJsonElement(generated()).jsonObject
        val schemas = document.getValue("components").jsonObject.getValue("schemas").jsonObject

        assertThat(document.getValue("paths").jsonObject.keys).containsExactlyInAnyOrder(
            "/api/v1/catalog",
            "/api/v1/health",
            "/api/v1/jobs",
            "/api/v1/jobs/{id}",
            "/api/v1/runs",
            "/api/v1/runs/{id}/manifest",
            "/api/v1/runs/{id}/summary",
            "/api/v1/validate",
            "/api/v1/workspace/document",
            "/api/v1/workspace/documents",
        )
        assertThat(schemas.keys).contains("ApiProblem", "BlockInstance", "JobView", "RunSummary").doesNotContain("ApiError")
        val params = schemas.getValue("BlockInstance").jsonObject.getValue("properties").jsonObject.getValue("params").jsonObject
        assertThat(params.getValue("additionalProperties").toString()).isEqualTo("true")
    }
}
```

- [ ] **Step 2: Сгенерировать файл и посмотреть его**

Run: `UPDATE_OPENAPI=1 ./gradlew :apps:server:test --tests 'resiliencelab.server.lab.OpenApiSpecTest' --rerun`
Expected: PASS; появился `apps/server/openapi.json`. Просмотреть: у каждой операции есть ответ 200 или 202 и ответы-ошибки `ApiProblem`, у `PUT /api/v1/workspace/document` — параметр `path` и заголовок `If-Match`, имена `operationId` без суффиксов `_1`.

- [ ] **Step 3: Проверка без переменной**

Run: `./gradlew :apps:server:test --tests 'resiliencelab.server.lab.OpenApiSpecTest' --rerun`
Expected: PASS. Повторный запуск с `UPDATE_OPENAPI=1` не меняет файл: `git diff --exit-code apps/server/openapi.json` после него пуст.

- [ ] **Step 4: Commit**

```bash
./gradlew ktlintFormat
git add apps/server/openapi.json apps/server/src/test/kotlin/resiliencelab/server/lab/OpenApiSpecTest.kt
git commit -m "feat(server): commit generated OpenAPI document"
```

---

### Task 10: CLI на документах рабочей области

Старый CLI и его тесты заменяются целиком. Файл `examples/retry-storm.json` нужен только им и удаляется.

**Files:**
- Modify: `apps/cli/src/main/kotlin/resiliencelab/cli/Main.kt` (заменить целиком), `apps/cli/build.gradle.kts`
- Modify: `apps/cli/src/test/kotlin/resiliencelab/cli/CliTest.kt` (заменить целиком)
- Delete: `examples/retry-storm.json`

- [ ] **Step 1: Написать падающий тест — `CliTest.kt` целиком**

```kotlin
package resiliencelab.cli

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.io.path.writeText
import kotlin.test.Test

class CliTest {
    @TempDir
    lateinit var workspace: Path

    private val experiment = "retry-storm/retry-storm.experiment.json"
    private val model = "retry-storm/retry-storm.model.json"

    @BeforeEach
    fun copyExample() {
        val source = Path.of("examples")
        Files.walk(source.resolve("retry-storm")).use { paths ->
            paths.filter { Files.isRegularFile(it) }.forEach { file ->
                val destination = workspace.resolve(source.relativize(file).toString())
                Files.createDirectories(destination.parent)
                Files.copy(file, destination)
            }
        }
    }

    @Test
    fun `usage errors return 2 without output on stdout`() {
        listOf(
            emptyList(),
            listOf("unknown", experiment),
            listOf("validate"),
            listOf("run"),
            listOf("run", experiment, "extra"),
            listOf("run", "--workers", "0", experiment),
            listOf("run", "--workers", "many", experiment),
            listOf("validate", "--workers", "2", experiment),
            listOf("sweep", "sweep.json"),
        ).forEach { args ->
            val result = execute(args)

            assertThat(result.exitCode).describedAs(args.toString()).isEqualTo(2)
            assertThat(result.stdout).describedAs(args.toString()).isEmpty()
            assertThat(result.stderr).describedAs(args.toString()).contains("Usage:")
        }
    }

    @Test
    fun `validate accepts the example`() {
        val result = execute(listOf("validate", experiment))

        assertThat(result.exitCode).isZero()
        assertThat(result.stdout).isEmpty()
        assertThat(result.stderr).contains("Valid experiment: $experiment")
    }

    @Test
    fun `validate accepts an absolute path inside the workspace`() {
        assertThat(execute(listOf("validate", workspace.resolve(experiment).toString())).exitCode).isZero()
    }

    @Test
    fun `validate reports diagnostics with document and pointer`() {
        breakModel()

        val result = execute(listOf("validate", experiment))

        assertThat(result.exitCode).isEqualTo(2)
        assertThat(result.stdout).isEmpty()
        assertThat(result.stderr).contains("$model#/blocks/dependency/params/handlers: PARAM_MISSING: ")
        assertThat(result.stderr).doesNotContain("\tat ")
    }

    @Test
    fun `malformed, missing and outside documents return 2`() {
        workspace.resolve(experiment).writeText("{ not JSON")
        assertThat(execute(listOf("validate", experiment)).stderr).contains("JSON_SYNTAX")

        val missing = execute(listOf("validate", "missing.experiment.json"))
        assertThat(missing.exitCode).isEqualTo(2)
        assertThat(missing.stderr).contains("DOCUMENT_MISSING")

        val outside = execute(listOf("validate", "../outside.experiment.json"))
        assertThat(outside.exitCode).isEqualTo(2)
        assertThat(outside.stderr).contains("Invalid input: experiment must be inside the workspace")
    }

    @Test
    fun `run writes the artifact and prints the run directory with a summary`() {
        val result = execute(listOf("run", experiment))

        assertThat(result.exitCode).describedAs(result.stderr).isZero()
        val lines = result.stdout.lines().filter { it.isNotBlank() }
        assertThat(lines).hasSize(3)
        assertThat(lines[0]).isEqualTo(".results/retry-storm/run-1")
        assertThat(lines[1]).startsWith("baseline: success ").contains("p95 ", "p99 ")
        assertThat(lines[2]).startsWith("no-retries: success ")
        assertThat(workspace.resolve(".results/retry-storm/run-1/manifest.json")).exists()
        assertThat(result.stderr).contains("Tasks 4/4")
    }

    @Test
    fun `worker count does not change the result`() {
        execute(listOf("run", experiment))
        val first = workspace.resolve(".results/retry-storm/run-1/summary.json").readText()

        val result = execute(listOf("run", "--workers", "1", experiment))

        assertThat(result.exitCode).isZero()
        assertThat(workspace.resolve(".results/retry-storm/run-1/summary.json").readText()).isEqualTo(first)
    }

    @Test
    fun `run reports an invalid experiment without writing results`() {
        breakModel()

        val result = execute(listOf("run", experiment))

        assertThat(result.exitCode).isEqualTo(2)
        assertThat(result.stdout).isEmpty()
        assertThat(result.stderr).contains("PARAM_MISSING")
        assertThat(workspace.resolve(".results")).doesNotExist()
    }

    @Test
    fun `execution failures return 1 with a sanitized message`() {
        val result = execute(listOf("run", experiment)) { _, _, _, _ -> throw IllegalStateException("boom\n\tat somewhere") }

        assertThat(result.exitCode).isEqualTo(1)
        assertThat(result.stdout).isEmpty()
        assertThat(result.stderr).contains("Execution failed: boom").doesNotContain("\tat ")
    }

    @Test
    fun `unreadable documents are diagnostics, not crashes`() {
        Files.write(workspace.resolve(model), byteArrayOf(0x7b, 0xC3.toByte(), 0x28, 0x7d))

        val result = execute(listOf("validate", experiment))

        assertThat(result.exitCode).isEqualTo(2)
        assertThat(result.stderr).contains("DOCUMENT_UNREADABLE").doesNotContain("\tat ")
    }

    @Test
    fun `installed launcher prints only the run directory and summary on stdout`() {
        val result = launch(listOf("run", experiment))

        assertThat(result.exitCode).describedAs(result.stderr).isZero()
        val lines = result.stdout.lines().filter { it.isNotBlank() }
        assertThat(lines).hasSize(3)
        assertThat(lines[0]).matches("""\.results/retry-storm/\d{8}-\d{6}-\d{3}-[0-9a-f]{4}""")
        assertThat(workspace.resolve(lines[0]).resolve("manifest.json")).exists()
    }

    @Test
    fun `installed launcher reports invalid input with code 2 and no stack trace`() {
        Files.write(workspace.resolve(model), byteArrayOf(0x7b, 0xC3.toByte(), 0x28, 0x7d))

        val result = launch(listOf("validate", experiment))

        assertThat(result.exitCode).isEqualTo(2)
        assertThat(result.stdout).isEmpty()
        assertThat(result.stderr).contains("DOCUMENT_UNREADABLE").doesNotContain("\tat ")
    }

    /** Runs the launcher from `installDist` as a separate process in the workspace. */
    private fun launch(args: List<String>): CommandResult {
        val launcherDirectory = Path.of("apps", "cli", "build", "install", "cli", "bin").toAbsolutePath()
        val command =
            if (System.getProperty("os.name").startsWith("Windows", ignoreCase = true)) {
                listOf("cmd.exe", "/c", launcherDirectory.resolve("cli.bat").toString())
            } else {
                listOf(launcherDirectory.resolve("cli").toString())
            }
        val errorFile = Files.createTempFile("cli-stderr", ".log")
        val process =
            ProcessBuilder(command + args)
                .directory(workspace.toFile())
                .redirectError(errorFile.toFile())
                .start()
        val stdout = process.inputStream.readBytes().decodeToString()
        val exitCode = process.waitFor()
        return CommandResult(exitCode, stdout, errorFile.readText())
    }

    private fun breakModel() {
        val file = workspace.resolve(model)
        file.writeText(file.readText().replace("\"handlers\": 2,", ""))
    }

    private fun execute(
        args: List<String>,
        run: ExperimentRun? = null,
    ): CommandResult {
        val stdout = StringBuilder()
        val stderr = StringBuilder()
        val exitCode =
            if (run == null) {
                runCommand(args, stdout, stderr, workspace, newRunId = { "run-1" })
            } else {
                runCommand(args, stdout, stderr, workspace, newRunId = { "run-1" }, execute = run)
            }
        return CommandResult(exitCode, stdout.toString(), stderr.toString())
    }

    private data class CommandResult(
        val exitCode: Int,
        val stdout: String,
        val stderr: String,
    )
}
```

- [ ] **Step 2: Тест падает**

Run: `./gradlew :apps:cli:test`
Expected: FAIL — нет `ExperimentRun` и параметров `workspaceRoot`, `newRunId`, `execute`.

- [ ] **Step 3: Реализация — `Main.kt` целиком**

```kotlin
package resiliencelab.cli

import resiliencelab.core.compiler.Diagnostic
import resiliencelab.core.execution.ExperimentExecutor
import resiliencelab.core.experiment.MetricSummary
import resiliencelab.core.lab.InvalidExperimentException
import resiliencelab.core.lab.Lab
import resiliencelab.core.lab.RunIds
import resiliencelab.core.lab.RunOutcome
import resiliencelab.core.workspace.FileWorkspace
import java.nio.file.InvalidPathException
import java.nio.file.Path
import java.util.Locale
import kotlin.system.exitProcess

private const val USAGE = "Usage: validate <experiment.json> | run [--workers N] <experiment.json>"

/** Runs one command against the current directory as the workspace and exits with its status. */
fun main(args: Array<String>) {
    exitProcess(runCommand(args.asList(), System.out, System.err))
}

/** Runs an experiment through [Lab]: the CLI counterpart of `POST /jobs`. */
internal typealias ExperimentRun = (lab: Lab, experiment: String, runId: String, onProgress: (Int, Int) -> Unit) -> RunOutcome

/**
 * Validates or runs an experiment of the workspace at [workspaceRoot] (stage 1 design §5.3). Returns 0 on success,
 * 2 for usage errors and invalid experiments, 1 for execution failures. `run` writes the artifact to `.results/`,
 * progress to [stderr], and the run directory followed by one summary line per variant to [stdout].
 */
internal fun runCommand(
    args: List<String>,
    stdout: Appendable,
    stderr: Appendable,
    workspaceRoot: Path = Path.of("").toAbsolutePath(),
    newRunId: () -> String = { RunIds.next() },
    execute: ExperimentRun = { lab, experiment, runId, onProgress -> lab.run(experiment, runId, onProgress) },
): Int {
    val command = Command.parse(args) ?: return usage(stderr)
    val root = workspaceRoot.toAbsolutePath().normalize()
    val experiment =
        relativePath(root, command.experiment)
            ?: return inputError(stderr, "experiment must be inside the workspace $root: ${command.experiment}")
    val executor = command.workers?.let { ExperimentExecutor(it) } ?: ExperimentExecutor()
    val lab = Lab(FileWorkspace(root), executor = executor)
    return if (command.run) {
        run(lab, experiment, newRunId(), stdout, stderr, execute)
    } else {
        validate(lab, experiment, stderr)
    }
}

private class Command(
    val run: Boolean,
    val experiment: String,
    val workers: Int?,
) {
    companion object {
        fun parse(args: List<String>): Command? =
            when {
                args.size == 2 && args[0] == "validate" -> Command(run = false, experiment = args[1], workers = null)
                args.size == 2 && args[0] == "run" -> Command(run = true, experiment = args[1], workers = null)
                args.size == 4 && args[0] == "run" && args[1] == "--workers" ->
                    args[2].toIntOrNull()?.takeIf { it >= 1 }?.let { Command(run = true, experiment = args[3], workers = it) }
                else -> null
            }
    }
}

private fun validate(
    lab: Lab,
    experiment: String,
    stderr: Appendable,
): Int {
    val report = lab.validate(experiment)
    if (!report.valid) return validationError(stderr, report.diagnostics)
    stderr.appendLine("Valid experiment: $experiment")
    return 0
}

private fun run(
    lab: Lab,
    experiment: String,
    runId: String,
    stdout: Appendable,
    stderr: Appendable,
    execute: ExperimentRun,
): Int {
    val outcome =
        try {
            execute(lab, experiment, runId) { completed, total ->
                synchronized(stderr) { stderr.appendLine("Tasks $completed/$total") }
            }
        } catch (error: InvalidExperimentException) {
            return validationError(stderr, error.diagnostics)
        } catch (error: Exception) {
            stderr.appendLine("Execution failed: ${firstLine(error)}")
            return 1
        }
    stdout.appendLine(outcome.runDirectory)
    outcome.summary.variants.forEach { variant ->
        val aggregate = variant.aggregate
        stdout.appendLine(
            "${variant.id}: success ${percent(aggregate.successRate)}, " +
                "p95 ${millis(aggregate.p95LatencyMs)}, p99 ${millis(aggregate.p99LatencyMs)}",
        )
    }
    return 0
}

private fun relativePath(
    root: Path,
    argument: String,
): String? {
    val resolved =
        try {
            root.resolve(argument).normalize()
        } catch (exception: InvalidPathException) {
            return null
        }
    if (!resolved.startsWith(root) || resolved == root) return null
    return root.relativize(resolved).joinToString("/")
}

private fun usage(stderr: Appendable): Int {
    stderr.appendLine(USAGE)
    return 2
}

private fun inputError(
    stderr: Appendable,
    message: String,
): Int {
    stderr.appendLine("Invalid input: $message")
    return 2
}

private fun validationError(
    stderr: Appendable,
    diagnostics: List<Diagnostic>,
): Int {
    stderr.appendLine("Validation failed:")
    diagnostics.forEach { stderr.appendLine("- ${location(it)}: ${it.code}: ${it.message}") }
    return 2
}

private fun location(diagnostic: Diagnostic): String =
    listOfNotNull(diagnostic.document, diagnostic.pointer).joinToString("#").ifEmpty { "experiment" }

private fun percent(summary: MetricSummary?): String =
    summary?.let { String.format(Locale.ROOT, "%.1f%%", it.mean * 100) } ?: "n/a"

private fun millis(summary: MetricSummary?): String = summary?.let { String.format(Locale.ROOT, "%.1f ms", it.mean) } ?: "n/a"

private fun firstLine(error: Throwable): String =
    error.message
        ?.lineSequence()
        ?.firstOrNull()
        ?.takeIf { it.isNotBlank() }
        ?: error.javaClass.simpleName
```

В `apps/cli/build.gradle.kts` удалить строку `implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")`: CLI больше не работает с JSON напрямую.

Удалить старый пример:

```bash
git rm examples/retry-storm.json
```

- [ ] **Step 4: Тест проходит**

Run: `./gradlew :apps:cli:test`
Expected: PASS (задача сама собирает `installDist`).

- [ ] **Step 5: Commit**

```bash
./gradlew ktlintFormat
git add apps/cli examples
git commit -m "feat(cli): validate and run workspace experiments"
```

---

### Task 11: Образ Docker

**Files:**
- Modify: `apps/server/Dockerfile`

- [ ] **Step 1: Рабочая область в образе**

В `apps/server/Dockerfile` заменить строку

```dockerfile
COPY --from=build /app/apps/server/build/libs/server.jar /app/server.jar
```

на

```dockerfile
COPY --from=build /app/apps/server/build/libs/server.jar /app/server.jar
COPY --from=build --chown=app:app /app/examples /workspace
ENV RESILIENCE_LAB_WORKSPACE=/workspace
```

Пользователь контейнера на Linux не сможет писать в подключённый каталог хоста с чужим владельцем, поэтому срез копирует `examples/` в образ; подключение каталога хоста — дорожка T2.

- [ ] **Step 2: Проверка**

```bash
docker compose up --build -d
for i in $(seq 1 60); do curl -fsS http://127.0.0.1:8080/api/v1/health >/dev/null && break; sleep 2; done
curl -fsS http://127.0.0.1:8080/api/v1/catalog | head -c 120; echo
job=$(curl -fsS -X POST -H 'Content-Type: application/json' -d '{"experiment":"retry-storm/retry-storm.experiment.json"}' http://127.0.0.1:5173/api/v1/jobs | sed -E 's/.*"id":"([^"]+)".*/\1/')
for i in $(seq 1 60); do status=$(curl -fsS "http://127.0.0.1:5173/api/v1/jobs/$job" | sed -E 's/.*"status":"([A-Z]+)".*/\1/'); [ "$status" = COMPLETED ] || [ "$status" = FAILED ] && break; sleep 2; done; echo "$status"
curl -fsS http://127.0.0.1:5173/api/v1/runs; echo
docker compose down
```

Expected: сервер отвечает на `/health` в пределах двух минут; каталог начинается с `{"schemaVersion":1,"types":[`; задание доходит до `COMPLETED`; список прогонов не пуст. Если Docker недоступен, написать об этом в PR.

- [ ] **Step 3: Commit**

```bash
git add apps/server/Dockerfile
git commit -m "build(server): bake example workspace into the image"
```

---

### Task 12: Документация

**Files:**
- Modify: `AGENTS.md`, `README.md`

- [ ] **Step 1: `AGENTS.md`, раздел «Текущее состояние»**

Заменить три строки модулей:

```markdown
- `core` — модель сценариев, валидация, KSL-симуляция, повторения, parameter sweep и агрегация метрик.
- `apps:cli` — команды `validate`, `run` и `sweep`, собираемые с помощью Gradle `application`.
- `apps:server` — Spring Boot API для health, валидации сценариев, асинхронных заданий экспериментов и их результатов; задания хранятся process-local.
```

на:

```markdown
- `core` — фундамент этапа 1: каталог типов, документы рабочей области, компилятор в IR, KSL-симуляция с потоками по путям блоков, исполнение задач, артефакты прогонов и фасад `Lab`; модель сценариев MVP со sweep остаётся до перехода web.
- `apps:cli` — команды `validate` и `run [--workers N]` для экспериментов рабочей области, собираемые с помощью Gradle `application`.
- `apps:server` — Spring Boot API этапа 1 (каталог, документы рабочей области, проверка, задания, прогоны) со спецификацией `apps/server/openapi.json` и ручки MVP для нынешнего web; задания хранятся process-local.
```

- [ ] **Step 2: `AGENTS.md`, команды**

После строки `` - `./gradlew :apps:server:test` — тесты модуля `apps:server`. `` добавить:

```markdown
- `UPDATE_OPENAPI=1 ./gradlew :apps:server:test --tests 'resiliencelab.server.lab.OpenApiSpecTest' --rerun` — пересоздать `apps/server/openapi.json` после изменения API; без переменной тест проверяет, что файл совпадает с кодом.
```

- [ ] **Step 3: `AGENTS.md`, Docker Compose**

После строки `- Задания остаются process-local: ...` добавить:

```markdown
- Backend работает с копией `examples/` внутри образа (`/workspace`): изменения документов и результаты прогонов пропадают вместе с контейнером.
```

- [ ] **Step 4: `AGENTS.md`, Backend API**

Заменить абзац раздела «Backend API» на:

```markdown
Backend использует Spring Boot 4.1.2 и JDK 25. `./gradlew :apps:server:bootRun` запускает локальный API с базовым URL `http://127.0.0.1:8080/api/v1` и рабочей областью `examples/`; другой каталог задаётся переменной `RESILIENCE_LAB_WORKSPACE` или аргументом `--args='--resilience-lab.workspace=<каталог>'`. Прогоны записываются в `<рабочая область>/.results/`, этот каталог не попадает в git. Спецификацию `apps/server/openapi.json` генерирует springdoc. `./gradlew :apps:server:test` запускает тесты backend. Задания хранятся только в памяти процесса (process-local) и не сохраняются между перезапусками; хранятся не более 100 завершённых заданий в порядке завершения FIFO, активные задания никогда не вытесняются. Результаты прогонов этапа 1 остаются в `.results/`.
```

- [ ] **Step 5: `AGENTS.md`, CLI**

Заменить раздел «CLI» от заголовка до абзаца про машинное потребление включительно на:

```markdown
### CLI

- `./gradlew :apps:cli:run --args="validate examples/retry-storm/retry-storm.experiment.json"` — проверить пример эксперимента.
- `./gradlew :apps:cli:run --args="run examples/retry-storm/retry-storm.experiment.json"` — выполнить пример; `--workers N` перед путём ограничивает число потоков расчёта.
- `./gradlew :apps:cli:installDist` — собрать установленный launcher в `apps/cli/build/install/cli/bin/` (`cli` для Linux/macOS, `cli.bat` для Windows).

Рабочая область CLI — текущий каталог; путь к эксперименту должен вести внутрь неё. `run` записывает артефакт в `.results/<эксперимент>/<прогон>/` и печатает в stdout каталог прогона и по строке сводки на вариант; ход выполнения и диагностика идут в stderr, `validate` печатает результат в stderr. Код выхода 2 означает ошибку использования или проверки, 1 — сбой расчёта. Запуск через Gradle добавляет в вывод служебные сообщения; для разбора stdout запускайте установленный launcher.
```

- [ ] **Step 6: `AGENTS.md`, соглашения по коду**

В конец раздела «Соглашения по коду» добавить:

```markdown
- Типы API сервера — `@Serializable` data-классы и enum без `@SerialName`, `@Transient`, собственных сериализаторов и полиморфизма; ответы содержат все поля, отсутствующее значение — `null`; имена методов контроллеров уникальны. Схему OpenAPI springdoc строит по свойствам Kotlin, JSON пишет kotlinx, и тест `OpenApiConformance` сверяет ответы со схемой.
```

- [ ] **Step 7: `README.md`, «Пример CLI»**

Заменить блок команд и абзац под ним на:

````markdown
```sh
./gradlew :apps:cli:installDist
apps/cli/build/install/cli/bin/cli validate examples/retry-storm/retry-storm.experiment.json
apps/cli/build/install/cli/bin/cli run examples/retry-storm/retry-storm.experiment.json
```

[Пример retry storm](examples/retry-storm/) сравнивает три попытки на вызовах
с одной при замедлении конечного сервиса. `validate` проверяет модель и
эксперимент; `run` записывает результат в `.results/retry-storm/<прогон>/`
и печатает путь к нему и краткую сводку по вариантам. Ход расчёта и
диагностика идут в stderr.
````

- [ ] **Step 8: Проверка ссылок и Commit**

Run: `grep -rn "retry-storm.json\|sweep <sweep.json>" AGENTS.md README.md`
Expected: пусто.

```bash
git add AGENTS.md README.md
git commit -m "docs: describe stage 1 API and CLI"
```

---

### Task 13: Полная проверка

- [ ] **Step 1: JVM**

Run: `./gradlew clean build`
Expected: BUILD SUCCESSFUL — тесты, KtLint, отчёты JaCoCo всех модулей, актуальный `openapi.json`.

- [ ] **Step 2: Web и E2E на старых ручках**

Run (из `web`): `npm ci && npm run lint && npm test -- --run && npm run build && npm run test:e2e`
Expected: всё проходит — web и E2E пользуются ручками MVP, которые остались; `bootRun` стартует из корня с рабочей областью `examples/`.

- [ ] **Step 3: Просмотр диффа**

Run: `git diff --check origin/main && git diff --stat origin/main`
Expected: изменения в `core/`, `apps/`, `examples/`, `AGENTS.md`, `README.md`, `.dockerignore`; каталога `.results/` в индексе нет.

- [ ] **Step 4: PR**

Открыть PR в `main` по правилам `AGENTS.md` (раздел «Работа по issue») с `Closes #<issue сервера и CLI>`.
