# KSL capabilities spike

Отдельный исследовательский Gradle-проект для [issue #46](https://github.com/ChernetsovNG/resilience-lab/issues/46). Продуктовые модули его не используют.

Из корня репозитория:

```bash
./gradlew -p research/ksl-capabilities test installDist
python3 research/ksl-capabilities/run_benchmarks.py --output research/ksl-capabilities/build/reproduced
```

Нужны JDK 25, Python 3 и `/usr/bin/time`. Матрица запускает 51 JVM последовательно; каждый процесс использует heap до 2 GiB и до 8 workers. Каталог результатов должен быть новым. Результат полной проверки — `verification.txt`; при несовпадении результатов или ошибке JVM команда завершается с ненулевым кодом.

Методика, ограничения и измерения: [отчёт S1](../../docs/research/2026-10-27-ksl-capabilities.md). Правила работы: [AGENTS.md](../../AGENTS.md).
