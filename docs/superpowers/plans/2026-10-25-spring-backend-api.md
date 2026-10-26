# Resilience Lab Spring Backend API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить локальный Spring Boot API для валидации сценариев и запуска длительных экспериментов с отслеживанием состояния и получением результата.

**Architecture:** `apps/server` — тонкий Spring MVC adapter над `core`: JSON-документы декодируются тем же `ScenarioCodec`, sweep раскрывается через `SweepExpander`, выполнение идёт через `ExperimentRunner`. HTTP-потоки не выполняют CPU-bound симуляции; отдельный bounded `ThreadPoolTaskExecutor` запускает задания и сохраняет их состояние в памяти процесса.

**Tech Stack:** JDK 25, Kotlin 2.4.21, Spring Boot 4.1.2, Spring MVC/Tomcat, Gradle 9.3, KSLCore R1.8.1, kotlinx-serialization-json 1.12.0, kotlinx-coroutines 1.11.0, JUnit 5, MockMvc, GPLv3.

**Spec:** `docs/superpowers/specs/2026-10-25-resilience-lab-design.md`

**Depends on:** `docs/superpowers/plans/2026-10-25-simulation-core-and-cli.md`; интерфейсы `ScenarioCodec`, `ScenarioValidator`, `SweepExpander`, `ExperimentRunner`, `ExperimentDocument`, `SweepDocument`, `ExperimentResult` должны уже существовать.

## Global Constraints

- Все JVM-модули используют `jvmToolchain(25)`; Spring Boot фиксируется на стабильном `4.1.2`, не RC.
- Только `spring-boot-starter-web`, `spring-boot-starter-test` и `spring-boot-webmvc-test` плюс `jackson-module-kotlin`; не добавлять Spring Data, JPA, Security, Actuator или второй web-фреймворк.
- Сервер слушает только `127.0.0.1:8080`; Vite proxy обращается к нему по `/api`, поэтому отдельный CORS/Security-слой не нужен.
- `core` остаётся независимым от Spring и HTTP; JSON-декодирование сценариев не дублируется через второй объектный маппер.
- Задания хранятся только в памяти процесса; база данных и сохранение между перезапусками не входят в MVP.
- CPU-bound симуляции выполняются в отдельном bounded executor, а не в request threads и не через общий неограниченный `@Async` executor.
- Ошибки валидации возвращают `400`, отсутствующее задание — `404`, внутренние stack traces и конфиденциальные данные клиенту не возвращаются.
- Все длительности — `Double` миллисекунды; результаты содержат application/KSL versions, чтобы воспроизводимость не зависела от скрытого окружения.

## Review Focus

- Невалидный JSON/сценарий: клиент получает структурированный `400`, задание не создаётся (Task 2, `rejects malformed submission without creating a job`).
- Длительная CPU-bound работа: submit быстро возвращает `202`, request thread не ждёт завершения симуляции (Task 3, `submit returns before the blocking executor completes`).
- Одновременные задания: состояния и результаты не смешиваются, ошибка одного не портит соседнее (Task 3, `jobs isolate results and failures`).
- Несуществующий UUID и failed job: корректные `404` и безопасное сообщение без stack trace (Task 4, `returns 404 and sanitized execution errors`).
- Совместимость JSON: поля `schemaVersion`, `execution`, `variants`, `aggregate` и `p95/p99` соответствуют core (Task 4, `serves the real experiment result`).

## Test Contracts

```kotlin
// T01: mockMvc.get("/api/v1/health").andExpect { status { isOk() }; jsonPath("$.status") { value("ok") }; jsonPath("$.kslVersion") { value("R1.8.1") } }
// T02: mockMvc.post("/api/v1/scenarios/validate") { content = malformedJson }.andExpect { status { isBadRequest() }; jsonPath("$.code") { value("INVALID_SUBMISSION") } }; assertEquals(0, jobs.size)
// T03: assertEquals(QUEUED, job.status); assertTrue(submitLatch.await(0, MILLISECONDS)); assertEquals(COMPLETED, otherJob.status)
// T04: assertEquals(202, submitResponse.status); assertEquals(404, missingResultResponse.status); assertEquals(409, unfinishedResultResponse.status); assertEquals(500, failedResultResponse.status)
// T04 real: assertEquals(1, result.schemaVersion); assertEquals("baseline", result.variants.single().id); assertTrue(result.variants.single().aggregate.pooledLatency.all.p95Ms > 0.0); assertTrue(result.variants.single().aggregate.pooledLatency.all.p99Ms >= result.variants.single().aggregate.pooledLatency.all.p95Ms)
// T05: assertTrue(buildSuccessful && http202Accepted && completedStatusReceived && resultContainsBaselineAndCandidate)
```

---

### Task 1: Spring Boot module and health endpoint

**Files:**
- Create: `apps/server/build.gradle.kts`
- Create: `apps/server/src/main/kotlin/resiliencelab/server/ResilienceLabApplication.kt`
- Create: `apps/server/src/main/kotlin/resiliencelab/server/api/HealthController.kt`
- Create: `apps/server/src/main/resources/application.yml`
- Create: `apps/server/src/test/kotlin/resiliencelab/server/api/HealthControllerTest.kt`
- Modify: `settings.gradle.kts`

**Interfaces:**
- Produces: `GET /api/v1/health` returning `200` with `{ "status": "ok", "applicationVersion": "0.1.0", "kslVersion": "R1.8.1" }`.
- Produces: `ResilienceLabApplication` and Spring Boot `bootRun` for local startup.

- [ ] **Step 1: Add the module and write the failing health test**

Configure `application`, `org.springframework.boot` version `4.1.2`, `io.spring.dependency-management` version `1.1.7`, Kotlin JVM/serialization `2.4.21` and `jvmToolchain(25)`. Dependencies: `project(":core")`, `spring-boot-starter-web`, `jackson-module-kotlin`, `spring-boot-starter-test`, `spring-boot-webmvc-test`. Bind `127.0.0.1:8080` in `application.yml`.

Write a `@WebMvcTest(HealthController::class)` assertion for `GET /api/v1/health`: status `200`, `status == "ok"`, `kslVersion == "R1.8.1"`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `./gradlew :apps:server:test --tests "*HealthControllerTest"`
Expected: FAIL because the module/controller does not exist.

- [ ] **Step 3: Implement the application and health endpoint**

Use `@SpringBootApplication` and `runApplication<ResilienceLabApplication>(*args)`. Keep the controller free of simulation dependencies. Set `server.address=127.0.0.1`, `server.port=8080`, `server.shutdown=graceful` and disable the startup banner.

- [ ] **Step 4: Run the test and real startup check**

Run: `./gradlew :apps:server:test --tests "*HealthControllerTest"`
Expected: PASS.
Run: `./gradlew :apps:server:bootRun` in one terminal and `curl http://127.0.0.1:8080/api/v1/health` in another.
Expected: HTTP `200` with the exact JSON contract; stop the server after the check.

- [ ] **Step 5: Commit**

```bash
git add settings.gradle.kts apps/server
git commit -m "feat: add Spring Boot server health endpoint"
```

### Task 2: Submission codec, validation endpoint and API errors

**Files:**
- Create: `apps/server/src/main/kotlin/resiliencelab/server/api/ExperimentSubmission.kt`
- Create: `apps/server/src/main/kotlin/resiliencelab/server/api/ExperimentSubmissionCodec.kt`
- Create: `apps/server/src/main/kotlin/resiliencelab/server/api/ExperimentService.kt`
- Create: `apps/server/src/main/kotlin/resiliencelab/server/api/ScenarioController.kt`
- Create: `apps/server/src/main/kotlin/resiliencelab/server/api/ApiExceptionHandler.kt`
- Create: `apps/server/src/test/kotlin/resiliencelab/server/api/ScenarioControllerTest.kt`

**Interfaces:**
- Produces: `ExperimentSubmission(experiment: ExperimentDocument? = null, sweep: SweepDocument? = null)`; exactly one field must be non-null.
- Produces: `ExperimentSubmissionCodec.decode(body: String): ExperimentSubmission`.
- Produces: `POST /api/v1/scenarios/validate` returning `200` with `ValidationReport(valid, issues)` for structurally valid input and `400` for malformed JSON or failed execution preparation.

- [ ] **Step 1: Write the failing validation/error tests**

Cover valid `experiment`, valid `sweep`, both fields present, both absent, malformed JSON, unknown JSON field and unsupported `schemaVersion`. Assert that `ValidationReport` preserves core issue paths and that the response never contains a stack trace.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :apps:server:test --tests "*ScenarioControllerTest"`
Expected: FAIL with submission/API code missing.

- [ ] **Step 3: Implement submission preparation and errors**

`ExperimentSubmissionCodec` uses the same strict JSON settings as core. Add `ExperimentService.prepare(submission): ExperimentDocument`, which expands sweep through `SweepExpander` or validates the direct experiment through `ScenarioValidator.requireValid`. `ApiExceptionHandler` maps malformed input and `ScenarioValidationException` to `400` with `ApiError(code, message, issues)`; do not expose exception messages containing internal paths beyond scenario field paths.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :apps:server:test --tests "*ScenarioControllerTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/main/kotlin apps/server/src/test/kotlin
git commit -m "feat: validate scenarios through the API"
```

### Task 3: Bounded experiment job manager

**Files:**
- Create: `apps/server/src/main/kotlin/resiliencelab/server/experiment/ExperimentExecutor.kt`
- Create: `apps/server/src/main/kotlin/resiliencelab/server/experiment/ExperimentJob.kt`
- Create: `apps/server/src/main/kotlin/resiliencelab/server/experiment/ExperimentJobManager.kt`
- Create: `apps/server/src/main/kotlin/resiliencelab/server/experiment/SimulationExecutorConfig.kt`
- Create: `apps/server/src/test/kotlin/resiliencelab/server/experiment/ExperimentJobManagerTest.kt`

**Interfaces:**
- Produces: `ExperimentExecutor.execute(document: ExperimentDocument): ExperimentResult`, implemented in production by delegating to `ExperimentRunner.run`.
- Produces: `ExperimentJobManager.submit(document): UUID`, `get(id: UUID): ExperimentJob?`; statuses `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`.
- Produces: `ExperimentJob(id, status, result: ExperimentResult?, error: String?)`; failed results never contain exception stack traces.

- [ ] **Step 1: Write the failing lifecycle tests**

Use a controlled `ExperimentExecutor` with latches: assert `submit` returns before release, initial `QUEUED` state, transition to `RUNNING`, then `COMPLETED`. Prove a second job completes independently while the first is blocked and that one failing job becomes `FAILED` without changing the other result.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :apps:server:test --tests "*ExperimentJobManagerTest"`
Expected: FAIL with job manager missing.

- [ ] **Step 3: Implement the executor and lifecycle**

Create a `ThreadPoolTaskExecutor` with core/max size `Runtime.availableProcessors()`, queue capacity `100`, thread prefix `simulation-`, `waitForTasksToCompleteOnShutdown = true` and `awaitTerminationSeconds = 30`. Store jobs in `ConcurrentHashMap<UUID, ExperimentJob>` and use atomic status transitions. `KslExperimentExecutor` is the only production adapter to `ExperimentRunner`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :apps:server:test --tests "*ExperimentJobManagerTest"`
Expected: PASS without arbitrary sleeps.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/main/kotlin apps/server/src/test/kotlin
git commit -m "feat: manage asynchronous experiment jobs"
```

### Task 4: Experiment API and real result integration

**Files:**
- Create: `apps/server/src/main/kotlin/resiliencelab/server/api/ExperimentController.kt`
- Create: `apps/server/src/test/kotlin/resiliencelab/server/api/ExperimentControllerTest.kt`
- Create: `apps/server/src/test/kotlin/resiliencelab/server/api/RealExperimentApiTest.kt`

**Interfaces:**
- Consumes: `ExperimentSubmissionCodec`, `ExperimentService.prepare`, `ExperimentJobManager`.
- Produces: `POST /api/v1/experiments` returning `202` with `{ "id": UUID, "status": "QUEUED" }`; `GET /api/v1/experiments/{id}` returning job state; `GET /api/v1/experiments/{id}/result` returning full `ExperimentResult`, `409` while unfinished, or `500` with a sanitized `ApiError` for a failed job.

- [ ] **Step 1: Write the failing API tests**

Use controlled jobs for submit/poll, missing UUID and unfinished result. Assert `202` for valid submissions, `400` for invalid input without job creation, `404` for missing jobs/results and `409` for an unfinished result. Assert failed jobs return `500` with their safe message and no stack trace. In `RealExperimentApiTest`, use `@SpringBootTest` with a short one-service experiment and poll until `COMPLETED`, then assert real `schemaVersion`, variant ID, success count, p95/p99 and amplification fields.

- [ ] **Step 2: Run the API tests to verify they fail**

Run: `./gradlew :apps:server:test --tests "*ExperimentControllerTest" --tests "*RealExperimentApiTest"`
Expected: FAIL because endpoints do not exist.

- [ ] **Step 3: Implement the endpoints**

`POST` prepares the submission before creating the job. Result endpoint returns `404` for unknown IDs, `409` for `QUEUED`/`RUNNING`, `500` with sanitized `ApiError` for `FAILED`, and `ExperimentResult` for `COMPLETED`. Keep response DTOs in the API package and do not expose internal exception classes.

- [ ] **Step 4: Run API and full server tests**

Run: `./gradlew :apps:server:test --tests "*ExperimentControllerTest" --tests "*RealExperimentApiTest"`
Expected: PASS.
Run: `./gradlew :apps:server:test`
Expected: all server tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/main/kotlin apps/server/src/test/kotlin
git commit -m "feat: expose experiment jobs through the API"
```

### Task 5: Backend verification and agent guidance update

**Files:**
- Modify: `AGENTS.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/superpowers/plans/2026-10-25-spring-backend-api.md` only if implementation changes the documented contract

**Interfaces:**
- Consumes: every endpoint and the real CLI scenario from the core plan.

- [ ] **Step 1: Run the full JVM verification**

Run: `./gradlew clean build`
Expected: BUILD SUCCESSFUL on JDK 25 with all core/CLI/server tests passing.

- [ ] **Step 2: Exercise the API end-to-end through HTTP**

Start `./gradlew :apps:server:bootRun`; submit `examples/retry-storm.json` through `POST /api/v1/experiments` wrapped as `experiment`, poll the returned UUID and fetch its result. Verify real HTTP `202` → `COMPLETED` → `200` with baseline/candidate metrics; stop the server.

- [ ] **Step 3: Update AGENTS.md**

Record the Spring Boot 4.1.2/JDK 25 choice, `bootRun`, server test commands, API base URL and the fact that jobs are process-local. Keep the required future gRPC/Kafka/Redis/database roadmap unchanged.

- [ ] **Step 4: Review the final diff**

Run: `git diff --check && git status --short`
Expected: no whitespace errors and only intended changes; do not push.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/superpowers/plans/2026-10-25-spring-backend-api.md .github/workflows/ci.yml
git commit -m "docs: record backend API verification"
```
