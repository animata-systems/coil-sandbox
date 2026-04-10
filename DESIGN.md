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

---

## S-0004 — Dialect определяется по аннотации `@dialect`, default — `en-standard`

| | |
|---|---|
| **Статус** | принят |
| **Решено** | 2026-04-10 |
| **Scope** | `src/utils/detect-dialect.ts`, `src/engine/protocol-runner.ts`, `src/web/viewer/AgentViewer.tsx`, `cli/index.ts` |
| **Связан с** | S-0001, R-0002 в `coil-runtime/DESIGN.md` |

**Контекст.** До этого решения sandbox определял диалект одним способом: CLI-флаг `--dialect <path>` или default (`ru-standard`). Viewer (S-0001) использовал cascade-try — пытался парсить исходник всеми доступными диалектами из `dialectRegistry` и брал первый, который не вернул ошибку. Это приводило к двум проблемам: (1) при полном провале cascade возвращал ошибку от primary-диалекта (`en-standard`), даже если другой диалект продвинулся дальше — пользователь видел нерелевантную ошибку; (2) default `ru-standard` в CLI означал, что `en-standard`-файлы без явного `--dialect` не парсились.

Рассматривались два варианта:
- **A.** Content-aware auto-detection по первым ключевым словам (распознать `ПОЛУЧИ` vs `RECEIVE`). Требует поддержки всех диалектов, хрупко при пересечении ключевых слов между диалектами.
- **B.** Явная аннотация `' @dialect <name>` в заголовке .coil файла. Формат уже используется в `coil/tests/` и `coil/examples/` для тестовой инфраструктуры (`suite.test.ts`, R-0030).

**Решение.** Вариант B.

Утилита `detectDialect(source: string): string | null` сканирует ведущие строки-комментарии (`'`) на паттерн `' @dialect <name>`. Возвращает имя диалекта или `null`. Останавливается на первой непустой, не-комментарной строке.

Три точки интеграции:

1. **protocol-runner** (`src/engine/protocol-runner.ts`): перед `tokenize` вызывает `detectDialect(freshSource)`. Если найден — резолвит путь к JSON через `resolveDialectPath(name)` → `loadDialect(path)`. Если не найден — использует `ctx.dialectPath` (default из CLI).

2. **viewer** (`src/web/viewer/AgentViewer.tsx`): `detectDialect(source)` → имя найдено → `dialectRegistry.get(name)`. Не найдено → `dialectRegistry.get(DEFAULT_DIALECT)`. Один вызов `parseOnce`. Cascade-try (`parseWithFallback`) удалён.

3. **CLI default** (`cli/index.ts`): `resolveDefaultDialect()` возвращает `en-standard` вместо `ru-standard`.

Файлы `.coil` с русским диалектом (`wizard.coil`, `echo.coil`) получают аннотацию `' @dialect ru-standard` первой строкой.

**Почему.**
- Аннотация — уже существующая конвенция (`coil/tests/README.md`, R-0030 в `coil-runtime/DESIGN.md`). Не вводит новый формат.
- Определение диалекта — детерминированное и дешёвое (regex по первым строкам, без парсинга).
- `en-standard` как default согласуется с `DEFAULT_DIALECT` в `coil-ide` и с тем, что COIL — открытый проект с английским как базовым диалектом.
- Cascade-try удалён — пользователь видит ошибку от правильного диалекта, а не от первого попавшегося.

**Цена.**
- **Каждый `.coil` файл с не-`en-standard` диалектом обязан иметь аннотацию.** Без неё — парсится как `en-standard` и падает. Mitigation: все текущие файлы arena аннотированы. Будущие файлы — ответственность автора.
- **`modelPreamble` в protocol-runner жёстко использует `ОПРЕДЕЛИ` (русский keyword).** При `en-standard`-диалекте без `@dialect` преамбула не распознается. Закрыто фазой 3 (S-0005): преамбула удалена, модели подставляются через inline ПОЛУЧИ.

---

## S-0005 — Inline ПОЛУЧИ: routing по `variableName`, удаление ОПРЕДЕЛИ-преамбулы

| | |
|---|---|
| **Статус** | принят |
| **Решено** | 2026-04-10 |
| **Scope** | `src/engine/protocol-runner.ts`, `src/providers/channel-provider.ts`, `apps/arena/agents/*.coil` |
| **Связан с** | S-0004, STORY-016 фаза 3 |

**Контекст.** До этого решения protocol-runner генерировал ОПРЕДЕЛИ-преамбулу для каждого model alias из `config.yml` и подклеивал её перед исходником агента. Это создавало три проблемы: (1) преамбула использовала русские keywords (`ОПРЕДЕЛИ`, `КОНЕЦ`), что ломало парсинг при `en-standard` диалекте без `@dialect`-аннотации; (2) переменные моделей появлялись в scope неявно — автор `.coil`-файла не видел, откуда `$fast` получил значение; (3) все ПОЛУЧИ одинаково резолвились в trigger message, без различия по имени переменной.

Фаза 1 STORY-016 добавила `variableName` и `prompt` в `YieldDetail` для receive (R-серия). Это дало sandbox'у информацию, необходимую для routing'а.

**Решение.** ОПРЕДЕЛИ-преамбула удалена. Inline ПОЛУЧИ (форма без тела, `prompt === null`) резолвится по `variableName` в следующем приоритете:

1. **`message`** — trigger envelope: `{body, from, to, channel, datetime, replyTo}`.
2. **`thread`** — массив сообщений треда (root post + comments), хронологически: `[{body, from, to, channel, datetime, replyTo}, ...]`.
3. **Model alias** — если `variableName` совпадает с ключом в `config.models`, resume с model value string (например `openai/gpt-5.4-nano`).
4. **Unknown** — лог ошибки, протокол останавливается.

Block ПОЛУЧИ (`prompt !== null`) — заглушка: лог «not yet supported», протокол останавливается. Реализация — фаза 4.

Метод `getThread(rootPostId, channel)` добавлен в `SandboxChannelProvider`. Фильтрует по `id === rootPostId || commentOn === #channel/rootPostId`, сортирует по datetime.

`.coil`-файлы арены обновлены: `ПОЛУЧИ message КОНЕЦ` → `ПОЛУЧИ message` (inline), добавлены `ПОЛУЧИ fast/smart/coder` перед первым ДУМАЙ.

**Почему.**
- Built-in ресурсы (`message`, `thread`) проверяются первыми — host-контракт не может быть затенён пользовательским model alias. Если config.yml объявит модель `message`, она будет проигнорирована в пользу trigger envelope.
- Inline ПОЛУЧИ делает зависимости агента от среды **явными**: автор видит `ПОЛУЧИ fast` и понимает, что `$fast` приходит из host-среды, а не определён в скрипте.
- Routing централизован в одной точке yield/resume loop — нет отдельных веток для моделей, сообщений, треда в разных частях runner'а.

**Цена.**
- **Порядок ПОЛУЧИ в скрипте влияет на порядок yield'ов.** Executor yield'ит на каждом ПОЛУЧИ последовательно. Protocol-runner resume'ит каждый мгновенно (для inline), но порядок важен при дебаге — логи будут показывать yields в порядке объявления.
- **Список built-in ресурсов жёстко закодирован** (`message`, `thread`). Добавление нового built-in ресурса требует правки routing'а. Если количество ресурсов вырастет, стоит вынести в реестр. Для двух — YAGNI.
- **Block ПОЛУЧИ временно нефункционален.** ~~Протокол с блочным ПОЛУЧИ молча останавливается до фазы 4.~~ Закрыто S-0006.

---

## S-0006 — Block ПОЛУЧИ: интерактивный промпт пользователю через Socket.IO

| | |
|---|---|
| **Статус** | принят |
| **Решено** | 2026-04-10 |
| **Scope** | `src/engine/protocol-runner.ts`, `src/engine/sandbox.ts`, `src/web/server.ts`, `src/web/public/index.html` |
| **Связан с** | S-0005, STORY-016 фаза 4 |

**Контекст.** S-0005 оставил block ПОЛУЧИ (форму с телом-промптом) нефункциональным — протокол останавливался при встрече `prompt !== null`. Фаза 4 STORY-016 требует: если протокол запущен пользователем и встретил block ПОЛУЧИ — показать промпт в UI, собрать ответ, resume с ним. Если запущен агентом — resume с пустой строкой.

**Решение.** Callback-архитектура: protocol-runner не знает о транспорте.

Три слоя:

1. **`ProtocolContext.onPromptUser`** — опциональный callback `(agentName: string, prompt: string) => Promise<string>`. Protocol-runner вызывает его при `prompt !== null && triggerMessage.from === '@user'`. При agent-triggered — resume с `{ type: 'ReceiveValue', value: '' }`.

2. **`Sandbox.setPromptHandler`** — setter, аналогичный `setLogger`. Server.ts подставляет реализацию. Sandbox передаёт callback в `ProtocolContext` при создании.

3. **Socket.IO мост** (`server.ts`): `pendingPrompts: Map<string, (value: string) => void>`. Prompt handler генерирует `requestId` (UUID), emit'ит `'agent-prompt'` с `{ agentName, prompt, requestId }`, ждёт `'agent-prompt-reply'` с `{ requestId, value }`. Клиент показывает inline-промпт в текущей области сообщений.

**Таймаут** (`НЕ БОЛЕЕ`): `timeoutMs` добавлен в `YieldDetail` для receive (coil-runtime, R-серия). Protocol-runner использует `Promise.race` с `setTimeout`. При таймауте resume с `{ type: 'Timeout' }` → executor бросает `ExecutionError`. Timer очищается через `clearTimeout` в `finally` при успешном ответе. Sentinel — `Symbol('prompt-timeout')`, не строковый матч.

**Клиент** (`index.html`): обработчик `socket.on('agent-prompt', ...)` создаёт DOM-элемент с заголовком `'{agentName} asks:'`, текстом промпта, input + Reply. После ответа — элемент заменяется статическим подтверждением с галочкой.

**Почему.**
- Callback в ProtocolContext — единственная точка связи между runner'ом и транспортом. Runner не знает о Socket.IO, серверах, DOM.
- `setPromptHandler` по аналогии с `setLogger` — консистентный паттерн. Не требует изменения конструктора Sandbox.
- `requestId` (UUID) — для корректного матча в случае нескольких одновременных промптов от разных агентов.

**Цена.**
- **`pendingPrompts` без cleanup.** Если пользователь не отвечает и таймаута в COIL нет, entry висит вечно. Protocol-runner тоже висит. Это соответствует спеке («не продолжается, пока значение не получено»), но map растёт. Cleanup при disconnect сокета — возможное улучшение.
- **Broadcast.** `io.emit('agent-prompt', ...)` отправляет всем подключённым клиентам. Любой из них может ответить. Для single-user sandbox приемлемо; при многопользовательском сценарии потребуется адресная доставка по socket id.
- **Agent-triggered → пустая строка.** Story-критерий говорит «resume с null», реализация — с `''`. `ReceiveValue.value` типизирован как `string`, `null` — type violation. Пустая строка корректна по completion contract спеки.

---

## S-0007 — Модели описываются URI-форматом `llm://provider/model-id?params`

| | |
|---|---|
| **Статус** | принят |
| **Решено** | 2026-04-10 |
| **Scope** | `src/providers/model-provider.ts`, `apps/arena/config.yml` |
| **Связан с** | S-0005, STORY-016 фаза 5 |

**Контекст.** До этого решения модели описывались как `provider/model-id` (например `openai/gpt-5.4-nano`). Формат не предусматривал параметров — `reasoning` effort, temperature и т.д. нельзя было указать в конфиге. Кроме того, формат совпадал с обычным путём файловой системы, что затрудняло программное отличие «это модель» от «это путь».

**Решение.** URI-формат `llm://provider/model-id?params`:
- **scheme** `llm://` — фиксированный, обязательный. Однозначно идентифицирует строку как модельную ссылку.
- **host** — провайдер (`openai`, `anthropic`, …).
- **path** — идентификатор модели (`/gpt-5.4-nano`, `/claude-sonnet-4-5-20250514`).
- **query** — параметры. Поддержан `reasoning` (`none`, `low`, `medium`, `high`).

Парсинг через `new URL(uri)`. Валидация всех URI при создании `SandboxModelProvider` (ранняя ошибка при старте приложения, не при первом вызове модели). Маппинг `reasoning` в AI SDK `providerOptions`: для OpenAI — `{ openai: { reasoningEffort: value } }`.

Старый формат `provider/model-id` не поддерживается — единый путь через URI-парсинг. Fallback и dual-format намеренно исключены.

`config.yml` мигрирован:
```yaml
models:
  fast: llm://openai/gpt-5.4-nano
  smart: llm://openai/gpt-5.4-mini?reasoning=medium
  coder: llm://openai/gpt-5.4?reasoning=high
```

**Почему.**
- URI — стандартный формат (RFC 3986), парсится `new URL()` без кастомных регулярок.
- Scheme `llm://` делает строку самодокументирующейся: видно, что это модель, а не путь и не произвольная строка.
- Query params — расширяемый механизм: новые параметры добавляются без изменения формата и парсера.
- Один формат вместо двух — один путь отказа, нет двусмысленности «это старый формат или новый?».

**Цена.**
- **Breaking change.** Все `config.yml` должны быть мигрированы. Обратная совместимость со старым форматом намеренно отсутствует.
- **Значение `reasoning` не валидируется sandbox'ом** — передаётся в AI SDK as-is. Невалидное значение вызовет ошибку от провайдера при вызове, а не при старте. Для sandbox-контекста это приемлемо: набор значений зависит от провайдера и может меняться.
- **Маппинг `reasoning` provider-specific.** Для OpenAI — `reasoningEffort`, для остальных — generic `reasoning`. При добавлении Anthropic или других провайдеров с нестандартным маппингом потребуется расширить `buildProviderOptions()`.
