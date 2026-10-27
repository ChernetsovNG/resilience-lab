# Срез этапа 1: удаление MVP — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Удалить ручки и код MVP, перенести смысловые тесты MVP на IR и потоки по путям блоков, переименовать пакет движка `simulation` в `engine.ksl`.

**Architecture:** После планов 1–3 web, CLI и сервер работают только через `Lab`, а код MVP держат лишь ручки MVP и тесты, которые строят модель через старый конструктор `ReliabilityModel`. План сначала удаляет ручки, затем переименовывает пакет движка, переносит тесты на тестовый помощник `TestChains` и только потом удаляет сценарии MVP, адаптер и устаревшие перегрузки. Семантика движка не меняется: тесты считают ожидаемые случайные величины по тем же потокам, что и движок.

**Tech Stack:** Kotlin 2.4.21, JDK 25, KSLCore R1.8.1, Spring Boot 4.1.2, JUnit 5 + AssertJ.

---

## Источники

- Дизайн этапа 1: `docs/superpowers/specs/2026-10-27-stage-1-design.md` — §4.1 (пакеты), §4.2 (потоки, `SeedFactory` удаляется), §7.1 («Удаление MVP»), §8 (перенесённые смысловые тесты: M/M/1, повторы, orphaned work, когорта).
- ADR 0006 (потоки по путям), ADR 0010 (старые ручки удаляются).
- План 1 — `docs/superpowers/plans/2026-10-27-stage-1-slice-core.md`: `ChainIr`, `PathStreams`, `StreamPlan`, `PathStreamSource`, `ExperimentExecutor`, `LegacyScenarioAdapter`.

## Предусловие

Планы 1–3 смержены в `main`: web не обращается к `/api/v1/experiments` и `/api/v1/scenarios/validate`, CLI работает через `Lab`, `examples/retry-storm.json` удалён.

## Границы плана

- **Входит:** удаление ручек MVP на сервере, пакета `scenario`, `ExperimentRunner`, `SweepExpander`, `ReplicationResultStore`, `ExperimentResult`, `VariantResult`, `SeedFactory`, `LegacyScenarioAdapter`, старого конструктора `ReliabilityModel` и перегрузок со старыми типами; перенос смысловых тестов; переименование пакета; имя варианта в сообщении о сбое расчёта.
- **Не входит:** изменения семантики движка, новые возможности, пометки о заменённых частях в проектном дизайне MVP (дорожка T5).
- **Остаётся:** пакет `experiment` с моделями метрик, `MetricsAggregator` и `TimeWeightedSeries`; зависимость `jackson-module-kotlin` в сервере — через неё springdoc видит nullability свойств Kotlin, без неё изменится `openapi.json`.

## Куда уходят тесты MVP

| Тест MVP | Что с ним |
|---|---|
| `simulation/DegradationRunoutTest`, `TimeoutRaceTest`, `RetryDeadlineTest`, `SingleServiceInvocationTest`, `ServiceMetricsIntegrationTest`, `TimingArithmeticTest`, `DurationSamplerTest`, `BoundedRequestQTest` | Переносятся на IR в пакете `engine.ksl`, число тестов в каждом файле не меняется |
| `simulation/SeedFactoryTest` | Удаляется вместе с `SeedFactory` |
| `experiment/ExperimentRunnerTest` | M/M/1, различие seed, общие поступления вариантов, потоки повторений и сбой по лимиту переносятся в `ExperimentExecutorTest`; детерминизм, метаданные результата и отказ от неверного документа уже покрыты тестами `ExperimentExecutorTest`, `LabTest`, `ModelCompilerTest` |
| `experiment/SweepExpanderTest` | Удаляется: сетка — дорожка T1 |
| `scenario/ScenarioCodecTest`, `ScenarioValidatorTest` | Удаляются; проверки документов нового формата покрывают `DocumentCodecTest` и `ModelCompilerTest` (см. Task 7, Step 1) |
| `apps/server` `api/*Test`, `experiment/ExperimentJobManagerTest` | Удаляются вместе с ручками MVP |

## Карта файлов

| Файл | Изменение |
|---|---|
| `apps/server/src/main/kotlin/resiliencelab/server/api/`, `.../experiment/` и их тесты | Удаляются |
| `core/src/main/kotlin/resiliencelab/core/simulation/` → `.../engine/ksl/` | Переименование пакета, тесты тоже |
| `core/src/test/kotlin/resiliencelab/core/engine/ksl/TestChains.kt` | Цепочки, модели и потоки для тестов движка |
| `core/src/test/kotlin/resiliencelab/core/engine/ksl/*Test.kt` | Перенос на IR |
| `core/src/main/kotlin/resiliencelab/core/execution/ExperimentExecutor.kt` | Имя варианта в сообщении о сбое |
| `core/src/main/kotlin/resiliencelab/core/engine/ksl/ExperimentExecutionException.kt` | Причина сбоя |
| `core/src/test/kotlin/resiliencelab/core/execution/ExperimentExecutorTest.kt` | Тесты из `ExperimentRunnerTest` |
| `core/src/main/kotlin/resiliencelab/core/scenario/`, `experiment/ExperimentRunner.kt`, `SweepExpander.kt`, `ReplicationResultStore.kt`, `engine/ksl/SeedFactory.kt`, `LegacyScenarioAdapter.kt` и их тесты | Удаляются |
| `core/.../experiment/ResultModels.kt`, `engine/ksl/ReliabilityModel.kt`, `ArrivalGenerator.kt`, `DurationSampler.kt`, `RetryPolicyEvaluator.kt` | Удаление старых типов, конструктора и перегрузок |
| `AGENTS.md` | Описание модулей без MVP |

---

### Task 1: Удалить ручки MVP на сервере

**Files:**
- Delete: `apps/server/src/main/kotlin/resiliencelab/server/api/`, `apps/server/src/main/kotlin/resiliencelab/server/experiment/`, `apps/server/src/test/kotlin/resiliencelab/server/api/`, `apps/server/src/test/kotlin/resiliencelab/server/experiment/`

- [ ] **Step 1: Убедиться, что новые пакеты не зависят от старых**

Run: `git grep -n -E "resiliencelab\.server\.(api|experiment)" -- apps web`
Expected: совпадения только внутри удаляемых каталогов.

Run: `git grep -n -E "/api/v1/(experiments|scenarios)" -- web apps/cli`
Expected: пусто — ни web, ни CLI старые ручки не вызывают.

- [ ] **Step 2: Удалить**

```bash
git rm -r apps/server/src/main/kotlin/resiliencelab/server/api apps/server/src/main/kotlin/resiliencelab/server/experiment
git rm -r apps/server/src/test/kotlin/resiliencelab/server/api apps/server/src/test/kotlin/resiliencelab/server/experiment
```

- [ ] **Step 3: Проверка**

Run: `./gradlew :apps:server:check`
Expected: BUILD SUCCESSFUL; `OpenApiSpecTest` проходит без изменений `apps/server/openapi.json` — springdoc и раньше описывал только пакет `lab`. Если не проходит порог покрытия JaCoCo, добавить тесты на непокрытые ветви пакета `lab`, а не снижать порог.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(server): remove MVP endpoints"
```

---

### Task 2: Переименовать пакет `simulation` в `engine.ksl`

Ссылки на KSL в импортах абсолютные (`ksl.simulation.Model`), поэтому сегмент `ksl` в имени пакета с ними не конфликтует.

**Files:**
- Move: `core/src/main/kotlin/resiliencelab/core/simulation/` → `core/src/main/kotlin/resiliencelab/core/engine/ksl/`
- Move: `core/src/test/kotlin/resiliencelab/core/simulation/` → `core/src/test/kotlin/resiliencelab/core/engine/ksl/`
- Modify: все `*.kt`, ссылающиеся на пакет

- [ ] **Step 1: Перенести каталоги**

```bash
mkdir -p core/src/main/kotlin/resiliencelab/core/engine core/src/test/kotlin/resiliencelab/core/engine
git mv core/src/main/kotlin/resiliencelab/core/simulation core/src/main/kotlin/resiliencelab/core/engine/ksl
git mv core/src/test/kotlin/resiliencelab/core/simulation core/src/test/kotlin/resiliencelab/core/engine/ksl
```

- [ ] **Step 2: Заменить имя пакета**

```bash
git grep -l 'resiliencelab\.core\.simulation' -- '*.kt' | xargs perl -pi -e 's/resiliencelab\.core\.simulation\b/resiliencelab.core.engine.ksl/g'
```

Run: `git grep -n 'core\.simulation' -- '*.kt' '*.kts'`
Expected: пусто.

- [ ] **Step 3: Проверка**

Run: `./gradlew ktlintFormat && ./gradlew clean build`
Expected: BUILD SUCCESSFUL — меняются только имена пакета и импорты.

- [ ] **Step 4: Commit**

```bash
git add -A core apps
git commit -m "refactor(core): rename simulation package to engine.ksl"
```

---

### Task 3: Тестовый помощник `TestChains`

**Files:**
- Create: `core/src/test/kotlin/resiliencelab/core/engine/ksl/TestChains.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/engine/ksl/TestChainsTest.kt`

- [ ] **Step 1: Написать падающий тест**

```kotlin
package resiliencelab.core.engine.ksl

import ksl.simulation.Model
import org.assertj.core.api.Assertions.assertThat
import kotlin.test.Test

class TestChainsTest {
    @Test
    fun `expected arrivals are exactly the arrivals the engine draws`() {
        val base = TestChains.simple()
        val chain =
            base.copy(
                client = base.client.copy(arrivalRatePerMs = 0.25),
                services = listOf(base.services.first().copy(processing = TestChains.fixed(0.0), queueCapacity = 1_000)),
                calls = emptyList(),
                run = TestChains.run(measurementMs = 100.0),
            )

        val result = TestChains.reliabilityModel(Model("TestChainsTest", autoCSVReports = false), chain).runReplication()

        assertThat(result.arrivalTimesMs).isNotEmpty()
        assertThat(result.arrivalTimesMs).isEqualTo(TestChains.expectedArrivals(seed = 42L, arrivalRatePerMs = 0.25, endMs = 100.0))
    }

    @Test
    fun `streams differ by replication and role`() {
        val first = TestChains.stream(42L, TestChains.CLIENT, StreamRole.ARRIVALS).randU01()

        assertThat(TestChains.stream(42L, TestChains.CLIENT, StreamRole.ARRIVALS).randU01()).isEqualTo(first)
        assertThat(TestChains.stream(42L, TestChains.CLIENT, StreamRole.ARRIVALS, replication = 1).randU01()).isNotEqualTo(first)
        assertThat(TestChains.stream(42L, "entry", StreamRole.OUTCOME).randU01()).isNotEqualTo(first)
    }
}
```

- [ ] **Step 2: Тест падает**

Run: `./gradlew :core:test --tests 'resiliencelab.core.engine.ksl.TestChainsTest'`
Expected: FAIL — `Unresolved reference: TestChains`.

- [ ] **Step 3: Реализация**

```kotlin
package resiliencelab.core.engine.ksl

import ksl.simulation.Model
import ksl.utilities.random.rng.RNStreamIfc
import ksl.utilities.random.rvariable.KSLRandom
import resiliencelab.core.ir.Backoff
import resiliencelab.core.ir.BackoffKind
import resiliencelab.core.ir.CallEdge
import resiliencelab.core.ir.ChainIr
import resiliencelab.core.ir.ClientNode
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import resiliencelab.core.ir.RunSettings
import resiliencelab.core.ir.ServiceNode

/**
 * Chains, models and streams for engine tests. [simple] is the two-service chain the MVP tests built from
 * `TestData.simpleScenario()`; streams are the path-based ones the engine uses (ADR 0006).
 */
object TestChains {
    const val CLIENT = "client"

    fun fixed(durationMs: Double): Distribution = Distribution(DistributionShape.FIXED, durationMs)

    fun exponential(meanMs: Double): Distribution = Distribution(DistributionShape.EXPONENTIAL, meanMs)

    fun backoff(
        kind: BackoffKind,
        baseMs: Double,
        maxMs: Double,
        multiplier: Double = 2.0,
    ): Backoff = Backoff(kind, baseMs, maxMs, multiplier)

    val noBackoff: Backoff = backoff(BackoffKind.NONE, 0.0, 0.0)

    fun fixedBackoff(durationMs: Double): Backoff = backoff(BackoffKind.FIXED, durationMs, durationMs)

    fun run(
        warmupMs: Double = 0.0,
        measurementMs: Double = 1_000.0,
        seed: Long = 42L,
        maxRealTimeSeconds: Long = 30L,
        replications: Int = 1,
    ): RunSettings = RunSettings(replications, warmupMs, measurementMs, seed, maxRealTimeSeconds)

    /** `client` → `entry` → `backend`: one handler and two queue places each, 20 ms fixed processing, no retries delay. */
    fun simple(): ChainIr =
        ChainIr(
            client = ClientNode(CLIENT, arrivalRatePerMs = 0.01, deadlineMs = 500.0),
            entry = "entry",
            services =
                listOf(
                    ServiceNode("entry", handlers = 1, queueCapacity = 2, processing = fixed(20.0), failureProbability = 0.0),
                    ServiceNode("backend", handlers = 1, queueCapacity = 2, processing = fixed(20.0), failureProbability = 0.0),
                ),
            calls =
                listOf(
                    CallEdge(
                        path = "entry-to-backend",
                        from = "entry",
                        to = "backend",
                        network = fixed(0.0),
                        timeoutMs = 50.0,
                        attempts = 2,
                        backoff = noBackoff,
                    ),
                ),
            faults = emptyList(),
            run = run(),
        )

    /** Engine model of one replication of [chain] with path-based streams. */
    fun reliabilityModel(
        model: Model,
        chain: ChainIr,
        replication: Int = 0,
    ): ReliabilityModel {
        val plan = StreamPlan(PathStreams.keys(chain, replication))
        return ReliabilityModel(model, chain, PathStreamSource(plan, chain.run.seed, replication.toLong()))
    }

    /** A fresh copy of the stream the engine uses for [role] of [path]. */
    fun stream(
        seed: Long,
        path: String,
        role: StreamRole,
        replication: Int = 0,
    ): RNStreamIfc = PathStreams.streamAt(PathStreams.addressOf(StreamKey(seed, replication.toLong(), path.split('/'), role.id)))

    /** Original arrivals before [endMs], drawn as the engine draws them from the client's arrivals stream. */
    fun expectedArrivals(
        seed: Long,
        arrivalRatePerMs: Double,
        endMs: Double,
        replication: Int = 0,
    ): List<Double> {
        val arrivals = stream(seed, CLIENT, StreamRole.ARRIVALS, replication)
        return buildList {
            var timeMs = 0.0
            while (true) {
                timeMs += KSLRandom.rExponential(1 / arrivalRatePerMs, arrivals)
                if (timeMs >= endMs) break
                add(timeMs)
            }
        }
    }
}
```

- [ ] **Step 4: Тест проходит**

Run: `./gradlew :core:test --tests 'resiliencelab.core.engine.ksl.TestChainsTest'`
Expected: PASS. Совпадение поступлений до бита доказывает, что помощник берёт те же потоки, что и движок.

- [ ] **Step 5: Commit**

```bash
./gradlew :core:ktlintFormat
git add core/src/test/kotlin/resiliencelab/core/engine/ksl/TestChains.kt core/src/test/kotlin/resiliencelab/core/engine/ksl/TestChainsTest.kt
git commit -m "test(core): add chain fixtures with path-based streams"
```

---

## Таблица соответствий для переноса тестов

Задачи 4 и 5 применяют её к файлам целиком. Имена `execution` и вспомогательная функция `execution(...)` в тестах остаются, меняется только их тип.

| В тесте MVP | В тесте на IR |
|---|---|
| `TestData.simpleScenario()` | `TestChains.simple()` |
| тип `Scenario`, переменные и функции `scenario`, `singleServiceScenario`, `threeServiceScenario` | тип `ChainIr`, имена `chain`, `singleServiceChain`, `threeServiceChain` |
| тип `Execution`, `Execution(replications = …, warmupMs = …, measurementMs = …, seed = …, maxRealTimeSeconds = …)` | тип `RunSettings`, `RunSettings(...)` с теми же именами аргументов |
| `ReliabilityModel(model, scenario, execution)` | `TestChains.reliabilityModel(model, chain.copy(run = execution))` |
| `DurationDistribution(DistributionKind.X, mean, stdDevMs = null)`, `DurationDistribution(kind = …, meanMs = …, stdDevMs = null)` | `Distribution(DistributionShape.X, mean)`, `Distribution(shape = …, meanMs = …)` |
| тело локальной `fixed(durationMs)` | `TestChains.fixed(durationMs)`, тип результата `Distribution` |
| `base.services[i].copy(id = …, failureRate = …)` | `base.services[i].copy(path = …, failureProbability = …)` |
| `links = …`, `base.links` | `calls = …`, `base.calls` |
| `.copy(id = "backend-to-third", …)` у связи, `maxAttempts = …`, `retry = …` | `.copy(path = "backend-to-third", …)`, `attempts = …`, `backoff = …` |
| `RetrySpec(RetryKind.X, a, b)` | `TestChains.backoff(BackoffKind.X, a, b)` |
| `RetrySpec(RetryKind.X, a, b, base = c)` | `TestChains.backoff(BackoffKind.X, a, b, multiplier = c)` |
| `retry.copy(maxBackoffMs = …)`, `baseBackoffMs` | `backoff.copy(maxMs = …)`, `baseMs` |
| локальная `fixedBackoff(ms)` | `TestChains.fixedBackoff(ms)` |
| `workload = base.workload.copy(arrivalRate = a, requestDeadlineMs = d)` | `client = base.client.copy(arrivalRatePerMs = a, deadlineMs = d)` |
| `scenario.workload.arrivalRate` | `chain.client.arrivalRatePerMs` |
| `degradation = null` | `faults = emptyList()` |
| `degradation = DegradationSpec(serviceId = s, startMs = a, endMs = b, processingMultiplier = m, failureRate = f)` | `faults = listOf(FaultSpan(target = s, fromMs = a, toMs = b, processingMultiplier = m, failureProbability = f))` |
| импорты `resiliencelab.core.scenario.*`, `RNStreamProvider`, `ExponentialRV`, `UniformRV` (кроме `DurationSamplerTest`) | импорты нужных типов из `resiliencelab.core.ir` поштучно (KtLint запрещает `*`) |

Вызовы `reliabilityModel.invoke(serviceId = …)` и проверки по именам сервисов (`"entry"`, `"backend"`, `"third"`) не меняются: пути сервисов в `TestChains.simple()` совпадают с идентификаторами MVP.

---

### Task 4: Перенести тесты обслуживания, деградации и когорты

**Files:**
- Modify: `core/src/test/kotlin/resiliencelab/core/engine/ksl/DegradationRunoutTest.kt`, `SingleServiceInvocationTest.kt`, `ServiceMetricsIntegrationTest.kt`, `TimingArithmeticTest.kt`

- [ ] **Step 1: `DegradationRunoutTest` — таблица соответствий и потоки**

Применить таблицу. Удалить `expectedArrivals(seed, arrivalRate, streamNum, endMs)` и `findArrivalWindow(streamNum, acceptGap)` и добавить вместо них:

```kotlin
    private fun expectedArrivals(
        seed: Long,
        arrivalRatePerMs: Double,
        endMs: Double,
    ): List<Double> = TestChains.expectedArrivals(seed, arrivalRatePerMs, endMs)

    /** First seed from 42 whose first two arrivals at 0.01 requests/ms are [acceptGap] apart. */
    private fun findArrivalWindow(acceptGap: (Double) -> Boolean): ArrivalWindow {
        for (seed in 42L..10_000L) {
            val arrivals = TestChains.stream(seed, TestChains.CLIENT, StreamRole.ARRIVALS)
            val firstMs = KSLRandom.rExponential(100.0, arrivals)
            val secondMs = firstMs + KSLRandom.rExponential(100.0, arrivals)
            if (acceptGap(secondMs - firstMs)) {
                return ArrivalWindow(seed, firstMs, secondMs)
            }
        }
        error("No deterministic arrival window found")
    }
```

В вызовах убрать аргумент `streamNum = 3` или `streamNum = 7` и переименовать `arrivalRate =` в `arrivalRatePerMs =`: в MVP номер потока поступлений зависел от числа сервисов и связей, а поток по пути клиента — нет. Добавить импорт `ksl.utilities.random.rvariable.KSLRandom`.

Run: `./gradlew :core:test --tests 'resiliencelab.core.engine.ksl.DegradationRunoutTest'`
Expected: PASS, столько же тестов, сколько было.

- [ ] **Step 2: `SingleServiceInvocationTest`, `ServiceMetricsIntegrationTest` — таблица соответствий**

Применить таблицу; потоки эти тесты не читают.

Run: `./gradlew :core:test --tests 'resiliencelab.core.engine.ksl.SingleServiceInvocationTest' --tests 'resiliencelab.core.engine.ksl.ServiceMetricsIntegrationTest'`
Expected: PASS.

- [ ] **Step 3: `TimingArithmeticTest` — таблица соответствий и поток генератора**

Применить таблицу. В тесте `nonfinite next arrival candidate is rejected` заменить аргумент `streamNum = 1,` на:

```kotlin
            stream = TestChains.stream(42L, TestChains.CLIENT, StreamRole.ARRIVALS),
```

Run: `./gradlew :core:test --tests 'resiliencelab.core.engine.ksl.TimingArithmeticTest'`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
./gradlew :core:ktlintFormat
git add core/src/test/kotlin/resiliencelab/core/engine/ksl
git commit -m "test(core): port service, degradation and cohort tests to chain IR"
```

---

### Task 5: Перенести тесты таймаутов, повторов и распределений

**Files:**
- Modify: `core/src/test/kotlin/resiliencelab/core/engine/ksl/TimeoutRaceTest.kt`, `RetryDeadlineTest.kt`, `DurationSamplerTest.kt`

- [ ] **Step 1: `TimeoutRaceTest` — таблица соответствий и сеть**

Применить таблицу. Заменить `networkSamples`:

```kotlin
    /** Request and response delays of the first attempt: the first two draws of the call's network stream. */
    private fun networkSamples(meanMs: Double): Pair<Double, Double> {
        val network = TestChains.stream(42L, "entry-to-backend", StreamRole.NETWORK)
        return KSLRandom.rExponential(meanMs, network) to KSLRandom.rExponential(meanMs, network)
    }
```

Добавить импорт `ksl.utilities.random.rvariable.KSLRandom`.

Run: `./gradlew :core:test --tests 'resiliencelab.core.engine.ksl.TimeoutRaceTest'`
Expected: PASS.

- [ ] **Step 2: `RetryDeadlineTest` — таблица соответствий и исходы**

Применить таблицу, включая тесты `RetryPolicyEvaluator` в начале файла: `RetrySpec(RetryKind.NONE, 100.0, 7_000.0, base = 3.0)` становится `TestChains.backoff(BackoffKind.NONE, 100.0, 7_000.0, multiplier = 3.0)`, `belowCap.copy(maxBackoffMs = 50.0)` — `belowCap.copy(maxMs = 50.0)`. Заменить `failureThenSuccessSeed`:

```kotlin
    /** First seed from 42 whose backend fails the first local attempt and succeeds the second at failure probability 0.5. */
    private fun failureThenSuccessSeed(): Long {
        var candidate = 42L
        while (true) {
            val outcomes = TestChains.stream(candidate, "backend", StreamRole.OUTCOME)
            if (outcomes.randU01() < 0.5 && outcomes.randU01() >= 0.5) return candidate
            candidate++
        }
    }
```

Run: `./gradlew :core:test --tests 'resiliencelab.core.engine.ksl.RetryDeadlineTest'`
Expected: PASS.

- [ ] **Step 3: `DurationSamplerTest` целиком**

```kotlin
package resiliencelab.core.engine.ksl

import ksl.utilities.random.rng.RNStreamProvider
import ksl.utilities.random.rvariable.ExponentialRV
import ksl.utilities.random.rvariable.LognormalRV
import org.assertj.core.api.Assertions.assertThat
import resiliencelab.core.ir.Distribution
import resiliencelab.core.ir.DistributionShape
import kotlin.test.Test

class DurationSamplerTest {
    @Test
    fun `fixed sampler returns configured millisecond value for every draw`() {
        val sampler = DurationSamplerFactory.create(Distribution(DistributionShape.FIXED, 12.5), RNStreamProvider().rnStream(7))

        assertThat(DoubleArray(8) { sampler.next() }).containsExactly(*DoubleArray(8) { 12.5 })
    }

    @Test
    fun `exponential sampler matches KSL for configured mean and stream`() {
        val expected = ExponentialRV(25.0, 3, seededProvider())
        val sampler = DurationSamplerFactory.create(Distribution(DistributionShape.EXPONENTIAL, 25.0), seededProvider().rnStream(3))

        val expectedSamples = DoubleArray(16) { expected.value }

        assertThat(DoubleArray(16) { sampler.next() }).containsExactly(*expectedSamples)
    }

    @Test
    fun `lognormal sampler converts standard deviation to KSL variance`() {
        val expected = LognormalRV(40.0, 6.0 * 6.0, 4, seededProvider())
        val sampler =
            DurationSamplerFactory.create(Distribution(DistributionShape.LOGNORMAL, 40.0, 6.0), seededProvider().rnStream(4))

        val expectedSamples = DoubleArray(16) { expected.value }

        assertThat(DoubleArray(16) { sampler.next() }).containsExactly(*expectedSamples)
    }

    @Test
    fun `lognormal samplers repeat the sequence of identical streams`() {
        val distribution = Distribution(DistributionShape.LOGNORMAL, 40.0, 6.0)
        val first = DurationSamplerFactory.create(distribution, seededProvider().rnStream(4))
        val second = DurationSamplerFactory.create(distribution, seededProvider().rnStream(4))

        val firstSamples = DoubleArray(16) { first.next() }

        assertThat(DoubleArray(16) { second.next() }).containsExactly(*firstSamples)
    }

    private fun seededProvider(): RNStreamProvider =
        RNStreamProvider().apply {
            initialSeed(longArrayOf(101L, 202L, 303L, 404L, 505L, 606L))
        }
}
```

Run: `./gradlew :core:test --tests 'resiliencelab.core.engine.ksl.DurationSamplerTest'`
Expected: PASS.

- [ ] **Step 4: Ни один тест движка не зависит от MVP**

Run: `git grep -n -E "resiliencelab\.core\.scenario|SeedFactory|streamNum|RetrySpec|TestData" -- core/src/test/kotlin/resiliencelab/core/engine`
Expected: совпадения только в `SeedFactoryTest.kt`, который удаляет Task 7.

- [ ] **Step 5: Commit**

```bash
./gradlew :core:ktlintFormat
git add core/src/test/kotlin/resiliencelab/core/engine/ksl
git commit -m "test(core): port timeout, retry and distribution tests to chain IR"
```

---

### Task 6: Смысловые тесты исполнения и имя варианта в сбое

`ExperimentRunner` MVP называл вариант в сообщении о сбое; `ExperimentExecutor` из плана 1 пробрасывает исключение задачи как есть. Перенос теста про лимит реального времени возвращает это поведение для сбоев расчёта.

**Files:**
- Modify: `core/src/main/kotlin/resiliencelab/core/engine/ksl/ExperimentExecutionException.kt`, `core/src/main/kotlin/resiliencelab/core/execution/ExperimentExecutor.kt`
- Modify: `core/src/test/kotlin/resiliencelab/core/execution/ExperimentExecutorTest.kt`

- [ ] **Step 1: Добавить тесты в `ExperimentExecutorTest`**

Импорты (дополнительно к имеющимся):

```kotlin
import org.assertj.core.data.Offset.offset
import org.junit.jupiter.api.Tag
import resiliencelab.core.engine.ksl.ExperimentExecutionException
import resiliencelab.core.engine.ksl.TestChains
```

Тесты и помощники:

```kotlin
    @Test
    fun `different seeds change arrival streams`() {
        fun arrivals(seed: Long) =
            ExperimentExecutor(workers = 1)
                .run(experimentOf(TestChains.run(measurementMs = 100.0, seed = seed, replications = 2), "baseline" to singleService()))
                .variants
                .single()
                .replications
                .map { it.arrivalTimesMs }

        assertThat(arrivals(43L)).isNotEqualTo(arrivals(42L))
    }

    @Test
    fun `paired variants share arrival timestamps`() {
        val result =
            ExperimentExecutor(workers = 2).run(
                experimentOf(
                    TestChains.run(measurementMs = 100.0, replications = 3),
                    "baseline" to singleService(processing = TestChains.fixed(1.0)),
                    "candidate" to singleService(processing = TestChains.fixed(2.0)),
                ),
            )

        val (baseline, candidate) = result.variants
        baseline.replications.indices.forEach { index ->
            assertThat(candidate.replications[index].arrivalTimesMs).isEqualTo(baseline.replications[index].arrivalTimesMs)
        }
    }

    @Test
    fun `each replication draws arrivals from its own path stream`() {
        val settings = TestChains.run(measurementMs = 100.0, replications = 3)

        val instant = experimentOf(settings, "baseline" to singleService(processing = TestChains.fixed(0.0)))

        val result = ExperimentExecutor(workers = 3).run(instant)

        val actual = result.variants.single().replications.map { it.arrivalTimesMs }
        val expected = (0 until 3).map { TestChains.expectedArrivals(settings.seed, 0.25, settings.measurementMs, replication = it) }
        assertThat(actual).isEqualTo(expected)
        assertThat(actual[1]).isNotEqualTo(actual[0])
    }

    @Test
    fun `a capped replication fails the whole experiment and names its variant`() {
        val settings = TestChains.run(measurementMs = 100_000.0, replications = 2, maxRealTimeSeconds = 1L)
        val capped =
            singleService(
                arrivalRatePerMs = 1_000.0,
                processing = TestChains.fixed(100.0),
                queueCapacity = 100_000,
                deadlineMs = 1_000_000_000.0,
            )

        assertThatThrownBy {
            ExperimentExecutor(workers = 2).run(
                experimentOf(settings, "valid" to singleService(processing = TestChains.fixed(0.0)), "capped" to capped),
            )
        }.isInstanceOf(ExperimentExecutionException::class.java)
            .hasMessageContaining("Variant 'capped'")
            .hasMessageContaining("real-time cap")
    }

    @Test
    @Tag("analytic")
    fun `single service matches MM1 utilization and response time`() {
        val settings = TestChains.run(warmupMs = 10_000.0, measurementMs = 400_000.0, maxRealTimeSeconds = 120L)
        val chain = singleService(processing = TestChains.exponential(2.0), queueCapacity = 100_000, deadlineMs = 1_000_000_000.0)

        val variant = ExperimentExecutor(workers = 1).run(experimentOf(settings, "mm1" to chain)).variants.single()

        val replication = variant.replications.single()
        val utilization = replication.services.getValue("entry").handlerUtilization
        val meanResponseMs = variant.aggregate.pooledLatency.all!!.meanMs
        assertThat(replication.successes).isEqualTo(replication.originalArrivals)
        assertThat(replication.failures).isZero()
        assertThat(utilization).isCloseTo(0.5, offset(0.03))
        assertThat(meanResponseMs).isCloseTo(4.0, offset(0.25))
    }

    /** One service behind the client, as the MVP `ExperimentRunnerTest.scenario()`. */
    private fun singleService(
        arrivalRatePerMs: Double = 0.25,
        processing: Distribution = TestChains.fixed(1.0),
        queueCapacity: Int = 1_000,
        deadlineMs: Double = 10_000.0,
    ): ChainIr {
        val base = TestChains.simple()
        return base.copy(
            client = base.client.copy(arrivalRatePerMs = arrivalRatePerMs, deadlineMs = deadlineMs),
            services =
                listOf(
                    base.services.first().copy(
                        handlers = 1,
                        queueCapacity = queueCapacity,
                        processing = processing,
                        failureProbability = 0.0,
                    ),
                ),
            calls = emptyList(),
        )
    }

    private fun experimentOf(
        settings: RunSettings,
        vararg variants: Pair<String, ChainIr>,
    ): CompiledExperiment =
        CompiledExperiment(
            variants = variants.map { (id, chain) -> CompiledVariant(id, id, chain.copy(run = settings)) },
            run = settings,
        )
```

- [ ] **Step 2: Тесты: сбой по лимиту падает, остальные проходят**

Run: `./gradlew :core:test --tests 'resiliencelab.core.execution.ExperimentExecutorTest'`
Expected: FAIL только в `a capped replication fails the whole experiment and names its variant` — в сообщении нет `Variant 'capped'`.

- [ ] **Step 3: Реализация**

`ExperimentExecutionException.kt` целиком:

```kotlin
package resiliencelab.core.engine.ksl

/** Indicates that execution or result collection failed, so no complete experiment result can be produced. */
class ExperimentExecutionException(
    message: String,
    cause: Throwable? = null,
) : RuntimeException(message, cause)
```

В `ExperimentExecutor.run` заменить в задаче пула строку

```kotlin
                            val result = replicate(experiment.variants[variant].chain, plan, experiment.run.seed, replication)
```

на

```kotlin
                            val result =
                                try {
                                    replicate(experiment.variants[variant].chain, plan, experiment.run.seed, replication)
                                } catch (failure: ExperimentExecutionException) {
                                    val id = experiment.variants[variant].id
                                    val message = "Variant '$id', replication ${replication + 1}: ${failure.message}"
                                    throw ExperimentExecutionException(message, failure)
                                }
```

и добавить импорт `resiliencelab.core.engine.ksl.ExperimentExecutionException`. Сбои кода (не расчёта) по-прежнему пробрасываются как есть — это проверяет тест плана 1 `rethrows the failure of a task`.

- [ ] **Step 4: Тесты проходят**

Run: `./gradlew :core:test --tests 'resiliencelab.core.execution.ExperimentExecutorTest'`
Expected: PASS. Тест M/M/1 считает около 100 000 запросов и идёт несколько секунд.

- [ ] **Step 5: Commit**

```bash
./gradlew :core:ktlintFormat
git add core/src/main/kotlin/resiliencelab/core/engine/ksl/ExperimentExecutionException.kt core/src/main/kotlin/resiliencelab/core/execution/ExperimentExecutor.kt core/src/test/kotlin/resiliencelab/core/execution/ExperimentExecutorTest.kt
git commit -m "test(core): port MVP experiment semantics to the executor"
```

---

### Task 7: Удалить код MVP в ядре

**Files:**
- Delete: `core/src/main/kotlin/resiliencelab/core/scenario/`, `core/src/test/kotlin/resiliencelab/core/scenario/`
- Delete: `core/src/main/kotlin/resiliencelab/core/experiment/ExperimentRunner.kt`, `SweepExpander.kt`, `ReplicationResultStore.kt`; `core/src/test/kotlin/resiliencelab/core/experiment/ExperimentRunnerTest.kt`, `SweepExpanderTest.kt`
- Delete: `core/src/main/kotlin/resiliencelab/core/engine/ksl/SeedFactory.kt`, `LegacyScenarioAdapter.kt`; `core/src/test/kotlin/resiliencelab/core/engine/ksl/SeedFactoryTest.kt`
- Modify: `core/src/main/kotlin/resiliencelab/core/experiment/ResultModels.kt`, `core/src/main/kotlin/resiliencelab/core/engine/ksl/ReliabilityModel.kt`, `ArrivalGenerator.kt`, `DurationSampler.kt`, `RetryPolicyEvaluator.kt`

- [ ] **Step 1: Сверить правила проверки MVP с компилятором**

Просмотреть названия тестов `ScenarioValidatorTest` (`grep -n 'fun \`' core/src/test/kotlin/resiliencelab/core/scenario/ScenarioValidatorTest.kt`) и для каждого правила найти соответствие: диапазон параметра в `Stage1Catalog`, проверку в `ModelCompiler` или тест в `ModelCompilerTest`. Правило без соответствия не переносить в этой задаче, а перечислить в PR как находку.

- [ ] **Step 2: Удалить файлы**

```bash
git rm -r core/src/main/kotlin/resiliencelab/core/scenario core/src/test/kotlin/resiliencelab/core/scenario
git rm core/src/main/kotlin/resiliencelab/core/experiment/ExperimentRunner.kt core/src/main/kotlin/resiliencelab/core/experiment/SweepExpander.kt core/src/main/kotlin/resiliencelab/core/experiment/ReplicationResultStore.kt
git rm core/src/test/kotlin/resiliencelab/core/experiment/ExperimentRunnerTest.kt core/src/test/kotlin/resiliencelab/core/experiment/SweepExpanderTest.kt
git rm core/src/main/kotlin/resiliencelab/core/engine/ksl/SeedFactory.kt core/src/main/kotlin/resiliencelab/core/engine/ksl/LegacyScenarioAdapter.kt core/src/test/kotlin/resiliencelab/core/engine/ksl/SeedFactoryTest.kt
```

- [ ] **Step 3: Убрать старые типы, конструктор и перегрузки**

- `experiment/ResultModels.kt`: удалить классы `ExperimentResult` и `VariantResult` с их KDoc и импорт `resiliencelab.core.scenario.SweepParameter`.
- `engine/ksl/ReliabilityModel.kt`: удалить вторичный конструктор `constructor(model: Model, scenario: Scenario, execution: Execution, ...)` с KDoc и импорты `resiliencelab.core.scenario.Execution`, `resiliencelab.core.scenario.Scenario`; в KDoc класса заменить «for one scenario» на «for one chain».
- `engine/ksl/ArrivalGenerator.kt`: удалить вторичный конструктор с параметром `streamNum: Int` и его KDoc.
- `engine/ksl/DurationSampler.kt`: удалить перегрузку `create(spec: DurationDistribution, streamNum: Int, provider: RNStreamProvider)` с KDoc и импорты `RNStreamProvider`, `DurationDistribution`.
- `engine/ksl/RetryPolicyEvaluator.kt`: удалить перегрузку `backoffMs(retry: RetrySpec, ...)` с KDoc и импорт `RetrySpec`.

Run: `git grep -n -w -e SeedFactory -e LegacyScenarioAdapter -e ExperimentRunner -e SweepExpander -e ExperimentResult -e VariantResult -- '*.kt'; git grep -n -E "resiliencelab\.core\.scenario|MVP overload|MVP constructor" -- '*.kt'`
Expected: пусто.

- [ ] **Step 4: Проверка**

Run: `./gradlew ktlintFormat && ./gradlew clean build`
Expected: BUILD SUCCESSFUL. Если покрытие `core` ниже порога, добавить тесты на непокрытые ветви, а не снижать порог.

- [ ] **Step 5: Commit**

```bash
git add -A core
git commit -m "refactor(core): remove MVP scenarios, runner and legacy adapters"
```

---

### Task 8: Документация

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Описание модулей**

В разделе «Текущее состояние»:

- в строке `core` удалить «; модель сценариев MVP со sweep остаётся до перехода web»;
- в строке `apps:server` удалить « и ручки MVP для нынешнего web»;
- в абзаце «Сквозной срез этапа 1: ...» удалить предложение «Ручки MVP на сервере больше не используются и удаляются отдельной задачей.»

Run: `grep -n "MVP" AGENTS.md`
Expected: остаются только разделы «Границы MVP», «Обязательное развитие после MVP» и строки о проектном дизайне MVP.

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: drop MVP leftovers from the module overview"
```

---

### Task 9: Полная проверка

- [ ] **Step 1: JVM**

Run: `./gradlew clean build`
Expected: BUILD SUCCESSFUL; `apps/server/openapi.json` не изменился.

- [ ] **Step 2: Web и E2E**

Run (из `web`): `npm ci && npm run lint && npm run api:check && npm test -- --run && npm run build && npm run test:e2e`
Expected: всё проходит.

- [ ] **Step 3: Остатки MVP**

Run: `git grep -n -E "core\.simulation|core\.scenario|/api/v1/(experiments|scenarios)" -- ':!docs' ':!research'`
Expected: пусто. Упоминания в `docs/` — история решений и планов, их не трогать.

- [ ] **Step 4: Просмотр диффа**

Run: `git diff --check origin/main && git diff --stat origin/main`
Expected: изменения в `core/`, `apps/server/`, `AGENTS.md`.

- [ ] **Step 5: PR**

Открыть PR в `main` по правилам `AGENTS.md` (раздел «Работа по issue») с `Closes #<issue удаления MVP>`. В описании перечислить, куда ушли тесты MVP (таблица «Куда уходят тесты MVP»), и найденные правила проверки без соответствия (Task 7, Step 1).
