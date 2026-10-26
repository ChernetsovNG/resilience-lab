# Resilience Lab Core Quality Design

Дата: 2026-10-26  
Статус: согласовано для реализации

## Замысел

Устранить семь замечаний к первой части Resilience Lab без изменения симуляционной семантики, JSON-контрактов, случайных последовательностей и уже проверенного поведения core/CLI.

Исходная точка: `fa6507464073fd5112a07932f023fee455c9386e`, 151 тест, успешная clean build и реальный retry-storm JSON. Незавершённый backend Task 1 сохраняется отдельно и не входит в milestone.

## Цели

- Убрать личный сегмент `chernetsovng` из package.
- Перевести core/CLI-тесты на AssertJ.
- Добавить полезный KDoc основным классам и публичным API.
- Назвать KSL seed bounds и группы вместо магических чисел и индексов.
- Запускать KtLint локально и в CI.
- Автоматически создавать и оценивать JaCoCo-покрытие с non-regression baseline.
- Обновить Gradle только после доказанной совместимости.

## Не цели и анти-цели

- Не менять retry/deadline/cohort/metric semantics, JSON schema или random streams.
- Не реализовывать backend внутри этого milestone.
- Не ослаблять тесты, не скрывать warnings, не завышать coverage исключениями.
- Не делать blanket formatting, documentation portal, dashboard или unrelated cleanup.
- Не пушить `main` и не включать backend WIP/generated output в core-коммиты.

## Ограничения

- JDK 25 и Kotlin 2.4.21 сохраняются.
- `resiliencelab` — новый корневой package; JVM API меняется намеренно, JSON API не меняется.
- AssertJ `3.27.7` — stable, JUnit Platform сохраняется.
- KtLint Gradle plugin `14.2.0` включается в `check` и GitHub Actions.
- JaCoCo — HTML+XML для каждого JVM-модуля. Baseline рассчитывается по факту, а не выбирается произвольно.
- Целевой wrapper — Gradle `9.8.2`; откат к `9.3.1` допускается только после воспроизведённой несовместимости.
- Внешний `C:\Users\ncher\.gradle\init.gradle` не изменяется.

## Подходы

### Один milestone с отдельными коммитами — выбрано

Backend WIP сохраняется в именованном stash. Package, assertions, KDoc, KtLint, JaCoCo, Gradle и CI идут независимыми коммитами на `feat/first-prototype`, с проверкой каждой группы и финальной clean build. В remote отправляются только проверенные core-коммиты.

Плюс: одна согласованная проверка и минимум конфликтов с backend. Минус: большой совокупный diff, разбитый по смыслу для рецензирования.

### Несколько независимых веток — отклонено

Package/style и tooling можно разделить на ветки, но это увеличит интеграционные конфликты и повторные проверки без содержательного снижения риска.

## Решения

- Package: `resiliencelab`.
- AssertJ `3.27.7`; JUnit lifecycle/engine и исходные expected values сохраняются.
- KDoc на английском, кратко описывает ответственность и неочевидные lifecycle/cohort/timeout/metric-контракты, а не имена свойств.
- Seed: именованные `KSL_M1_EXCLUSIVE_LIMIT`, `KSL_M2_EXCLUSIVE_LIMIT`, две группы по три значения; порядок draws неизменен.
- Общие AssertJ/KtLint/JaCoCo-настройки применяются через root `subprojects`, чтобы последующие JVM-модули получали их автоматически.
- Coverage baseline: фактический line/branch floor, округлённый вниз до ближайших 5%, но не ниже line 70% / branch 60%. При недостижении минимума добавляются behavioral-тесты по TDD, без исключения production-классов. Позднее baseline нельзя снижать.
- CI: GitHub Actions, Microsoft JDK 25, `./gradlew --no-daemon clean build`, JaCoCo artifacts, без секретов.
- Gradle обновляется только wrapper; системный Gradle и Chocolatey не нужны.

## Критерии приёма

- Старый package отсутствует, AssertJ используется во всех core/CLI-тестах, основные классы документированы.
- Seed vector не изменился.
- `./gradlew ktlintCheck` и `./gradlew clean build` проходят.
- JaCoCo HTML/XML существуют, coverage verification проходит локально и используется в CI.
- Real installed CLI выдаёт полный baseline/candidate JSON.
- Backend WIP восстановлен, `main` не изменён, в `origin/feat/first-prototype` попали только проверенные core-коммиты.
