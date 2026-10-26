# Resilience Lab Simulation Core and CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать воспроизводимую KSL-симуляцию цепочки сервисов с таймаутами, повторами, очередями, деградацией, сериями экспериментов и CLI.

**Architecture:** Один независимый `core`-модуль содержит версионируемую модель сценария, KSL-адаптер, предметные метрики и экспериментальный контур. `apps/cli` только читает JSON и вызывает `core`; backend и UI подключаются к тем же интерфейсам следующими планами. Каждый вариант строится в отдельном `Model`, поэтому варианты можно выполнять параллельно без разделения состояния.

**Tech Stack:** JDK 25, Kotlin 2.4.21, Gradle 9.3, KSLCore R1.8.1, kotlinx-serialization-json 1.12.0, kotlinx-coroutines 1.11.0, JUnit 5, GPLv3.

**Spec:** `docs/superpowers/specs/2026-10-25-resilience-lab-design.md`

## Global Constraints

- Только Kotlin/JVM с `jvmToolchain(25)`; не создавать собственный DES-движок — календарь, процессы и ресурсы предоставляет `io.github.rossetti:KSLCore:R1.8.1`.
- Приложение и производные файлы лицензируются под GPLv3; `LICENSE` создаётся в первой задаче.
- Все длительности в публичных моделях — `Double` миллисекунды и имеют суффикс `Ms`; интенсивность нагрузки — запросы/мс.
- MVP — только направленная линейная цепочка синхронных вызовов; никаких DAG, брокеров, баз данных, circuit breaker или автоматической калибровки.
- `core` не зависит от HTTP, React или файлового UI и обязан работать через JVM API.
- Одинаковые конфигурация и seed/stream обязаны давать одинаковый результат; независимые повторения используют следующий sub-stream, а не сброс в тот же поток.
- После timeout вызывающая сторона прекращает ждать, но downstream-работа продолжается; новые повторы после общего deadline не создаются.
- Не помещать в репозиторий секреты, производственные адреса или реальные конфиденциальные данные.
- Каждая задача завершается focused checks и коммитом; перед финальным — полные `build`, `test`, `lint`-эквиваленты toolchain.

## MiSim Adaptation Map

MiSim (`D:\Education\Programming\MiSim`) используется как справочная предметная модель, а не как источник DES-инфраструктуры. DESMO-J сущности не копируются; каждый блок отображается на KSL-процессы, ресурсы и события с сохранением согласованной семантики из дизайна.

| MiSim | Resilience Lab / KSL |
|---|---|
| `Operation`, `DependencyDescription`, `ServiceDependencyInstance` | `ServiceSpec`/`LinkSpec` сейчас; вероятностные/иерархические зависимости — при расширении топологии после MVP |
| `MicroserviceInstance.handleIncomingRequest` | `ServiceInvocation`: admission → local processing → downstream dependencies → outcome; `ResourceWithQ` заменяет только CPU capacity, а не все DESMO-J события |
| `CPU` и `CPUProcessScheduler` | `ResourceWithQ` и `BoundedRequestQ` для MVP; отдельные burst-scheduling стратегии не переносятся без отдельной задачи |
| `NetworkRequestSendEvent`, `NetworkRequestReceiveEvent`, `NetworkRequestTimeoutEvent` | `CallAttempt` и KSL `KSLEvent`/`blockUntilCompleted`/`resumeProcess`; таймаут настраивается, общий deadline добавляется отдельно |
| `Retry` и `IRetryStrategy` | `RetryPolicyEvaluator`: exponential formula совпадает; `FIXED` остаётся константным, MiSim `linear` — отдельная возрастающая стратегия вне MVP |
| `JitteringExponentialBackoffRetryStrategy` | Full jitter `random(0, cappedBackoff)`, но случайные значения идут через назначенные KSL streams, а не общий `Random` класса |
| `CircuitBreaker` и `TimingWindowCircuitBreakerState` | Только справочник для последующего этапа; circuit breaker не добавляется в MVP |
| `LoadGeneratorDescription` и `ArrivalRateModel` | `ArrivalGenerator`: Poisson arrivals сейчас, trace/LIMBO-подобные профили — позднее |
| `MultiDataPointReporter` и генераторские метрики | `MetricsCollector` с нашими когортой, offered/admitted и amplification; формулы MiSim не заменяют наши определения |
| `Examples/Evaluation/scenario4.json`, `paper_architecture.json`, `calibrated_arch.json` | Источники delay/retry-конфигураций и synthetic-вариантов; произвольные зависимости упрощаются до линейной цепочки для MVP, без переноса JSON-формата один-к-одному |

MiSim `RetryTest` и `ScenarioTests` помечены `@Disabled`, поэтому не служат готовым набором «золотых» результатов. Эталонами являются явно вычисленные формулы, детерминированные lifecycle-тесты, аналитический M/M/1 и воспроизводимость. Если фактический код MiSim будет скопирован, а не только перечитан, сохраняются уведомления Apache-2.0 об авторстве.

## Review Focus

- Одновременные arrivals при заполнении очереди: `seize()` делает `yield` до `enqueue`, поэтому capacity проверяется только в `BoundedRequestQ.enqueue` (Task 4, `rejects attempts above waiting capacity`).
- Ответ и timeout в одно симуляционное время: ответ выигрывает; поздняя работа не отменяется (Task 6, `response wins a same-time race and orphaned work drains`).
- Retry/backoff: обработчик остаётся занятым, повтор после deadline запрещён (Task 7, `handler remains occupied during backoff and retries stop at deadline`).
- Warm-up/run-out: когорта определяется arrivals в measurement interval, а accepted work завершается до остановки (Task 8, `runout records the full cohort and drains orphaned work`).
- Сравнение вариантов: одинаковый seed даёт общие случайные потоки, повторы внутри варианта независимы (Task 10, `paired variants share streams and replications advance substreams`).

## Test Contracts

Каждый Task Step 1 реализует и запускает красную стадию следующих проверок до производственного кода; Step 2 подтверждает ожидаемую ошибку, а Step 4/5 — зелёную стадию.

```kotlin
// T01: assertEquals(document, ScenarioCodec.decodeExperiment(ScenarioCodec.encodeExperiment(document))); assertEquals(1, document.schemaVersion)
// T02: assertEquals("variants[0].scenario.services[1].handlers", errors.single { it.path.endsWith("handlers") }.path)
// T03: assertContentEquals(SeedFactory.seedVector(42L), SeedFactory.seedVector(42L)); assertTrue(seedVector.all { it > 0 })
// T04: assertFailsWith<QueueFullException> { secondAttempt.join() }; assertEquals(waitingCapacity, resource.waitingQ.size)
// T05: assertEquals(20.0, result.allLatenciesMs.single()); assertEquals(1, result.services.getValue("entry").offeredAttempts)
// T06: assertEquals(SUCCEEDED, responseAt50ms); assertEquals(TIMED_OUT, callerAt50ms); assertEquals(SUCCEEDED, downstreamAt80ms)
// T07: assertEquals(listOf(100.0, 300.0, 900.0, 2700.0, 7000.0, 7000.0), exponentialDelays); assertEquals(5, result.services.getValue("entry").offeredAttempts); assertEquals(0, attemptsAfterDeadline); assertTrue(handlerHeldDuringBackoff)
// T08: assertEquals(4.0, processingMultiplierAt11ms); assertFailsWith<ExperimentExecutionException> { runWithRealTimeCapBeforeDrain() }
// T09: series.record(0.0, 1.0); series.record(5.0, 2.0); series.record(10.0, 4.0); series.finish(20.0); assertEquals(3.0, series.average, 1e-9)
// T10: assertEquals(firstRun, secondRun); assertNotEquals(firstRun.variants.single().replications.single().arrivalTimesMs, differentSeedRun.variants.single().replications.single().arrivalTimesMs)
// T10 M/M/1: assertEquals(0.5, result.services.getValue("entry").handlerUtilization, 0.03); assertEquals(4.0, result.allLatenciesMs.average(), 0.25)
// T11: assertEquals(listOf(25.0, 50.0, 100.0), expanded.variants.map { it.sweepValue }); assertEquals(3, expanded.variants.size)
// T12: assertEquals(0, validExitCode); assertEquals(2, invalidExitCode); assertEquals(2, sweepResult.variants.size)
// T13: assertTrue(allTestsPassed && buildSuccessful && retryStormResult.variants.size == 2)
```

---

### Task 1: Toolchain, scenario model and JSON codec

**Files:**
- Create: `settings.gradle.kts`, `build.gradle.kts`, `gradle.properties`, `.gitignore`, `LICENSE`
- Create: `core/build.gradle.kts`
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/scenario/Models.kt`
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/scenario/ScenarioCodec.kt`
- Create: `core/src/test/kotlin/io/github/chernetsovng/resiliencelab/core/scenario/ScenarioCodecTest.kt`
- Create: `core/src/test/kotlin/io/github/chernetsovng/resiliencelab/core/scenario/TestData.kt`

**Interfaces:**
- Produces: `@Serializable` модели `Scenario`, `ServiceSpec`, `LinkSpec`, `WorkloadSpec`, `DegradationSpec`, `Execution`, `ExperimentVariant`, `ExperimentDocument`, `SweepSpec`, `SweepDocument`; enum `DistributionKind { FIXED, EXPONENTIAL, LOGNORMAL }`, `RetryKind { NONE, FIXED, EXPONENTIAL_FULL_JITTER }`, `SweepParameter { ARRIVAL_RATE, LINK_TIMEOUT, MAX_ATTEMPTS, BACKOFF_BASE, DEGRADATION_MULTIPLIER }`.
- Produces: `ScenarioCodec.decodeScenario(text: String): Scenario`, `encodeScenario(value: Scenario): String`, `decodeExperiment(text: String): ExperimentDocument`, `encodeExperiment(value: ExperimentDocument): String`.

- [ ] **Step 1: Create the Gradle skeleton and generate the wrapper**

Create root files with `include("core")`, `include("apps:cli")` only after Task 12 adds CLI. Configure every Kotlin module with `jvmToolchain(25)`, JUnit Platform and Maven Central. Pin `io.github.rossetti:KSLCore:R1.8.1`, `org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0`, `org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0` in `core`; apply `kotlin("jvm")` and `kotlin("plugin.serialization")` version `2.4.21` in the root with `apply false`.

Run: `gradle wrapper --gradle-version 9.3`
Expected: `gradlew`, `gradlew.bat` and `gradle/wrapper/*` exist; `.gitignore` excludes `.gradle/`, `build/`, `node_modules/`, `dist/`, `playwright-report/`, `test-results/`.

- [ ] **Step 2: Write the failing codec test**

In `ScenarioCodecTest`, build a two-service `Scenario` in `TestData.simpleScenario()` with fixed processing `20.0 ms`, queue capacity `2`, one link with timeout `50.0 ms`, two attempts, `arrivalRate = 0.01`, deadline `500.0 ms`; assert round-trip equality and `schemaVersion == 1` for `ExperimentDocument`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `./gradlew :core:test --tests "*ScenarioCodecTest"`
Expected: FAIL because models and codec do not exist.

- [ ] **Step 4: Implement the models and codec**

Use exact fields: service `id`, `handlers`, `queueCapacity`, `processing`, `failureRate`; link `id`, `from`, `to`, `network`, `timeoutMs`, `maxAttempts`, `retry`; workload `arrivalRate`, `requestDeadlineMs`; degradation `serviceId`, `startMs`, `endMs`, `processingMultiplier`, nullable `failureRate`; execution `replications`, `warmupMs`, `measurementMs`, `seed`, `maxRealTimeSeconds`. `ExperimentDocument` contains `schemaVersion`, `execution`, `variants`; each variant has `id`, `label`, `scenario` and nullable metadata `sweepParameter`/`sweepValue`. `SweepDocument` contains `schemaVersion`, `execution`, `baseScenario`, `sweep`; sweep has `parameter`, nullable `serviceId`/`linkId`, `values`. Use `Int` for `handlers`, `queueCapacity`, `maxAttempts` and `replications`, `Long` for `seed` and `maxRealTimeSeconds`, and `Double` for all other numeric values.

Use strict JSON (`ignoreUnknownKeys = false`, `explicitNulls = false`, `prettyPrint = true`) and reject any `schemaVersion != 1`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `./gradlew :core:test --tests "*ScenarioCodecTest"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add settings.gradle.kts build.gradle.kts gradle.properties gradlew gradlew.bat gradle .gitignore LICENSE core
git commit -m "feat: add simulation scenario model and codec"
```

### Task 2: Scenario and execution validation

**Files:**
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/scenario/ScenarioValidator.kt`
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/scenario/ValidationIssue.kt`
- Create: `core/src/test/kotlin/io/github/chernetsovng/resiliencelab/core/scenario/ScenarioValidatorTest.kt`

**Interfaces:**
- Consumes: models from Task 1.
- Produces: `ScenarioValidator.validate(document: ExperimentDocument): List<ValidationIssue>` and `ScenarioValidator.requireValid(document: ExperimentDocument)`, which throws `ScenarioValidationException(errors)`; `ValidationIssue(path: String, message: String)`.

- [ ] **Step 1: Write failing validation tests**

Cover: unknown entry, duplicate service IDs, cycle, two outgoing links, disconnected chain, `handlers == 0`, negative queue capacity, nonpositive timeout/deadline/arrival rate, `maxAttempts == 0`, invalid failure rate, lognormal without positive `stdDevMs`, degradation `startMs >= endMs`, `replications == 0`, negative warmup, nonpositive measurement, nonpositive real-time cap, sweep value targeting a missing link/service.

Assert exact paths such as `variants[0].scenario.services[1].handlers` and `sweep.linkId`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :core:test --tests "*ScenarioValidatorTest"`
Expected: FAIL with validator missing.

- [ ] **Step 3: Implement validation**

Return all errors rather than failing on the first. `FIXED` permits zero duration; `EXPONENTIAL` requires positive mean; `LOGNORMAL` requires positive mean and standard deviation. Validate `0 <= failureRate <= 1`, all finite numbers, sweep-specific targets and non-empty sweep values. `requireValid` is called by every execution entry point.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :core:test --tests "*ScenarioValidatorTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin core/src/test/kotlin
git commit -m "feat: validate experiment scenarios"
```

### Task 3: Duration samplers and reproducible seed mapping

**Files:**
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/DurationSampler.kt`
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/SeedFactory.kt`
- Create: `core/src/test/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/DurationSamplerTest.kt`
- Create: `core/src/test/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/SeedFactoryTest.kt`

**Interfaces:**
- Produces: `fun interface DurationSampler { fun next(): Double }`; `DurationSamplerFactory.create(spec: DurationDistribution, streamNum: Int, provider: RNStreamProvider): DurationSampler`.
- Produces: `SeedFactory.seedVector(seed: Long): LongArray`, exactly six valid values for `RNStreamProvider.initialSeed`.

- [ ] **Step 1: Write failing sampler and seed tests**

Assert `FIXED` always returns its value, exponential mean equals the configured mean, and two `LognormalRV(mean, variance, streamNum)` samplers with the same provider seed produce identical sequences. For `seed = 42L`, assert six values, first three in `1 until 4294967087`, last three in `1 until 4294944443`, no zero values and equality across calls; assert different seeds produce different vectors.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :core:test --tests "*DurationSamplerTest" --tests "*SeedFactoryTest"`
Expected: FAIL.

- [ ] **Step 3: Implement samplers and seed mapping**

Use KSL `ConstantRV`, `ExponentialRV(mean, streamNum, provider)` and `LognormalRV(mean, stdDev * stdDev, streamNum, provider)`. Build the six values deterministically via `kotlin.random.Random(seed)`, respecting the KSL bounds from `RNStreamProvider.initialSeed`; do not use wall-clock randomness.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :core:test --tests "*DurationSamplerTest" --tests "*SeedFactoryTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin core/src/test/kotlin
git commit -m "feat: add reproducible random samplers"
```

### Task 4: Bounded FIFO request queue

**Files:**
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/BoundedRequestQ.kt`
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/QueueFullException.kt`
- Create: `core/src/test/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/BoundedRequestQTest.kt`

**Interfaces:**
- Produces: `BoundedRequestQ(parent: ModelElement, name: String?, waitingCapacity: Int, resourceProvider: () -> Resource) : RequestQ`, overriding `enqueue(qObject: ProcessModel.Entity.Request, priority: Int, obj: Any?)`.
- Produces: `QueueFullException(serviceId: String) : RuntimeException`, caught by service invocation code; it is never used for normal control flow outside admission.

- [ ] **Step 1: Write the failing capacity tests**

With one occupied handler and `waitingCapacity = 0`, assert the second incoming attempt throws `QueueFullException`. With one occupied handler and `waitingCapacity = 1`, assert one attempt can wait and the next is rejected. Also assert an idle service with zero waiting capacity accepts an attempt and that `waitingQ.size` never exceeds the configured capacity.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :core:test --tests "*BoundedRequestQTest"`
Expected: FAIL with bounded queue missing.

- [ ] **Step 3: Implement admission inside `enqueue`**

Before calling `super.enqueue`, reject when `size >= waitingCapacity`, except when the queue is empty and `resourceProvider().canAllocate(qObject.amountRequested)` allows immediate service without waiting. This exception-free fast path is required for `waitingCapacity == 0`; it does not weaken the bound when waiters already exist. Do not use a pre-`seize` `wip` check: KSL yields before enqueue, so that check is racy.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :core:test --tests "*BoundedRequestQTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin core/src/test/kotlin
git commit -m "feat: enforce bounded service queues"
```

### Task 5: Single-service invocation and basic metrics

**Files:**
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/ReliabilityModel.kt`
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/ServiceRuntime.kt`
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/Outcomes.kt`
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/MetricsCollector.kt`
- Create: `core/src/test/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/SingleServiceInvocationTest.kt`

**Interfaces:**
- Produces: `ReliabilityModel(model: Model, scenario: Scenario, execution: Execution) : ProcessModel`; `ServiceInvocation` is a `ProcessModel.Entity` with `val outcome: AttemptOutcome`.
- Produces: `AttemptOutcome { PENDING, SUCCEEDED, LOCAL_FAILURE, DOWNSTREAM_FAILURE, TIMED_OUT, QUEUE_REJECTED, DEADLINE_EXCEEDED }`.
- Produces: `MetricsCollector.replicationResult(): ReplicationResult` with arrivals, successes/failures, raw successful/failed/all latencies and per-service attempt counters.

- [ ] **Step 1: Write the failing single-service tests**

For one service with fixed processing `20 ms`, one handler, zero failures and one original request, assert success at `20 ms`, one offered and one admitted attempt. Add a local failure case and assert no downstream invocation occurs and the handler is eventually released.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :core:test --tests "*SingleServiceInvocationTest"`
Expected: FAIL with runtime missing.

- [ ] **Step 3: Implement service invocation and metrics**

Each invocation acquires one `ResourceWithQ` handler through `BoundedRequestQ`, samples local duration/failure at actual start, delays once, and releases in `finally`. Rejected attempts count as offered but not admitted. Track accepted active invocations and original active requests for the later completion monitor. `ReliabilityModel` uses `Model.simulate()` in tests; KSL process construction follows `process("...") { ... }` and `activate(...)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :core:test --tests "*SingleServiceInvocationTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin core/src/test/kotlin
git commit -m "feat: simulate single service invocations"
```

### Task 6: Downstream calls and timeout races

**Files:**
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/CallAttempt.kt`
- Modify: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/ReliabilityModel.kt`
- Modify: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/ServiceRuntime.kt`
- Create: `core/src/test/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/TimeoutRaceTest.kt`

**Interfaces:**
- Consumes: `DurationSampler`, `ServiceInvocation`, `AttemptOutcome`.
- Produces: `CallAttempt` state with `status`, `child: ServiceInvocation`, `timeoutEvent: KSLEvent<*>`, and transition methods `onChildCompleted()`, `onTimeout()`.

- [ ] **Step 1: Write the failing race and orphan tests**

Use two services with fixed downstream processing `50 ms` and timeout `50 ms`; assert response wins at `50 ms`. With processing `80 ms` and timeout `50 ms`, assert caller timeout at `50 ms`, downstream success at `80 ms`, and no cancellation of downstream accepted work. Add nonzero network samples and assert independent request/response delays are both included in the attempt deadline, while caller queue/preprocessing stays outside it. Verify the late timeout event is cancelled when response arrives first.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :core:test --tests "*TimeoutRaceTest"`
Expected: FAIL.

- [ ] **Step 3: Implement the call lifecycle**

Activate a fresh child invocation and call `blockUntilCompleted(child.process)` in the parent. Sample network delay independently for request and response; the request delay precedes child admission and the response delay follows downstream processing but precedes publication of the successful outcome to the caller. Schedule timeout with `KSLEvent.DEFAULT_PRIORITY + 1` so a same-time response wins; the event calls the parent entity's `resumeProcess()` only if the attempt is pending. On response, mark the state and set `timeoutEvent.cancel = true` while it is still scheduled. A timeout changes only caller waiting; it never terminates the child. The parent handler remains allocated.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :core:test --tests "*TimeoutRaceTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin core/src/test/kotlin
git commit -m "feat: add non-cancelling downstream timeouts"
```

### Task 7: Retry, backoff, jitter and global deadline

**Files:**
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/RetryPolicyEvaluator.kt`
- Modify: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/ServiceRuntime.kt`
- Create: `core/src/test/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/RetryDeadlineTest.kt`

**Interfaces:**
- Produces: `RetryPolicyEvaluator.backoffMs(retry: RetrySpec, failedAttemptNumber: Int, jitter: () -> Double): Double`, where attempt numbering starts at 1 and no retry occurs when `maxAttempts` is exhausted or `time >= originalDeadline`.

- [ ] **Step 1: Write the failing retry/deadline tests**

Assert two attempts happen after one retryable failure and success follows. Verify fixed backoff, exponential cap, and full jitter `0 <= value <= cap` with stubbed deterministic jitter values `0.0` and `0.999`. Using MiSim's paper example converted to milliseconds (`baseBackoff = 100`, `base = 3`, `maxBackoff = 7000`), assert delays `100, 300, 900, 2700, 7000, 7000` and `maxAttempts = 5` meaning five total attempts. Use one handler and a second request to prove the handler remains occupied during backoff. Set a deadline during backoff and assert no new attempt is created; assert queued orphaned work still executes.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :core:test --tests "*RetryDeadlineTest"`
Expected: FAIL.

- [ ] **Step 3: Implement retry evaluation and caller deadline**

`NONE` means zero delay; `FIXED` means `min(base, cap)`; `EXPONENTIAL_FULL_JITTER` means `jitter() * min(cap, base * 2^(failedAttemptNumber - 1))`. Per-attempt timeout is `min(link.timeoutMs, originalDeadline - time)`; no new attempt or retry begins at/after the deadline. Backoff delay is capped by remaining deadline, and the current handler is not released during delay or retries.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :core:test --tests "*RetryDeadlineTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin core/src/test/kotlin
git commit -m "feat: add retries and deadline handling"
```

### Task 8: Poisson arrivals, degradation and completion monitor

**Files:**
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/ArrivalGenerator.kt`
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/CompletionMonitor.kt`
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/ExperimentExecutionException.kt`
- Modify: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/ReliabilityModel.kt`
- Create: `core/src/test/kotlin/io/github/chernetsovng/resiliencelab/core/simulation/DegradationRunoutTest.kt`

**Interfaces:**
- Produces: `ArrivalGenerator` scheduling exponential inter-arrival events only while `time < warmupMs + measurementMs`.
- Produces: `CompletionMonitor`, which stops replication only after arrival end, zero active original requests and zero accepted active invocations.

- [ ] **Step 1: Write the failing degradation and runout tests**

Schedule degradation from `10` to `20 ms` with multiplier `4`; assert an attempt already active at `10 ms` keeps its original duration, while an attempt starting at `11 ms` gets `4x`, even if it finishes after `20 ms`. Assert arrivals stop at measurement end, all measurement-cohort outcomes are recorded (including deadline failures), and replication ends only after orphaned accepted work drains. Add a real-time cap test proving that a cap before drain is reported as `ExperimentExecutionException`, not returned as valid partial metrics.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :core:test --tests "*DegradationRunoutTest"`
Expected: FAIL.

- [ ] **Step 3: Implement arrivals, degradation and drain**

Use `ExponentialRV(mean = 1 / arrivalRate)` for open Poisson arrivals. Degradation start/end events only change runtime flags; duration/failure are sampled once at actual local start. Set `lengthOfReplication = Double.POSITIVE_INFINITY` and `maximumAllowedExecutionTimePerReplication = execution.maxRealTimeSeconds.seconds`; the monitor periodically calls `stopReplication()` only after full drain, preventing both truncation and an unguarded infinite run. Detect the executive's execution-time-exceeded state and mark the replication failed with `ExperimentExecutionException` instead of aggregating its partial observations.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :core:test --tests "*DegradationRunoutTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin core/src/test/kotlin
git commit -m "feat: add workload degradation and runout"
```

### Task 9: Cohort metrics, time-weighted series and aggregation

**Files:**
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/experiment/ResultModels.kt`
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/experiment/TimeWeightedSeries.kt`
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/experiment/MetricsAggregator.kt`
- Create: `core/src/test/kotlin/io/github/chernetsovng/resiliencelab/core/experiment/TimeWeightedSeriesTest.kt`
- Create: `core/src/test/kotlin/io/github/chernetsovng/resiliencelab/core/experiment/MetricsAggregatorTest.kt`

**Interfaces:**
- Produces: `TimeWeightedSeries(measurementStartMs: Double, measurementEndMs: Double)` with `record(timeMs: Double, value: Double)`, `finish(timeMs: Double)` and `val average: Double`, integrating only `[measurementStartMs, measurementEndMs]` and excluding runout.
- Produces: `ReplicationResult(arrivalTimesMs: List<Double>, allLatenciesMs: List<Double>, successfulLatenciesMs: List<Double>, failedLatenciesMs: List<Double>, originalArrivals: Int, successes: Int, failures: Int, services: Map<String, ServiceMetrics>)`.
- Produces: `ServiceMetrics(offeredAttempts: Int, admittedAttempts: Int, timeouts: Int, retries: Int, failures: Int, queueRejections: Int, handlerUtilization: Double, meanQueueLength: Double, p95QueueLength: Double)`.
- Produces: `MetricsAggregator.aggregate(replications: List<ReplicationResult>): AggregateMetrics`; `AggregateMetrics` contains pooled `LatencySummary` and across-replication `MetricSummary(mean, stdDev, ci95Low, ci95High, min, max)` for success rate, p95/p99 and per-service amplification.

- [ ] **Step 1: Write the failing metrics tests**

For a series changing at `0, 5, 10, 20` within measurement `[5,15]`, assert hand-computed time average and no contribution from runout. For two replications, assert `amplification_s = admittedAttempts_s / originalArrivals`, p95/p99 via `Statistic.percentile`, and 95% intervals via KSL statistics; include an empty-failure-latency case that yields `null` rather than NaN.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :core:test --tests "*TimeWeightedSeriesTest" --tests "*MetricsAggregatorTest"`
Expected: FAIL.

- [ ] **Step 3: Implement series and aggregation**

Warmup arrivals never enter request metrics but occupy resources. Cohort attempts include runout; time-weighted queue/utilization metrics include all work only during the original measurement interval. Keep offered and admitted counters separate; do not use baseline as amplification denominator. Empty distributions are `null`, never NaN.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :core:test --tests "*TimeWeightedSeriesTest" --tests "*MetricsAggregatorTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin core/src/test/kotlin
git commit -m "feat: aggregate experiment metrics"
```

### Task 10: Independent replications and paired variant execution

**Files:**
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/experiment/ExperimentRunner.kt`
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/experiment/ReplicationResultStore.kt`
- Create: `core/src/test/kotlin/io/github/chernetsovng/resiliencelab/core/experiment/ExperimentRunnerTest.kt`

**Interfaces:**
- Produces: `ExperimentRunner.run(document: ExperimentDocument): ExperimentResult`, where `ExperimentResult` includes `schemaVersion`, application/KSL versions and `variants: List<VariantResult>`.
- Produces: `VariantResult(id, label, sweepParameter: SweepParameter?, sweepValue: Double?, replications, aggregate)`; nullable sweep fields are absent for ordinary baseline/candidate runs, and the store is thread-safe because variants execute concurrently.

- [ ] **Step 1: Write the failing reproducibility tests**

Run the same document twice and assert identical results. Assert different seeds change results. In baseline/candidate with an otherwise identical scenario, assert identical arrival timestamps (common random numbers); within one variant, assert replication streams advance rather than repeat (independent replications). Include a single-service analytic M/M/1 sanity check with `arrivalRate = 0.25/ms`, exponential service mean `2 ms`, queue capacity `100_000`, `100_000` cohort arrivals and seed `42`: expected utilization `0.5 ± 0.03` and mean end-to-end response `4.0 ± 0.25 ms`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :core:test --tests "*ExperimentRunnerTest"`
Expected: FAIL.

- [ ] **Step 3: Implement the experiment runner**

Validate the document, set each model's six-value vector via `streamProvider.initialSeed(SeedFactory.seedVector(seed))`, and use fresh `Model` builders. Run variants with `ConcurrentScenarioRunner(kslDb = null)` and `runBlocking`; each scenario has independent models but identical stream assignment for CRN. Set `resetStartStreamOption = false`, `advanceNextSubStreamOption = true`, `antitheticOption = false`, `numberOfStreamAdvancesPriorToRunning = 0`. Use `replicationInitializationOption = true`, infinite horizon plus the drain monitor, and the configured real-time cap. Capture custom replication results in `ReplicationResultStore`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :core:test --tests "*ExperimentRunnerTest"`
Expected: PASS, including the analytic tolerance.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin core/src/test/kotlin
git commit -m "feat: run reproducible experiment variants"
```

### Task 11: One-dimensional sweep expansion

**Files:**
- Create: `core/src/main/kotlin/io/github/chernetsovng/resiliencelab/core/experiment/SweepExpander.kt`
- Create: `core/src/test/kotlin/io/github/chernetsovng/resiliencelab/core/experiment/SweepExpanderTest.kt`

**Interfaces:**
- Produces: `SweepExpander.expand(document: SweepDocument): ExperimentDocument`, preserving execution and creating variant IDs `sweep-0`, `sweep-1`, etc.; each generated `ExperimentVariant` carries `sweepParameter` and `sweepValue` in its metadata for result charts.

- [ ] **Step 1: Write the failing sweep tests**

Expand timeout values `[25.0, 50.0, 100.0]` on a selected link and assert three variants, exact changed values, stable order and unchanged all other fields. Repeat for arrival rate, max attempts, backoff base and degradation multiplier; assert missing targets are rejected by validation rather than silently ignored.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :core:test --tests "*SweepExpanderTest"`
Expected: FAIL.

- [ ] **Step 3: Implement sweep expansion**

Use structural copy of the base scenario; never mutate baseline/candidate input. Preserve the same execution and seed so each sweep point uses common random numbers. Call `ScenarioValidator.requireValid` on the expanded document.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :core:test --tests "*SweepExpanderTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin core/src/test/kotlin
git commit -m "feat: expand parameter sweep experiments"
```

### Task 12: CLI and retry-storm example

**Files:**
- Create: `apps/cli/build.gradle.kts`
- Create: `apps/cli/src/main/kotlin/io/github/chernetsovng/resiliencelab/cli/Main.kt`
- Create: `apps/cli/src/test/kotlin/io/github/chernetsovng/resiliencelab/cli/CliTest.kt`
- Create: `examples/retry-storm.json`
- Modify: `settings.gradle.kts`

**Interfaces:**
- Consumes: `ScenarioCodec`, `ScenarioValidator`, `SweepExpander`, `ExperimentRunner`.
- Produces: CLI `validate <experiment.json>`, `run <experiment.json>`, `sweep <sweep.json>`; JSON result is written to stdout, diagnostics to stderr.

- [ ] **Step 1: Write the failing CLI tests**

Invoke `validate` on valid and invalid documents and assert exit codes `0`/`2`. Invoke `run` on `examples/retry-storm.json` with a short test execution and assert exit code `0`, valid JSON result and baseline/candidate IDs. Invoke `sweep` on a two-point timeout document and assert two variant results.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :apps:cli:test --tests "*CliTest"`
Expected: FAIL because the application module does not exist.

- [ ] **Step 3: Implement the CLI and example**

Use the `application` plugin and main class `resiliencelab.cli.MainKt`; no CLI dependency is needed for three explicit commands. `validate` returns `2` on validation errors, `run`/`sweep` return `1` on execution errors and `0` on success. Include only synthetic data in `examples/retry-storm.json` with three services, bounded handlers/queues, degradation and deadline/retry settings.

- [ ] **Step 4: Run the tests and the real CLI**

Run: `./gradlew :apps:cli:test --tests "*CliTest"`
Expected: PASS.
Run: `./gradlew :apps:cli:run --args="validate examples/retry-storm.json"`
Expected: exit `0` and a human-readable valid message on stderr.

- [ ] **Step 5: Commit**

```bash
git add settings.gradle.kts apps/cli examples
git commit -m "feat: add experiment CLI and retry storm example"
```

### Task 13: Full verification and agent guidance update

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/plans/2026-10-25-simulation-core-and-cli.md` only if an executed command differs from this plan

**Interfaces:**
- Consumes: every previous task and its public API.

- [ ] **Step 1: Run all unit/integration tests**

Run: `./gradlew test`
Expected: all core and CLI tests pass with zero failures.

- [ ] **Step 2: Run full builds and real scenario verification**

Run: `./gradlew clean build`
Expected: BUILD SUCCESSFUL.
Run: `./gradlew :apps:cli:run --args="run examples/retry-storm.json"`
Expected: exit `0`, complete baseline/candidate JSON with success rates, p95/p99 and amplification.

- [ ] **Step 3: Update AGENTS.md with actual commands**

Replace the design-only status with current modules and record exact commands `./gradlew test`, `./gradlew clean build`, CLI validate/run/sweep and the JDK 25 toolchain requirement. Note that frontend/server plans are still pending; do not claim the full MVP is complete.

- [ ] **Step 4: Review the final diff**

Run: `git diff --check && git status --short`
Expected: no whitespace errors; only intended source, example, build and documentation changes. Do not push.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/superpowers/plans/2026-10-25-simulation-core-and-cli.md
git commit -m "docs: record simulation core verification"
```
