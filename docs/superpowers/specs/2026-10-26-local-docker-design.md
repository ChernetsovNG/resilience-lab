# Локальный запуск Resilience Lab через Docker Compose

## Назначение

Пользователь должен одной командой собрать и запустить существующие Spring Boot backend и браузерный UI, затем открыть `http://localhost:5173` и провести реальный эксперимент без локальной установки JDK, Gradle и Node.js.

## Цели и границы

- `docker compose up --build` собирает оба приложения из исходников и запускает два контейнера.
- Frontend доступен только на loopback `127.0.0.1:5173` (`127.0.0.1:5173:8080`); backend API — только на loopback `127.0.0.1:8080` (`127.0.0.1:8080:8080`) для независимой проверки health. Configurable LAN access не поддерживается.
- Браузер использует same-origin `/api`; Nginx передаёт запросы сервису `backend:8080`.
- SPA routes возвращают `index.html`; отсутствующие статические файлы и API не подменяются index-страницей.
- Compose не содержит секретов, внешних production-адресов, БД или дополнительных сервисов.
- Process-local задания по-прежнему теряются после перезапуска backend; лимит остаётся 100 terminal jobs FIFO.
- Hot reload, production deployment, TLS, authentication и multi-container scaling не входят в задачу.

## Approaches

1. **Production-like multi-stage images, выбрано.** Backend собирается Gradle/JDK 25 и запускается на JRE 25. Frontend собирается Node 25.5.0 и раздаётся Nginx с reverse proxy `/api`. Больше трёх небольших файлов конфигурации, зато поведение близко к production build и не требует mount исходников.
2. **Dev containers с `bootRun` и Vite.** Даёт hot reload, но медленнее запускается, требует mounted source/caches и проверяет dev server вместо production frontend. Не выбрано: цель пользователя — посмотреть собранный прототип, а не разрабатывать внутри контейнеров.
3. **Единый контейнер.** Меньше процессов Compose, но смешивает JVM/Node lifecycle и противоречит разделению backend/frontend. Не выбрано.

Выбор Docker Compose сделан пользователем. Production-like вариант и host-порты — решение исполнителя для простого локального просмотра.

## Реализация

- Корневой `compose.yaml` с сервисами `backend` и `frontend`; frontend зависит от запущенного backend.
- `apps/server/Dockerfile`: multi-stage Gradle build `:apps:server:bootJar`, затем минимальный JRE 25 runtime с non-root пользователем.
- `web/Dockerfile`: воспроизводимый `npm ci`, `npm run build`, затем Nginx static runtime с non-root-compatible listen/port и pid/tmp paths.
- `web/nginx.conf`: static SPA и `/api/` proxy без изменения URI; обычные proxy headers; backend resolver через Docker DNS.
- `.dockerignore`: исключает VCS, worktrees, build outputs, dependencies, Playwright artifacts, KSL output и SDD scratch.
- `AGENTS.md`: команда запуска/остановки, URL, локальная проверка и ограничение process-local storage.

## Проверка

- `docker compose config --quiet` проверяет конфигурацию.
- `docker compose up --build -d` действительно собирает оба образа.
- Host health `http://127.0.0.1:8080/api/v1/health` возвращает успех.
- Browser через `http://127.0.0.1:5173` видит healthy backend, создаёт chain и запускает короткий comparison до `COMPLETED` через Nginx proxy.
- `docker compose down` останавливает и удаляет контейнеры после проверки.
- Существующие JVM/web/E2E gates не должны регрессировать.

## Решения исполнителя

Образы и их точные теги фиксируются после проверки доступности; секреты и persistent volumes не добавляются. Локальная проверка Docker обязательна: конфигурационный lint без фактического запуска недостаточен.
