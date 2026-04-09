# Решения реализации

Журнал принятых проектных решений по реализации COIL Sandbox:

- архитектура host-среды,
- интеграция с coil-runtime и coil-ide,
- web-интерфейс и визуализация.

## Как ведётся этот журнал

Каждое решение получает сквозной номер `S-NNNN`.

| Статус | Значение |
|---|---|
| `принят` | Решение зафиксировано, реализация следует ему. |
| `принят как направление` | Выбор сделан, детали уточняются по ходу реализации. |
| `заменён S-NNNN` | Решение заменено указанным. |

Процесс:
1. Принять решение → присвоить следующий `S-NNNN`, записать мотивацию, статус `принят`.
2. Заменить решение → старому присвоить `заменён S-NNNN`, новому — свой `S-NNNN`.

---

## S-0001 — Просмотрщик агентов в Web-UI: React-«остров» поверх vanilla

| | |
|---|---|
| **Статус** | принят как направление |
| **Решено** | 2026-04-09 |
| **Scope** | coil-sandbox/src/web/**, coil-sandbox/package.json |
| **Связан с** | I-0004, I-0006 в `coil-ide/DESIGN.md` |

**Контекст.** Sandbox получает фичу показа исходного кода агента в Web-UI: клик по имени агента в sidebar → панель с кодом агента, с переключением между COIL-C (подсвеченный текст) и COIL-H (таблица). Обе проекции уже реализованы в coil-ide как React-компоненты поверх Monaco и собственного рендера таблицы. Текущий sandbox web-UI (`src/web/public/index.html`) — vanilla JS, раздаётся статикой через Express. React, Vite, Monaco в sandbox отсутствуют.

Рассматривались три варианта интеграции:
- **A.** Полный перевод sandbox web-UI на React/Vite. Переписывается весь `index.html` (каналы, посты, threads, server switcher). Большой объём работы, не относящейся к цели фичи.
- **B.** React-«остров» поверх существующей vanilla-страницы. Отдельный Vite-bundle для нового кода, подключается к `index.html` как `<script type="module">`, монтируется в конкретный DOM-узел. Остальная страница остаётся vanilla и не трогается.
- **C.** Использовать только headless-часть пакета coil-ide (`astToCoilH`, `parse`, `validate`), рендерить таблицу и подсветку на vanilla с нуля. Теряется переиспользование готовых компонентов — одна из целей работы.

**Решение.** Вариант B.

Структура:
```
coil-sandbox/
  src/web/
    public/
      index.html            — существующий vanilla UI (минимальная правка: добавляется <div id=...>)
      agent-viewer.js       — артефакт Vite-сборки
      agent-viewer.css
    viewer/                 — новый TS/TSX код viewer'а
      main.tsx              — entry, монтирует React в #agent-viewer-root
      AgentViewer.tsx       — использует CoilHTable и EditorPanel из пакета coil-ide
    vite.viewer.config.ts   — Vite-конфиг только для viewer'а (library mode / single-entry build)
  package.json              — добавляется скрипт build:viewer и devDeps (vite, @vitejs/plugin-react)
```

Пакет coil-ide подключается как git-зависимость:
```json
"dependencies": {
  "coil-ide": "github:animata-systems/coil-ide"
}
```
Единообразно с тем, как sandbox уже подключает `coil` и `coil-runtime`.

Протокол взаимодействия vanilla ↔ viewer:
- в `index.html` добавляется `<div id="agent-viewer-root"></div>` (панель рядом с основным контентом);
- viewer-бандл при загрузке регистрирует на `window` функцию `openAgentViewer(agentName: string)` или подписывается на кастомное DOM-событие;
- существующий vanilla-handler клика по агенту в sidebar вызывает эту функцию;
- viewer через socket-клиент (reuse общего socket.io соединения) запрашивает исходник агента (событие `get-agent-source` — серверный контракт описан отдельно в `src/web/server.ts`) и рендерит его через `CoilHTable` и `EditorPanel` из coil-ide.

**Почему.**
- Vanilla UI продолжает работать без регрессий: он не переписывается, только расширяется одной точкой монтирования.
- Весь React-код изолирован одним бандлом с явной точкой входа — легко понять, где кончается vanilla и начинается React.
- Паттерн потребления coil-ide (git-зависимость) единообразен с существующими зависимостями sandbox.
- Это первый внешний потребитель пакета coil-ide (I-0004) — даёт немедленную обратную связь о корректности границы библиотеки.

**Цена.**
- В sandbox появляется второй билд-путь: `tsc` для серверного кода + Vite для viewer-бандла. Новый скрипт `build:viewer`, новые devDeps (`vite`, `@vitejs/plugin-react`, возможно `tailwindcss`, если viewer тянет стили из пакета).
- Размер бандла: Monaco — тяжёлый. Mitigate: ленивая загрузка viewer'а только по первому открытию панели, не при старте страницы.
- Дисциплина: ничего не должно пересекать границу vanilla ↔ React бандла, кроме согласованного протокола событий. Общее состояние — только через события/props, не через мутации DOM с обеих сторон одного узла.

**Область применения.** Это решение описывает только механику встраивания React-компонентов в sandbox web-UI. Конкретная фича (читать код агента, переключать COIL-C ↔ COIL-H) — работа интеграционных задач, не зона DESIGN.md.

---

## S-0002 — Изоляция Tailwind preflight от vanilla UI через unlayered CSS

| | |
|---|---|
| **Статус** | принят |
| **Решено** | 2026-04-09 |
| **Scope** | `src/web/public/index.html`, `src/web/viewer/**`, `src/web/vite.viewer.config.ts` |
| **Связан с** | S-0001, I-0008 в `coil-ide/DESIGN.md` |

**Контекст.** Viewer-бандл (S-0001) собирается с Tailwind v4 через `@tailwindcss/vite` и `@import "tailwindcss"` в `viewer.css`. Tailwind v4 эмитит preflight (reset для `*`, `button`, `input`, `h1–h6`, margin/padding, border-style) в `@layer base`, а утилиты — в `@layer utilities`. Получившийся `agent-viewer.css` подключается на vanilla sandbox-странице через `<link rel="stylesheet" href="/agent-viewer.css">`, рядом с inline-`<style>`-блоком в `index.html`, где живут vanilla-стили (фон, сетка, буквы, кнопки, inputs).

Первый встроенный мысленно-очевидный риск: preflight «снесёт» vanilla UI — кнопки, заголовки, inputs потеряют свои стили и вернутся к браузерным дефолтам. Mitigation планировался через `corePlugins.preflight: false` в Vite-конфиге (задача 5.2). При интеграционной проверке обнаружилось, что vanilla UI **не ломается**, хотя preflight в `agent-viewer.css` присутствует в эмитированном виде.

**Решение.** Vanilla sandbox-стили в `index.html` остаются в **unlayered** `<style>`-блоке (без обёртки в `@layer`). Preflight и утилиты viewer'а живут в named `@layer` (`base`, `utilities`). По CSS cascade-семантике unlayered rules принадлежат «базовому» origin и всегда выигрывают у любых `@layer`-правил того же origin, независимо от порядка загрузки и source-order. Поэтому vanilla CSS автоматически перекрывает preflight.

`preflight: false` **не применяется**. В Tailwind v4 preflight включается через `@import "tailwindcss"` в CSS, а не через конфиг — отключать его пришлось бы через выборочный импорт (`@import "tailwindcss/theme"` + `@import "tailwindcss/utilities"` без `preflight`), что усложняет CSS-зависимости бандла без реальной пользы.

Инвариант оформлен двумя способами:
- **Комментарий-warning** прямо над `<style>`-блоком в `src/web/public/index.html`, объясняющий, что блок должен оставаться unlayered, и предупреждающий против обёртки в `@layer`.
- **Эта запись** фиксирует инвариант на уровне архитектурного журнала.

**Почему.**
- Не требует кода вообще: работает за счёт свойства CSS cascade, а не за счёт mitigation'а.
- Альтернативы дороже: `preflight: false` в v4 требует выборочной сборки Tailwind; scope-префикс через PostCSS ломает developer experience внутри viewer'а (каждый класс становится нестандартным); shadow DOM несовместим с Monaco editor и React portal'ом; вынос viewer в iframe ломает shared socket.io и добавляет межфреймовую коммуникацию.
- Решение «дегенерируется мягко»: если в будущем придётся убрать Tailwind из viewer'а или заменить на shadow-scoped CSS, никакая специфическая логика не будет «висеть в воздухе» — инвариант перестаёт быть нужным сам собой.

**Цена.**
- **Защита хрупкая.** Она держится на одном свойстве одного `<style>`-блока. Если кто-то в будущем обернёт vanilla-стили в `@layer`, или добавит в sandbox ещё один бандл с preflight'ом в unlayered origin, или переедет с inline `<style>` на подключаемый CSS внутри `@layer` — vanilla UI начнёт получать reset и сломается. Warning-комментарий в HTML закрывает самый вероятный сценарий (авторефакторинг CSS), но не все.
- **Нет автоматического теста.** Инвариант проверяется вручную при каждом значимом изменении viewer'а или vanilla UI. Регрессионный тест можно добавить позже (например, проверять, что `getComputedStyle(document.querySelector('.sidebar h3')).marginTop !== '0px'` не сломался), но для первой итерации это over-engineering.
- **Зависимость от Tailwind-внутренностей.** Решение полагается на то, что Tailwind v4 эмитит preflight именно в named layer, а не в unlayered origin. Теоретически апгрейд Tailwind может это изменить. Mitigation: при следующем апгрейде перечитать эту запись и прогнать ручную проверку.

**Проверено.** `bg-ide-panel` → `rgb(18,18,20)` = #121214, `text-foreground` → `rgb(200,200,200)` = #c8c8c8 внутри viewer'а (dark-тема coil-ide через I-0008). Snапру снаружи: `.sidebar` → `rgb(18,18,26)`, `button.icon-btn` → `rgb(10,10,15)` на Inter, `input#postInput` → стили sandbox'а без изменений. `.dark` класс висит только на `#agent-viewer-root > div.dark`, не на `<html>`/`<body>`.

---

## S-0003 — Vite library-mode требует явной подстановки `process.env.NODE_ENV`

| | |
|---|---|
| **Статус** | принят |
| **Решено** | 2026-04-09 |
| **Scope** | `src/web/vite.viewer.config.ts` |
| **Связан с** | S-0001 |

**Контекст.** Viewer-бандл (S-0001) собирается в Vite library-mode (`build.lib`, `appType: 'custom'`, `formats: ['es']`) и подключается напрямую на vanilla-странице через `<script type="module" defer src="/agent-viewer.js"></script>`. В обычном app-билде Vite автоматически делает substitution `process.env.NODE_ENV` → `"production"` и убирает guard'ы вида `if (process.env.NODE_ENV !== 'production')` из React и зависимостей. В library-mode Vite **не делает** этой подстановки по умолчанию — он предполагает, что потребитель библиотеки (родительский бандлер) сделает substitution сам.

В нашем случае потребителя у бандла нет — он грузится напрямую браузером. Результат: React 19 и другие зависимости содержат раннер-проверки `process.env.NODE_ENV`, при первом обращении браузер падает с `ReferenceError: process is not defined` ещё до инициализации React.

**Решение.** В `vite.viewer.config.ts` установлен:
```ts
define: {
  'process.env.NODE_ENV': JSON.stringify('production'),
},
```
Это форсит Vite сделать substitution на этапе rollup-трансформа, несмотря на library-mode. Фикс задокументирован многострочным комментарием в самом конфиге.

**Почему.**
- Альтернативы хуже: (1) shim `window.process = { env: { NODE_ENV: 'production' } }` на vanilla-странице перед загрузкой viewer'а — хрупко, ломается при смене entry point или dynamic import, оставляет глобальный `process` в `window`; (2) маркировать React как external и грузить его отдельным `<script>` — добавляет ещё один сетевой round-trip, ещё один `<script>`-тег в `index.html` и требует версионной синхронизации с coil-ide peerDep; (3) отказ от library-mode в пользу regular `build` с `input` — ломает контракт на фиксированное имя бандла и требует пересборки `index.html` на каждый билд.
- Текущее решение — одна строка в конфиге, эффект локализован.
- Размер бандла после фикса сократился с 848 КБ raw (unsubstituted — в бандл попал React dev с дополнительными проверками и warning'ами) до 340 КБ raw / 87.57 КБ gzipped. Запас от бюджета 500 КБ gzipped — 5.7×.

**Цена.**
- **Бандл жёстко зафиксирован в `production`-режиме.** React DevTools в нём работают ограниченно, dev-предупреждения React не видны, `act()` warnings не появляются. Для read-only viewer'а это приемлемо: весь код сводится к fetch source → parse → render, интерактивной логики, которую стоило бы отлаживать с DevTools, нет.
- **Ловушка повторится при любой новой библиотечной сборке.** Если в будущем появится второй Vite library-mode бандл в sandbox или в другом подмодуле, где React/Redux/другие зависимости используют `process.env.NODE_ENV`-guard'ы, — его придётся собирать с тем же `define`. Mitigation: эта запись фиксирует паттерн в журнале, чтобы при следующем случае он нашёлся поиском.
- **Связанность с Vite-версией.** Если поведение Vite library-mode изменится (например, в v9 по умолчанию начнёт делать substitution), `define` окажется дубликатом. Безвредным, но лишним. Не блокер — при апгрейде Vite стоит проверить.
