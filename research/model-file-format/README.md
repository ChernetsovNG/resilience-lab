# Исследование формата файлов модели

Прототип к [issue #47](https://github.com/ChernetsovNG/resilience-lab/issues/47).
Выводы и рекомендация A1 находятся в [отчёте](../../docs/research/2026-10-27-model-file-format.md).
Это отдельный исследовательский проект. `schemaVersion: research-1` не является
новой версией формата приложения; текущие CLI и UI эти файлы не читают.

## Повторение проверок

Нужны JDK 25, Git, Node.js из `web/.nvmrc` (26.12.1) и npm этой версии Node.js.
При пустом кэше нужен доступ к Maven Central, Gradle Plugin Portal и npm registry.
Все команды ниже выполняются из корня репозитория:

```sh
./gradlew -p research/model-file-format/jvm --no-daemon run
cd research/model-file-format/js
fnm exec --using 26.12.1 npm ci --ignore-scripts --no-audit --no-fund
fnm exec --using 26.12.1 npm run check
fnm exec --using 26.12.1 npm run probe
fnm exec --using 26.12.1 npm run browser
```

`fnm` можно заменить активацией той же версии через nvm. `npm run probe`
проверяет преобразование обоих вариантов `examples/retry-storm.json`, схемы,
ссылки, сохранение комментариев, повторную запись и настоящий `git merge-file`.
Он заново создаёт `fixtures/`, `schemas/`, `comments/`, `diffs/` и
`results/js-checks.json`. Изменённые файлы примеров лежат в игнорируемом
`generated/`; исходные файлы и полученные Git-диффы сохранены в репозитории.
JVM-программа предварительно создаёт схему и примеры для проверки через AJV.

Для браузерной проверки после сборки, из корня репозитория:

```sh
python3 -m http.server 48647 --bind 127.0.0.1 --directory research/model-file-format
```

Откройте `http://127.0.0.1:48647/browser.html`. Ожидаемый текст:
`YAML Document + AJV browser probe passed`. Он получен в браузере Codex
2026-10-27. После проверки остановите сервер с помощью Ctrl+C. Проверяется
исполнение браузерной сборки библиотек, а не работа приложения или браузерная
производительность.

## Измерения

Запускайте последовательно, без параллельного benchmark:

```sh
./gradlew -p research/model-file-format/jvm --no-daemon run --args=--benchmark
cd research/model-file-format/js
fnm exec --using 26.12.1 npm run benchmark
```

Результаты записываются в `jvm/results/benchmark.json` и `results/js-benchmark.json`.
Данные синтетические: 50, 500, 5000 плоских блоков. Нагрузки JVM и Node различаются,
их абсолютные времена нельзя сравнивать друг с другом. Измерен только разбор
строки в память, без файлового ввода, валидации, компиляции модели и симуляции.
Значения времени меняются при повторном запуске.

## Границы прототипа

- Конвертер предназначен для конкретного `retry-storm.json`; это не универсальная
  миграция. Порядок массивов сохранён через `serviceOrder` и `linkOrder`.
- Схемы оболочек написаны вручную для примера. Они не описывают весь контракт
  `core`. Отдельная схема `jvm/results/probe.schema.json` действительно
  сгенерирована из Kotlin; проверены nullable/default, enum и sealed-типы.
- `libraryRef` демонстрирует ссылку на шаблон одного сервиса. Порты составных
  блоков, маски, миграции и хеширование транзитивных зависимостей не реализованы.
- Ссылки разрешаются в словаре файлов в памяти. Проверка выхода через симлинк
  и атомарная запись файловой рабочей области относятся к будущему решению A6.
- `JSON.parse` не отклоняет дубли ключей; проверка намеренно фиксирует этот
  недостаток. Прототип не является готовым загрузчиком недоверенных файлов.

Зависимости закреплены в `js/package-lock.json` и `jvm/gradle.lockfile`.
Подробности JVM и первичные источники: [jvm/README.md](jvm/README.md).
