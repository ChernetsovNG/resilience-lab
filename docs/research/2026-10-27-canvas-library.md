# Выбор библиотеки холста

Дата проверки: 2026-10-27. Задача: [#4](https://github.com/ChernetsovNG/resilience-lab/issues/4).
Статус: исследование; рекомендацию предстоит учесть в дизайне этапа 1.

## Рекомендация

**Рекомендуется сохранить `@xyflow/react@12.12.0` для этапов 1–2.** Он уже встроен в приложение, позволяет создавать вычислимые React-узлы и SVG-связи, имеет документированные средства доступности и браузерного тестирования. Платные Pro-примеры не обязательны для требуемых возможностей. Цена решения — собственные история действий, clipboard, редактирование подписей и предметная иерархия; эта работа перечислена ниже.

**X6 — проверенная в прототипе альтернатива, если приоритетом станет готовый набор операций редактора.** Он даёт Stencil, History, Clipboard и редактор текста связи. Для сравнения выбраны React Flow и X6: первый представляет существующую интеграцию, второй — более полный бесплатный редактор с официальным React-адаптером. maxGraph имеет сильное преимущество в готовом drill-down/folding, но требует переноса на императивную модель; в этой работе его производительность не измерялась. Это выбор двух разных подходов для проверки, а не доказательство превосходства X6 над maxGraph.

Смена библиотеки не даёт готовых масок параметров, связанных библиотечных экземпляров или разворачивания подсистем в вычислительную модель. Для текущего проекта выигрыш миграции не перевешивает стоимость переноса и новые интеграционные риски. Rete остаётся допустимым на MIT-подмножестве, но также требует прикладной иерархии; Excalidraw ориентирован на рисование и существенно меняет модель редактора; tldraw исключён обязательным production-ключом.

## Требования и исходное состояние

Основание — [продуктовое видение, §4, §5.5–5.7 и §7](../product/2026-10-27-product-vision.md) и [проектный дизайн](../superpowers/specs/2026-10-25-resilience-lab-design.md). Палитра содержит только вычислимые блоки. Этап 1 требует удобного редактора и воспроизведения рассчитанных временных рядов; этап 2 добавляет частицы запросов и составные блоки с портами, масками и связанными библиотечными экземплярами.

Сравнение выполнено для состояния репозитория `c8ae0c1d36b870555608c024be0e4775c4d6791d`. В [web/package.json](../../web/package.json) закреплены React/React DOM `19.3.1`, `@xyflow/react` `12.12.0`, alias `typescript: npm:@typescript/typescript6@6.0.2`, `@typescript/native: npm:typescript@7.0.2` и Vite `8.3.5`; [web/.nvmrc](../../web/.nvmrc) задаёт Node.js `26.12.1`. Номера alias и фактически запущенного компилятора различаются, подробнее в разделе проверок. Совпадение диапазона `peerDependencies` с React 19 рассматривается отдельно от сборки и браузерной проверки.

В [ChainCanvas](../../web/src/editor/ChainCanvas.tsx) узлы и связи уже поступают в React Flow из состояния сценария. Позиции хранятся отдельно и сбрасываются при выборе варианта. Выбор связей отключён явно: `selectable: false`. [ServiceBlock](../../web/src/editor/ServiceBlock.tsx) — обычный React-компонент с двумя `Handle`; операции над сценарием находятся в [useScenarioEditor](../../web/src/scenario/useScenarioEditor.ts). Ограничение линейной цепочкой задано моделью приложения и не определяет возможности библиотеки холста.

Цена смены библиотеки включает перенос узлов, событий, выделения и CSS. [Unit-тесты редактора](../../web/src/editor/ChainCanvas.test.tsx) и [браузерный сценарий](../../web/e2e/retry-storm.spec.ts) используют `.react-flow__edge`, `.react-flow__node` и `.react-flow__handle`; эти проверки тоже придётся адаптировать. Формы, API, вычислительное ядро и предметный reducer сами по себе смены библиотеки не требуют.

## Сравнение кандидатов

Лицензионный фильтр взят из issue: MIT, Apache-2.0 и MPL-2.0 допустимы; обязательный production-ключ, водяной знак и коммерческие компоненты не подходят. В таблицах «свой код» означает работу приложения поверх доступных API. Это оценка объёма интеграции, а не утверждение о невозможности функции.

### Лицензии, версии и поддержка

| Кандидат | Лицензия и бесплатная поставка | React и TypeScript | Активность и документация |
| --- | --- | --- | --- |
| **React Flow 12.12.0** | [MIT](https://github.com/xyflow/xyflow/blob/main/LICENSE). Pro продаёт [расширенные примеры и поддержку](https://reactflow.dev/pro); отдельного платного runtime нет. | [Peers React/DOM ≥17](https://registry.npmjs.org/@xyflow/react/12.12.0) включают 19.3.1. Пакет имеет типы; проверка точного toolchain — ниже. | [npm](https://registry.npmjs.org/@xyflow/react): 14 stable-публикаций за год, последняя 2026-09-24. Есть отдельные руководства по [производительности](https://reactflow.dev/learn/advanced-use/performance), [тестам](https://reactflow.dev/learn/advanced-use/testing) и [доступности](https://reactflow.dev/learn/advanced-use/accessibility). |
| **AntV X6 3.1.8** | [MIT](https://github.com/antvis/X6/blob/master/LICENSE). В 3.x редакторские плагины [включены в основной пакет](https://x6.antv.antgroup.com/en/tutorial/update/). | Core не зависит от React; [React shape 3.0.1](https://registry.npmjs.org/@antv/x6-react-shape/3.0.1) требует React/DOM ≥18 и X6 ^3.x. [Типы поставляются с core](https://registry.npmjs.org/@antv/x6/3.1.8). Обнаруженные проблемы сборки — ниже. | [npm](https://registry.npmjs.org/@antv/x6): 11 доступных stable-публикаций за год, последняя 2026-08-11. Подробные API и примеры; следует сверять их с [изменениями 3.x](https://x6.antv.antgroup.com/en/tutorial/update/). |
| **maxGraph 0.25.1** | [Apache-2.0](https://github.com/maxGraph/maxGraph/blob/v0.25.1/LICENSE), редакторские примитивы открыты. | [Core без React peer](https://github.com/maxGraph/maxGraph/blob/v0.25.1/packages/core/package.json); нужен lifecycle-код вокруг императивного Graph. [Upstream использует TS ~6.0.3](https://github.com/maxGraph/maxGraph/blob/v0.25.1/package.json); это не проверка приложения на 6.0.2. | [Пять stable-релизов за год](https://github.com/maxGraph/maxGraph/releases), последний 2026-10-21. Есть руководства и API; [plugin API до 1.0 может меняться](https://maxgraph.github.io/maxGraph/docs/usage/plugins/). |
| **JointJS core 4.3.4** | [MPL-2.0](https://github.com/clientIO/joint/blob/%40joint/core%404.3.4/LICENSE). Условия JointJS+ не относятся к открытому core; готовые UI-компоненты Plus в сравнение бесплатной поставки не входят. | Core независим от React. Открытый [@joint/react 4.3.7](https://github.com/clientIO/joint/blob/%40joint/react%404.3.7/packages/joint-react/package.json) требует React/DOM ≥18 и имеет тесты React 19; точная пара 19.3.1/TS 6.0.2 с обёрткой здесь не запускалась. | [11 релизов core за год](https://github.com/clientIO/joint/releases), последний 2026-10-27. Развиваются [React-интеграция](https://docs.jointjs.com/react/getting-started/) и открытые layout-пакеты. В документации надо различать core и Plus. |
| **Rete.js 2.0.6** | [Основные пакеты MIT](https://retejs.org/docs/licensing/). `rete-scopes-plugin` и `rete-structures` имеют CC-BY-NC-SA-4.0 и не проходят фильтр issue. Собственная иерархия поверх MIT-пакетов остаётся возможным вариантом. | [react-plugin 2.1.2](https://registry.npmjs.org/rete-react-plugin/2.1.2) допускает React 19; [интеграция требует createRoot](https://retejs.org/docs/guides/renderers/react/). Типы поставляются с пакетами. | [Core](https://registry.npmjs.org/rete) не выпускался за год, последняя 2.0.6 — 2025-06-30. [React plugin](https://registry.npmjs.org/rete-react-plugin) обновлён 2026-07-10, [area](https://registry.npmjs.org/rete-area-plugin) — 2026-07-08. Есть guides и [E2E-матрица](https://retejs.org/docs/quality-assurance/). |
| **tldraw 5.5.2** | [Production требует лицензионного ключа; hobby-лицензия сохраняет watermark](https://tldraw.dev/community/license). **Исключён условиями issue.** | [Peers React/DOM допускают 18.2 и 19.2.1+](https://registry.npmjs.org/tldraw/5.5.2), включая 19.3.1; есть TypeScript API. Runtime здесь не проверяли. | [47 stable-публикаций за год](https://registry.npmjs.org/tldraw), последняя 2026-10-02. Подробная SDK-документация; [minor-релизы могут содержать breaking changes](https://tldraw.dev/releases). |
| **Excalidraw 0.18.1** | [MIT](https://github.com/excalidraw/excalidraw/blob/v0.18.1/LICENSE), открытый React-компонент. | [Собственные peers допускают React 19](https://registry.npmjs.org/@excalidraw/excalidraw/0.18.1); транзитивные Radix peers конфликтуют с 19.3.1 в установке стенда, подробнее ниже. Типы поставляются с SDK. | [Одна stable-публикация за год](https://registry.npmjs.org/@excalidraw/excalidraw), 2026-04-20. [Master продолжает развиваться](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/CHANGELOG.md); возможности из Unreleased не засчитывались версии 0.18.1. |

Для npm считались доступные stable-версии в интервале 2025-10-27–2026-10-27; для maxGraph и JointJS — GitHub Releases соответствующей линии core. Эти числа показывают наличие выпусков, но не служат общей шкалой качества.

У React Flow по умолчанию есть ссылка на проект в углу холста. [ProOptions](https://reactflow.dev/api-reference/types/pro-options) документирует `hideAttribution` и прямо поясняет, что MIT не требует сохранять визуальную ссылку; авторы просят поддержать проект подпиской. Обязательного лицензионного водяного знака нет. Исходники [undo/redo](https://reactflow.dev/examples/interaction/undo-redo), [copy/paste](https://reactflow.dev/examples/interaction/copy-paste) и [expand/collapse](https://reactflow.dev/examples/layout/expand-collapse) относятся к Pro-примерам. В исследовании не использован их закрытый код: собственная реализация через открытые API остаётся отдельной работой.

### Редактирование и воспроизведение

| Кандидат | Узлы, связи и палитра | Навигация и операции редактора | Подписи и анимация | Автораскладка |
| --- | --- | --- | --- | --- |
| **React Flow** | [React-узлы](https://reactflow.dev/learn/customization/custom-nodes), [SVG-связи и Handle](https://reactflow.dev/learn/customization/custom-edges); [перенос из внешней палитры](https://reactflow.dev/examples/interaction/drag-and-drop) собирается приложением. | [MiniMap, Controls, Background](https://reactflow.dev/api-reference/components), pan/zoom, snapping и мультивыделение бесплатны. [Горячие клавиши](https://reactflow.dev/api-reference/react-flow) настраиваются; clipboard и история — свой код или Pro-примеры. | [HTML-подпись](https://reactflow.dev/learn/customization/edge-labels) допускает собственное поле по double-click. Цвет и толщина меняются через data/style. Есть бесплатный пример [частиц на SVG-пути](https://reactflow.dev/examples/edges/animating-edges). Часы воспроизведения и seek — приложение. | [Dagre и ELK подключаются отдельно](https://reactflow.dev/learn/layouting/layouting). Там же отмечено ограничение dagre для subflow со связями наружу; для будущих составных блоков следует проверить ELK. |
| **X6** | [SVG/HTML-формы и порты](https://x6.antv.antgroup.com/en/tutorial/about/), [React shape](https://x6.antv.antgroup.com/zh/tutorial/intermediate/react/). Бесплатный [Stencil](https://x6.antv.antgroup.com/en/tutorial/plugins/stencil/) даёт палитру с DnD. | [MiniMap](https://x6.antv.antgroup.com/en/tutorial/plugins/minimap/), pan/zoom, [grid](https://x6.antv.antgroup.com/en/api/graph/grid/), [Selection](https://x6.antv.antgroup.com/en/tutorial/update/), [History](https://x6.antv.antgroup.com/en/tutorial/plugins/history/), [Clipboard](https://x6.antv.antgroup.com/en/tutorial/plugins/clipboard/), [Keyboard](https://x6.antv.antgroup.com/en/tutorial/plugins/keyboard/) бесплатны; нужна настройка и связь с моделью приложения. | [edge-editor](https://x6.antv.antgroup.com/en/api/registry/edge-tool/) редактирует текст по double-click. Цвета/стили и [анимации](https://x6.antv.antgroup.com/en/tutorial/basic/animation/) доступны; [частица на связи](https://x6.antv.antgroup.com/en/examples/animation/usage/edge/) — официальный пример. Привязка к результатам и seek — приложение. | Внешние [Dagre](https://x6.antv.antgroup.com/en/examples/layout/general/dagre/) и [ELK с портами](https://x6.antv.antgroup.com/en/examples/showcase/practices/elk/), есть примеры интеграции. |
| **maxGraph** | [Собственные Shape-классы и HTML labels](https://maxgraph.github.io/maxGraph/docs/guides/extend-maxgraph/); [DragSource](https://maxgraph.github.io/maxGraph/api-docs/classes/DragSource.html) связывает свой UI палитры с графом. | Бесплатны [Outline](https://maxgraph.github.io/maxGraph/api-docs/classes/Outline.html), pan/zoom, snapping, selection, [UndoManager](https://maxgraph.github.io/maxGraph/api-docs/classes/UndoManager.html), Clipboard и KeyHandler. [Видимая сетка](https://github.com/maxGraph/maxGraph/blob/v0.25.1/packages/html/stories/Grid.stories.js) добавляется по примеру; это отдельно от snapping. | [Встроенный редактор ячейки](https://github.com/maxGraph/maxGraph/blob/v0.25.1/packages/core/src/view/mixin/EditingMixin.ts) вызывается по double-click. [Стили и анимированная линия](https://github.com/maxGraph/maxGraph/blob/v0.25.1/packages/html/stories/Animation.stories.ts) доступны; отдельные частицы и детерминированное воспроизведение — свой код. | Есть [HierarchicalLayout, tree и organic](https://maxgraph.github.io/maxGraph/api-docs/). Готовый dagre/ELK-адаптер в изученном API не найден; потребуется перенос координат из внешнего расчёта. |
| **JointJS core** | [SVG/HTML shapes](https://docs.jointjs.com/learn/features/customizing-shapes/) и React-узлы. Палитра через события drop — свой код; готовый [Stencil — Plus](https://docs.jointjs.com/learn/features/element-palette/). | [Paper](https://docs.jointjs.com/api/dia/Paper/) даёт grid/scale/translate. Полноценные жесты и команды надо собрать; [Navigator](https://docs.jointjs.com/learn/features/minimap/), [Selection](https://docs.jointjs.com/learn/features/selection/), CommandManager, Clipboard и Keyboard — Plus. | [Labels](https://docs.jointjs.com/learn/features/labels/) и double-click events открыты; ввод — своя форма, готовый [TextEditor — Plus](https://docs.jointjs.com/learn/features/inline-text-editing/). [Cell.transition](https://docs.jointjs.com/api/dia/Cell/#transition) и [LinkView.sendToken/getPointAtRatio](https://docs.jointjs.com/api/dia/LinkView/#sendToken) бесплатны; seek остаётся приложению. | Открытые [dagre-адаптер](https://docs.jointjs.com/learn/features/automatic-layouts/directed-graph/) и [@joint/layout-elk](https://github.com/clientIO/joint/blob/%40joint/layout-elk%404.3.4/packages/joint-layout-elk/README.md). ELK-пакет выпущен в день исследования; опыт его эксплуатации не проверяли. |
| **Rete.js** | [Свои React-узлы, сокеты и связи](https://retejs.org/docs/guides/renderers/react/); бесплатная палитра [Dock](https://retejs.org/docs/guides/dock-menu/). | [Area](https://retejs.org/examples/area-extensions/) даёт pan/zoom/snapping, сетка добавляется CSS; [MiniMap](https://retejs.org/docs/guides/minimap/), [selectable](https://retejs.org/docs/guides/selectable/) и [History с Ctrl+Z/Y](https://retejs.org/docs/guides/undo-redo/) открыты. Clipboard и история доменных параметров — свой код; исходник lasso/marquee-примера [Pro](https://retejs.org/examples/lasso-marquee-selection/). | [Подписи custom connections](https://retejs.org/examples/labeled-connections/) можно написать самим; исходник готового примера Pro. Цвет, double-click editor и частицы — свои компоненты поверх [SVG path](https://github.com/retejs/react-plugin/blob/e7c283e20db984be200a541ae8ff56e9a216d02a/src/presets/classic/components/Connection.tsx), воспроизведение — приложение. | [MIT auto-arrange на ELK](https://retejs.org/docs/guides/arrange/); версия плагина 2.0.2 объявляет peer ELK ^0.8.2, требуется сверка совместимости перед установкой. |
| **tldraw** | [Custom ShapeUtil](https://tldraw.dev/examples/custom-shape), [bindings](https://tldraw.dev/sdk-features/bindings), пример [DnD](https://tldraw.dev/examples/drag-and-drop). | SDK даёт pan/zoom/grid, selection, clipboard, [history](https://tldraw.dev/sdk-features/history) и shortcuts. [DefaultMinimap](https://tldraw.dev/reference/tldraw/DefaultMinimap) есть в 5.5.2. Лицензионный фильтр всё равно не пройден. | [Подписи стрелок](https://tldraw.dev/examples/arrow-labels), [animateShapes](https://tldraw.dev/sdk-features/animation); предметное редактирование параметров, seek и частицы требуют своих правил. | Готовый поддерживаемый dagre/ELK-адаптер в изученных источниках не найден; координаты можно менять через [Editor API](https://tldraw.dev/sdk-features/shapes). |
| **Excalidraw** | [Конечный набор типов фигур, customData и arrow bindings](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/element/types.ts). Вычислимые узлы, порты и палитра требуют адаптера к scene elements; это не API произвольных React-узлов. | [Встроены pan/zoom/grid, selection, clipboard, undo, shortcuts и библиотека фигур](https://github.com/excalidraw/excalidraw/blob/v0.18.1/README.md). Миникарта в stable API не найдена; [запрос функции открыт](https://github.com/excalidraw/excalidraw/issues/2184). | [Double-click редактирует штатный текст](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/components/App.tsx#L5353). [updateScene](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api) меняет стили; typed timeout/retry, частицы и воспроизведение — собственный слой. | Поддерживаемый dagre/ELK-контракт для редактируемого графа в изученном API не найден. [Импорт Mermaid](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/utils) не равнозначен такому контракту. |

### Иерархия, доступность и стоимость переноса

| Кандидат | Что даёт для вложенности | Рендеринг и проверки | Оценка переноса |
| --- | --- | --- | --- |
| **React Flow** | Бесплатный [parentId/subflow](https://reactflow.dev/learn/layouting/sub-flows) задаёт относительные координаты; родитель может иметь порты. Breadcrumb, свёртка выделения с переназначением граничных связей и связанные определения — свой код. | DOM для узлов и подписей, SVG для связей. Документированы [клавиатурная навигация, ARIA и live regions](https://reactflow.dev/learn/advanced-use/accessibility); [Playwright рекомендован авторами](https://reactflow.dev/learn/advanced-use/testing). Доступность собственного редактора всё равно проверяется отдельно. | **Низкая:** существующий холст сохраняется, новые возможности добавляются поверх текущих компонентов. |
| **X6** | [Parent/children, embedding и пример collapse/expand](https://x6.antv.antgroup.com/en/tutorial/intermediate/group/). Навигация между предметными подсистемами и библиотечные экземпляры — свой код. | SVG/HTML, React через адаптер. DOM-локаторы применимы; нужно учитывать [завершение рендеринга](https://x6.antv.antgroup.com/en/tutorial/basic/events/). [Keyboard](https://x6.antv.antgroup.com/en/tutorial/plugins/keyboard/) не доказывает наличие полной навигации и озвучивания для screen reader. | **Средняя для холста:** перенести события, визуальные узлы и тесты; согласовать mutable graph с React-состоянием. Больше готовых операций редактора. |
| **maxGraph** | Бесплатны [group/ungroup и enterGroup/exitGroup](https://github.com/maxGraph/maxGraph/blob/v0.25.1/packages/core/src/view/mixin/GroupingMixin.ts), а также [foldCells](https://maxgraph.github.io/maxGraph/api-docs/classes/BaseGraph.html#foldCells). Самая прямая готовая графическая навигация из рассмотренных альтернатив; [семантика портов](https://github.com/maxGraph/maxGraph/blob/v0.25.1/packages/core/src/view/mixin/PortsMixin.ts) настраивается приложением. | [SVG с HTML labels](https://maxgraph.github.io/maxGraph/docs/manual/); локаторы возможны. Полного документированного контракта ARIA/фокуса для редактора не нашли, его потребуется проверить и дополнить. | **Средняя для холста:** заменить React Flow на императивный GraphDataModel, согласовать события, историю и React lifecycle. Готовая библиотека не равна всему интерфейсу draw.io. |
| **JointJS core** | [Embedding и порты](https://docs.jointjs.com/learn/features/containers-and-grouping/) дают графическую вложенность. Collapse, drill-down, breadcrumb, маски и связанные экземпляры — приложение. | SVG/HTML; есть [официальный Playwright tutorial](https://docs.jointjs.com/learn/testing/playwright/). Roles, имена, фокус и клавиатурные операции собственного UI требуют отдельной проверки. | **Средняя для базового холста, высокая для полного редактора:** React-обёртка помогает сохранить компоненты, но многие требуемые UI-механизмы бесплатного core придётся написать. |
| **Rete.js** | Открытый рецепт [Modules](https://retejs.org/docs/guides/modules/) связывает отдельные графы через Input/Output и Module-узел. Это полезнее для предметной иерархии, чем запрещённый фильтром Scopes; маски, экземпляры, breadcrumb и collapse остаются приложению. | React/DOM-узлы и SVG-связи; есть [Chromium/Firefox/WebKit QA](https://retejs.org/docs/quality-assurance/). Полного ARIA/keyboard-контракта стандартного узла не нашли; собственные компоненты требуют проверки. | **Средняя/высокая:** editor/area/plugin state заменяет controlled React Flow; потребуется согласование истории и событий с reducer. Выигрыш для существующего проекта не доказан. |
| **tldraw** | [parentId, groups/frames и pages](https://tldraw.dev/sdk-features/parenting). [Страницы — отдельные сцены](https://tldraw.dev/sdk-features/pages); маски, портовая граница подсистемы и связанные определения — приложение. | [React/DOM-формы](https://tldraw.dev/sdk-features/shapes); есть [ARIA-descriptor и announcements](https://tldraw.dev/sdk-features/accessibility). Совместимость собственного UI с Playwright и screen reader не проверяли. | **Высокая, выбор исключён лицензией:** переход на store/shape/binding-модель белой доски. |
| **Excalidraw** | [groupIds хранит вложенные группы](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/element/types.ts), но [frame внутри frame исключён кодом 0.18.1](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/frame.ts#L529). Прикладные уровни можно хранить отдельно и переключать сцены; библиотека фигур не задаёт обновление связанных экземпляров. | [Основное поле — canvas](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/components/canvases/InteractiveCanvas.tsx#L149), панели и ввод — DOM. Для фигур нужны scene API, координаты и снимки; отдельных DOM-локаторов и доступных объектов на каждый вычислимый узел нет автоматически. | **Высокая:** собственные порты, связь сцен с моделью, ограничения допустимого рисования и доступное представление графа. |

Рекурсивные parent/child API позволяют описывать несколько уровней; практическая глубина и производительность больших вложений здесь не измерялись. «Неограниченная глубина» из видения означает отсутствие фиксированного продуктового лимита, а не обещание бесконечного объёма в памяти браузера. Полная предметная иерархия остаётся отдельной задачей при любом кандидате.

## Размер сборки

Для всех семи кандидатов собран отдельный минимальный entry в одинаковом окружении: Node.js `26.12.1`, npm `11.20.0`, React/DOM `19.3.1`, Vite `8.3.5`, ES2022, production, Oxc и Lightning CSS, без sourcemaps. React-компоненты используются в `root.render`; конструкторы доступны через `globalThis.createCanvas`, поэтому tree shaking не удаляет импорт. Общий baseline — `createRoot` с `div`.

Размеры ниже измерены по output-файлам. Единица — **KiB, 1024 байта**, ячейка содержит **minified / gzip-9**. Суммируется gzip каждого JS/CSS-файла отдельно, включая lazy chunks. Это минимальные входные точки с разным набором функций; таблица не оценивает полный редактор или скорость загрузки. У Excalidraw выпущено 164 JS-чанка: их сумма особенно сильно отличается от первой загрузки. HTML, отдельные шрифты и внешние ресурсы не включены. Для автокомпоновки редактора отдельные layout-пакеты не подключались; транзитивные chunks Excalidraw, включая dagre, уже входят в сумму.

| Entry | JS, KiB | CSS, KiB | Прирост JS+CSS к baseline, KiB |
| --- | ---: | ---: | ---: |
| React baseline | 214.0 / 66.0 | 0.0 / 0.0 | 0.0 / 0.0 |
| React Flow 12.12.0 | 388.9 / 122.1 | 15.1 / 2.5 | 189.9 / 58.6 |
| X6 3.1.8 | 773.1 / 224.7 | 0.0 / 0.0 | 559.1 / 158.7 |
| maxGraph 0.25.1 | 626.9 / 173.0 | 4.1 / 1.3 | 417.0 / 108.3 |
| JointJS core 4.3.4 | 627.7 / 189.0 | 0.0 / 0.0 | 413.7 / 123.0 |
| Rete 2.0.6 с renderer/area/connection | 318.2 / 95.8 | 0.0 / 0.0 | 104.2 / 29.8 |
| tldraw 5.5.2 | 2039.9 / 592.9 | 76.2 / 14.0 | 1902.1 / 540.9 |
| Excalidraw 0.18.1 | 7581.8 / 2486.0 | 138.8 / 21.7 | 7506.6 / 2441.6 |

Состав entry: React Flow с пустыми nodes/edges и `style.css`; X6 `Graph`; maxGraph `Graph` с `common.css`; JointJS `dia.Graph`, `dia.Paper`, `shapes.standard`; tldraw и Excalidraw со штатным CSS. У X6/JointJS стили входят в JS. Для Rete подключены `area-plugin@2.3.2`, `react-plugin@2.1.2`, `connection-plugin@2.0.5`, `render-utils@2.0.3`, `styled-components@6.6.0`, classic presets и один узел; minimap, history и прочие дополнительные плагины не включены. Поэтому меньший Rete entry не означает меньшего полного редактора. React-адаптеры X6 и JointJS в этой таблице не включены.

Все восемь сборок завершились с кодом 0. Скрипт проверки пересчитал размеры, SHA-256 файлов и дельты. Стенд сохранён локально в `/private/tmp/resilience-canvas-bundles/`: entry-файлы, `package-lock.json`, `run-builds.mjs`, `verify-results.mjs`, `results.json` и логи. SHA-256 lockfile: `02aefb1d7705bd0535a3b274575789cebf56cb92c6fcf94d3dc2eab1aad2c7d3`. После очистки временного каталога эти материалы недоступны; по условию задачи они не входят в PR.

### Проверки совместимости

1. Все семь импортов прошли отдельную TypeScript-проверку с `strict`, `moduleResolution: bundler` и проектным `skipLibCheck: true`. Фактический compiler — **6.0.3**: alias `@typescript/typescript6@6.0.2` подтягивает `@typescript/old`. Проверены импорты и декларации, а не полноценные приложения пяти кандидатов без прототипа.
2. В установленной среде исходного `web/node_modules` команда `.bin/tsc` указывает на `@typescript/native/bin/tsc` и сообщает **7.0.2**; `.bin/tsc6` сообщает **6.0.3**. Поэтому результат нельзя называть проверкой compiler 6.0.2. Прототипы React Flow, X6 и X6 React shape прошли обоими фактическими компиляторами с `skipLibCheck: true`. При `false` React Flow проходит, X6 и shape получают TS7016 из-за отсутствующих типов `lodash-es`.
3. Чистая сборка прототипа X6 3.1.8 сначала завершилась ошибкой `Could not resolve tslib`. [Manifest X6](https://registry.npmjs.org/@antv/x6/3.1.8) содержит `tslib` и `@types/lodash-es` только в devDependencies. Для успешной сборки стенда явно добавлен `tslib@2.8.1`; типы для обхода проверки не добавлялись. Общая установка нескольких библиотек может скрыть эту проблему транзитивной зависимостью.
4. Установка стенда размеров завершилась без `--force`, `--legacy-peer-deps` и overrides, но выдала peer warnings, а `npm ls --all` — код 1. Excalidraw 0.18.1 фиксирует `@radix-ui/react-tabs@1.0.2`, чьи [peers допускают React 16–18](https://registry.npmjs.org/@radix-ui/react-tabs/1.0.2); это расходится с собственным React 19 peer Excalidraw. Успешная сборка не устраняет конфликт и не доказывает runtime-совместимость.

## Прототипы и измерения

### Нагрузка и окружение

Стенд в `/private/tmp/resilience-canvas-prototype/` использует общий синтетический граф: сетка 10×5, карточки 112×54, две исходящие связи на узел, всего 50 узлов и 100 направленных связей. Геометрия постоянна; подпись связи — `120ms / 2r`. Цвет заливки, границы и связи определяется временем воспроизведения. В режиме с частицами по каждой связи движется один SVG-круг с периодом 2200 ms и фиксированным фазовым сдвигом. Часть подписей перекрывается, частицы могут проходить за узлами. Автораскладка и вычислительное ядро в нагрузку не входят.

React Flow обновляет controlled `useNodesState`/`useEdgesState` и memoized React-узлы со SVG-связями. X6 использует SVG-узлы и `cell.attr(...)` внутри `graph.batchUpdate(...)`, со **штатным `async: true`**. В режиме только стилей React Flow не создаёт circles, X6 сохраняет их с `visibility: hidden`. Это два небольших адаптера с одинаковой нагрузкой, но разными механизмами применения изменений.

Условия измерения:

- macOS `26.6.2`, Apple M4 Pro, 14 logical CPUs, 48 GiB RAM;
- Playwright `1.64.1`, headless Chromium `156.0.8078.4`, revision 1248;
- `chromium.launch({headless: true})`, renderer **ANGLE SwiftShader**, программная отрисовка;
- viewport 1440×960 CSS px, холст 1440×900, DPR 1, zoom 1; все 50 узлов внутри видимой области;
- Node.js `26.12.1`, npm `11.20.0`, Vite `8.3.5`, production build, без React StrictMode;
- CPU throttling, virtual time и Playwright clock отключены;
- 2.5 s прогрева, затем три окна примерно по 10.016 s для каждого адаптера и режима; всего 12 основных прогонов;
- прогоны последовательные, другие сборки завершены заранее; фоновые процессы macOS не изолированы.

Первоначальный X6 с `async: false` заменён штатной настройкой, после чего его функциональные проверки и шесть измерений повторены. React Flow использует результаты исходной серии; executable Chromium и условия одинаковы. Диагностика синхронного варианта сохранена отдельно и не включена в таблицу.

### Функциональный результат

В обоих адаптерах браузерные assertions проверили 50 видимых узлов, 100 связей с направлением и подписями, изменение цветов и положения частиц. Перемотка `0 → 750 → 0 ms` восстанавливает исходные свойства. Двойной клик меняет подпись узла и связи; ввод сделан через стандартный `prompt`, поэтому полноценный inline editor и его валидация не проверялись. Вход в дочерний граф из 5 узлов и 4 связей и возврат по breadcrumb сохраняют переименования. Console errors и page errors — 0.

Отдельная проверка `@antv/x6-react-shape@3.0.1` создала React-компонент на React `19.3.1`: кнопка-счётчик обработала три клика без ошибок. Основной замер X6 использует **SVG-узлы**; производительность 50 React shapes не измерялась. Произвольная глубина, маски, библиотечные экземпляры, inline-разворачивание, история и взаимодействие мышью во время playback также не проверялись.

### Частота обновления

Измеренная оценка fps — частота callback `requestAnimationFrame`: число межкадровых интервалов, делённое на их суммарную длительность. Все строки дали примерно **60.0 rAF/s**. Это наблюдаемый предел headless-цикла, не измерение частоты вывода на физический экран. p50/p95/p99 относятся к timestamp-интервалам rAF.

В таблице — медианы трёх прогонов, диапазон p95 и диапазон длительности задач; p99 — худший из трёх. Во всех 12 окнах p50 = 16.7 ms, интервалов больше 33.3 ms — 0 %, long tasks больше 50 ms — 0.

| Адаптер | Режим | rAF/s | p95, ms | p99, ms | CDP TaskDuration, s: медиана [min–max] |
| --- | --- | ---: | ---: | ---: | ---: |
| React Flow 12.12.0 | Стили | 60.0 | 16.7–16.8 | 16.8 | 2.032 [1.773–2.043] |
| React Flow 12.12.0 | Стили и 100 частиц | 60.0 | 16.7–16.8 | 16.8 | 2.383 [2.222–2.392] |
| X6 3.1.8, async:true | Стили | 60.0 | 16.7–16.8 | 16.8 | 5.830 [5.824–5.938] |
| X6 3.1.8, async:true | Стили и 100 частиц | 60.0 | 16.8 | 16.8 | 6.168 [6.095–6.312] |

`CDP TaskDuration` — длительность задач renderer/main-thread между двумя `Performance.getMetrics` вокруг окна измерения, включая небольшие расходы CDP. Это не CPU time и не процент использования процессора. В этом прототипе обновления React Flow занимали меньше времени задач, однако результат зависит от адаптера, scheduler и состава узлов. Он не устанавливает предельную скорость библиотек.

После измерений сняты отдельные трёхсекундные traces: в каждом режиме у обоих адаптеров есть Paint, 180 `DirectRenderer::DrawFrame` и меняющиеся screenshot frames. Это подтверждает реальную перерисовку стенда; traces не включены в числовую статистику и не доказывают аппаратный экранный FPS. Для пяти остальных кандидатов fps не измерялся.

### Артефакты и повторение

В каталоге прототипа сохранены исходники, lockfile, `results/performance.json` с 12 прогонами и исходными интервалами, `verification.json`, `typescript-checks.json`, `trace-summary.json`, сжатые traces и screenshots. SHA-256 lockfile: `b0b5e80f1fd6746c23953d5cbf757adc3af29717c6c640e40565f0a3bc473011`. По условию issue эти файлы не коммитятся; команды ниже применимы, пока локальный временный каталог сохранён. Методика и итоговые числа остаются в этом документе.

```sh
cd /private/tmp/resilience-canvas-prototype
fnm exec --using=26.12.1 npm ci --ignore-scripts --no-audit --no-fund
fnm exec --using=26.12.1 npx tsc6 --noEmit
python3 build.py
python3 -m http.server 4176 --bind 127.0.0.1 --directory dist
```

Из другого терминала в том же каталоге, последовательно:

```sh
fnm exec --using=26.12.1 node verify.mjs
fnm exec --using=26.12.1 node benchmark.mjs
fnm exec --using=26.12.1 node trace.mjs
```

При отсутствии Chromium сначала нужен `fnm exec --using=26.12.1 npx playwright install chromium`. После проверки сервер останавливается через Ctrl-C; сервер выполненного эксперимента уже остановлен. Стенд размеров повторяется отдельно командами `npm run build` и `npm run verify` под тем же Node.js в `/private/tmp/resilience-canvas-bundles/` после установки из его lockfile.

## Что остаётся приложению

Ни одна рассмотренная библиотека не задаёт семантику составного вычислимого блока из §5.7. Группирование решает расположение и совместное перемещение; порты подсистемы, маски параметров, обновление связанных экземпляров и разворачивание в плоскую вычислительную модель требуют предметных правил.

В дизайне #5 следует разделить сохраняемый сценарий, раскладку и временное состояние воспроизведения. Формат библиотеки холста не стоит делать единственным форматом сценария. Для этапа 2 нужны стабильные идентификаторы и способ адресовать узел внутри подсистемы; конкретный формат определяет #5. Для провала внутрь можно отображать текущий уровень и хранить путь для хлебных крошек. Отдельно требуется разворачивание подсистемы на месте: оно показывает несколько уровней на одном холсте и должно сохранять граничные связи, координаты и выбор. Оба режима требуют проверки больших моделей; прототип ниже проверяет только переход между уровнями.

История действий должна охватывать изменения модели и раскладки как одну пользовательскую операцию. Перетаскивание не должно создавать запись на каждый пиксель; воспроизведение результатов не должно попадать в undo. Копирование требует новых идентификаторов и переназначения внутренних связей. Эти правила нельзя получить одной установкой редакторского плагина.

Для воспроизведения нужен единый курсор симуляционного времени. Положение частицы и цвет объекта должны вычисляться из него: пауза и перемотка обязаны возвращать тот же кадр. Бесконечная CSS-анимация пунктирной связи сама по себе не представляет попытку, timeout или retry. Обычный `animated`-эффект подходит как украшение, а события запросов для #26 приходят из ограниченной выборки трассы.

## Влияние на следующие задачи

| Задача | Что учитывать в реализации |
| --- | --- |
| [#5 — дизайн](https://github.com/ChernetsovNG/resilience-lab/issues/5) | Утвердить выбор холста; разделить сценарий, раскладку и воспроизведение; определить историю действий и адресацию будущих вложенных блоков. |
| [#6 — каркас](https://github.com/ChernetsovNG/resilience-lab/issues/6) | Размер холста задаёт полноэкранная раскладка. Верхняя панель, палитра, инспектор и результаты остаются компонентами приложения. |
| [#7 — палитра и холст](https://github.com/ChernetsovNG/resilience-lab/issues/7) | Подключить миникарту, управление масштабом и выделение; добавить перенос из палитры, историю, копирование и горячие клавиши с учётом фокуса в полях. |
| [#8 — инспектор](https://github.com/ChernetsovNG/resilience-lab/issues/8) | Разрешить выбор связей, хранить выбранный объект и синхронизировать его параметры с формой. |
| [#9 — варианты](https://github.com/ChernetsovNG/resilience-lab/issues/9) | Сохранять раскладку по варианту и уровню; убрать сброс позиций при переключении. Страницы вариантов и уровни подсистем — разные измерения навигации. |
| [#11 — правка на схеме](https://github.com/ChernetsovNG/resilience-lab/issues/11) | Добавить подпись связи с редактором по двойному клику, ввод с клавиатуры и общую валидацию с инспектором. |
| [#15 — результаты на схеме](https://github.com/ChernetsovNG/resilience-lab/issues/15) | Проецировать метрики на цвет, толщину и подписи. Добавить текстовое обозначение состояния, чтобы смысл не зависел только от цвета. |
| [#25 — воспроизведение](https://github.com/ChernetsovNG/resilience-lab/issues/25) | Общий курсор времени с Timeline, пауза, скорость и seek; обновлять визуальное состояние без изменения сценария и истории. |
| [#26 — частицы](https://github.com/ChernetsovNG/resilience-lab/issues/26) | Привязать положение частицы к пути связи и времени события, ограничить одновременно отображаемую выборку; повторить замер на настоящих трассах. |

## Ограничения и условия пересмотра

Главный риск сохранения React Flow — объём собственной логики редактора. Нужно проверить историю составных действий, копирование со сменой идентификаторов, редактирование чисел на связях и свёртку подсистем с сохранением портов. Pro-примеры не должны превращаться в неявную зависимость публичного проекта.

Для этапа 2 остаются непроверенными глубокая иерархия, разворачивание нескольких уровней на месте, библиотечные экземпляры и большие выборки частиц. Общий прототип с 50 простыми узлами не гарантирует ту же частоту кадров с тяжёлыми React-компонентами, инспекторами, панелями результатов и реальными трассами. Нужна повторная проверка целого UI на целевых устройствах; число одновременно видимых элементов важнее одного только числа уровней.

Пересматривать выбор стоит при воспроизводимом ограничении React Flow на необходимом сценарии или если оценка реализации операций редактора покажет, что перенос на X6/maxGraph дешевле. Перед миграцией потребуется прототип именно этого ограничения: тот же сценарий, доступные имена и клавиатура, полная модель истории, вложенные порты и одинаковые условия измерения. По текущему исследованию оснований менять библиотеку уже сейчас нет.
