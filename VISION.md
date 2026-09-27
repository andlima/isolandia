# isolandia — Visão e decisões iniciais

> Documento-memória para apoiar a escrita das primeiras specs.
> Não é uma spec: registra o *porquê*, as decisões já tomadas e as
> perguntas em aberto. Atualize-o quando uma decisão mudar.

## 1. Objetivo

Um engine **data-driven** para RPGs open world em **perspectiva isométrica**,
na linha de *Project Zomboid*: simulação sistêmica (necessidades, tempo,
loot, IA, crafting) num mundo persistente baseado em grade de tiles.

O diferencial buscado: criar mundos de **gêneros completamente diferentes**
(zumbi, vampiro, velho oeste, noir…) **do zero**, essencialmente com
**assets + arquivos declarativos de configuração**, com pouca necessidade
de scripts. Trocar de gênero deve significar trocar de *pack*, não de código.

Meta realista: **80–90% declarativo**, com uma porta de saída (hooks de
script sandboxed) para o restante. Não é objetivo igualar o Zomboid em
escopo.

## 2. Origem: lições do `rogue-engine`

Projeto irmão em `~/code/rogue-engine` — roguelike por turnos, ASCII,
totalmente definido em YAML. Serve de prova de conceito do modelo
declarativo.

**Reaproveitar (conceitos, e possivelmente código portado):**

| Conceito | Onde está no rogue-engine | Uso aqui |
|---|---|---|
| Measurements genéricas (`hp` é só mais uma) | `docs/schema.md`, `src/runtime/state.js` | Fome, sangue, reputação, suspeita… tudo é measurement |
| Linguagem de expressões | `src/expressions/`, `docs/expressions.md` | Condições e fórmulas em todo o schema |
| Pipeline de efeitos | `src/runtime/effects.js` | Base do vocabulário de efeitos (a ser ampliado) |
| Interaction flows | `src/runtime/flow.js`, `docs/interaction-flows.md` | Menu de contexto (clique direito) e targeting |
| Tags + validação no load | `src/config/loader.js` | Ainda mais crítico com mods empilhados |
| Renderer ASCII | `src/renderer/ascii.js` | Debug/testes da simulação antes do isométrico |
| Fluxo spec-driven com agentes | `AGENTS.md`, `.spec.toml`, `specs/` | Mesmo fluxo neste repo |

**Não reaproveitar:**

- `dispatch(state, action)` **imutável por turno** — não escala para ticks
  contínuos com centenas/milhares de entidades.
- **Mapas como strings ASCII** — ok para fixtures de teste, não para o mundo.

**Alerta aprendido:** YAML tende a virar uma linguagem de programação ruim.
Ex.: o shrine em `games/pirate.yaml` repete `when: 'actor.doubloons >= 5'`
em cinco efeitos. Defesa: **primitivos ricos** (systems, behaviors, recipes,
loot tables, dialogues, statuses) em vez de controle de fluxo genérico
cada vez mais poderoso; e aceitar hooks de script quando o YAML ficar pior
que código.

## 3. Decisões tomadas

1. **Stack: TypeScript.** Simulação em TS puro; renderer com **PixiJS**
   (WebGL); jogo servível a partir de um HTML. Desktop depois via
   **Tauri** (ou Electron) embrulhando o mesmo build, se necessário.
   - Motivo principal: o fluxo spec-driven com agentes funciona melhor com
     tudo em texto, testes headless em Node (`node:test`) e verificação
     visual via Playwright.
   - Godot foi considerado (também exporta para web, tem ótimo editor e
     melhor desempenho), mas num engine data-driven o editor seria em
     grande parte contornado. Se um dia migrar, **specs, schema e packs
     sobrevivem**; só o código é reescrito.
2. **Simulação desacoplada:** o core não depende de DOM nem de Pixi.
   Roda em Node (testes), num Web Worker (browser) ou num shell desktop.
   Renderer é só um consumidor do estado.
3. **Tempo em ticks fixos** (ordem de 10 ticks/s) sobre **grade de tiles**;
   movimento interpolado apenas na renderização. Estado mutável na
   simulação (sem cópia imutável por tick).
4. **IDs com namespace desde o primeiro dia** (`base:hunger`,
   `vamp:blood`), mesmo antes de existir sistema de mods.
5. **Regra dos dois gêneros:** todo marco é validado com **dois mini-jogos
   de gêneros diferentes** (ex.: zumbi + vampiro), para impedir que
   suposições de gênero vazem para o engine.
6. **Mapas do mundo editados no Tiled** (JSON) quando o mundo crescer;
   ASCII continua válido para fixtures.
7. **Dependências mínimas**, no espírito do rogue-engine (parser YAML,
   PixiJS; o resto justificado caso a caso).

## 4. Primitivos-alvo do schema (esboço, não final)

- **measurements** — valores numéricos com min/max/initial (herdado).
- **statuses** — estados derivados de limites (`hunger > 70 → Hungry`),
  com efeitos contínuos (equivalente aos *moodles*).
- **systems** — regras que rodam sozinhas no tempo:
  ```yaml
  systems:
    - id: vamp:sunburn
      every: 10s
      for: "has_tag(self, 'vampire')"
      when: "world.is_day and tile.exposed_to_sky"
      effects:
        - { type: apply, measurement: hp, delta: -2 }
  ```
- **actions** — com `requires`, `flow`, **`duration`** e interrupção
  (quase tudo no Zomboid leva tempo e tem barra de progresso).
- **behaviors** — IA declarativa: sentidos (visão, audição) + máquina de
  estados ou utility AI:
  ```yaml
  behaviors:
    base:shambler:
      senses: { sight: 8, hearing: 15 }
      states:
        wander:      { do: random_walk, on: { sees: player -> chase, hears: noise -> investigate } }
        investigate: { do: goto_last_noise, timeout: 30s -> wander }
        chase:       { do: pursue, on: { adjacent: target -> attack, lost: target -> investigate } }
  ```
- **items / containers** — peso, capacidade, categorias.
- **loot tables** — distribuição por **tag de sala** (`kitchen`, `saloon`…).
- **recipes** — crafting declarativo.
- **factions, dialogues, quest flags, journal** — camada social (noir,
  velho oeste).
- **assets manifest** — sprites/spritesheets referenciados por ID.
- **packs** — base + packs que sobrescrevem/estendem, validados em conjunto.

## 5. Roteiro incremental

Cada marco termina **jogável** e passa pela regra dos dois gêneros.

| # | Marco | Resultado jogável | Status |
|---|---|---|---|
| S0 | **Spike de viabilidade** (antes de tudo): 4×4 chunks de 32×32 tiles isométricos, ~500 entidades vagando com A*, player move por clique; medir fps em notebook médio e celular | Confirma (ou não) TS + Pixi | ✅ feito¹ |
| M0 | Núcleo da simulação: grade, entidades, loop de ticks, measurements, expressões compiladas, loader YAML com namespaces; render **ASCII top-down** | Andar e ver measurements mudando com o tempo | ✅ feito |
| M1 | Renderer isométrico: tiles, depth sort, câmera, click-to-move (A*), manifesto de assets | O mesmo jogo, em iso | ✅ feito |
| M2 | Relógio, dia/noite, `systems`, `statuses` | Sobreviver um dia com fome/sede/sono | ✅ feito |
| M3 | Itens, peso, containers, loot tables por tag de sala | Saquear uma casa | ✅ feito |
| M4 | Percepção (visão/ruído) + `behaviors` | Horda que ouve a janela quebrando |  |
| M5 | Ações com duração, menu de contexto, receitas | Curativo, cozinhar, barricar |  |
| M6 | Mundo em chunks, múltiplos andares, mapas Tiled, save/load | Uma cidadezinha explorável |  |
| M7 | Packs/mods: empilhamento, overrides, validação conjunta | Zumbi e vampiro como mods da mesma base |  |
| M8 | Camada social: facções, diálogos, quests, journal | Mistério noir curto / duelo no velho oeste |  |
| M9 | Hooks de script sandboxed | Um mod "impossível" em YAML puro |  |

¹ S0: benchmark headless da simulação medido; os números de **fps no
browser** (notebook médio e celular) seguem **pendentes** — a tabela manual
e o `s0-bench.json` ainda precisam ser preenchidos (ver
`docs/spikes/s0-results.md`, "Browser benchmark"). O veredito do spike só
fica confirmado depois disso.

## 6. Riscos

- **Arte isométrica é cara** e é o que faz um gênero *parecer* outro.
  Começar com placeholders (blocos coloridos, packs Kenney) até ~M4.
- **Desempenho:** compilar expressões para closures no load; simulação em
  LOD para chunks distantes; ordenação de profundidade por chunk.
- **Escopo:** o Zomboid tem mais de uma década de desenvolvimento. O alvo é
  um núcleo pequeno em que trocar de gênero = trocar de pack.
- **Creep do YAML** (ver §2): preferir novos primitivos ou hooks de script
  a condicionais genéricas cada vez mais complexas.
- **Mods no browser:** instalar mods de terceiros exige upload de zip ou
  File System Access API; com Tauri vira pasta normal.

## 7. Perguntas em aberto

- ~~Formato dos packs: YAML puro, ou YAML + JSON gerado? Um arquivo por
  domínio (`items.yaml`, `systems.yaml`…) ou livre?~~ **Decidido no M0:**
  **YAML puro** (sem JSON gerado). Um pack é um diretório com `pack.yaml`
  (`namespace`, `name`, `version`, `depends`) e **layout livre** de
  arquivos `*.yaml` em qualquer profundidade; cada arquivo traz uma ou
  mais **chaves de domínio** (`measurements`, `tiles`, `archetypes`,
  `maps`, `start`…) e o conteúdo é **mesclado por domínio** dentro do
  pack. Chaves desconhecidas são erro de load. Ver `docs/packs.md`.
- Máquina de estados vs utility AI para `behaviors` — ou ambos?
- Semântica de override entre packs: substituição total por ID, merge
  profundo, ou operações de patch explícitas?
- Linguagem dos hooks de script: JS sandboxed (Worker/`ShadowRealm`) ou
  Lua (wasmoon/fengari)?
- Combate: tempo real sobre ticks, ou algo mais tático?
- ~~Projeção: 2:1 dimétrica clássica? Tamanho de tile?~~ **Decidido no
  M1:** **2:1 dimétrica clássica** com losango de tile de **64×32 px**
  (`iso.x = (x − y)·32`, `iso.y = (x + y)·16`); blocos elevados de 32 px;
  sprites de tile ancorados no vértice inferior do losango, de arquétipo no
  centro do chão do tile. Ver `docs/iso.md`. Paredes com cutaway continuam
  em aberto (M6).
- Quanto do renderer ASCII sobrevive como ferramenta de debug permanente?
- ~~Escala de tempo / calendário do jogo?~~ **Decidido (task
  `world-clock`, base do M2):** a escala vem de um domínio **`clock`**
  definido pelo pack (`day_length`, `start`, `dawn`, `dusk`); o padrão é
  **1 dia de jogo = 24 minutos reais** (1 s de simulação = 1 minuto de
  jogo). O tempo de jogo é **derivado do tick** — não acrescenta estado,
  então determinismo, snapshots e hashes não mudam. Expressões leem
  `world.day`, `world.hour`, `world.minute`, `world.time_of_day` e
  `world.is_day`; `rate` continua por segundo de simulação. **No máximo um
  pack** define `clock` até existir semântica de override (M7). Ver
  `docs/packs.md`.
- ~~Como `systems` agendam trabalho, como `statuses` entram e saem, como o
  dia/noite é configurado, e como o jogo termina?~~ **Decidido no M2:**
  - **`systems`** usam **segundos de simulação** (`every: 1`, padrão um
    tick); `every` precisa ser um número inteiro de ticks e vira período em
    ticks no load. Rodam uma vez por entidade (`for` filtra, depois `when`),
    com efeitos `apply`/`set` em `self`. Unidades de tempo de jogo
    (`every: 30m`) ficam para depois.
  - **`statuses`** entram com `when` e saem com `until` (padrão
    `not when`), o que dá **histerese**; enquanto ativos somam `rates` ao
    drift. São estado da simulação (snapshot/hash) e as expressões os
    testam com `has_status(entity, "id")`, resolvido no load para um índice.
  - A ordem do tick é fixa: intent → drift (com `rates` dos statuses do
    início do tick) → systems → clamp → statuses → derrota → `tick++`.
  - O tint de dia/noite é um **domínio próprio, `lighting`** (keyframes
    `at`/`color` interpolados em RGB), puramente visual; no máximo um pack
    o define, como `clock`.
  - A derrota é **`start.defeat`** (`when` avaliado com `self` = player,
    `message` opcional); ao disparar, o mundo congela e ignora input.
  - Tiles ganham **`tags`** próprias (`tile.has_tag("x")`), separadas das
    tags de arquétipo.
- ~~Itens como entidades ou como dados em containers? Como tags de
  tile/sala alimentam as loot tables?~~ **Decidido no M3:**
  - **Itens são dados dentro de containers**, não entidades: uma pilha é
    `{ item, count }` (no máximo uma por item). Há três tipos de
    container: embutido no tile (`tiles[].container`), **inventário** de
    entidade (`archetypes[].inventory`) e **pilha no chão** (criada ao
    largar itens, removida quando esvazia). Ids de container são
    sequenciais e nunca reusados.
  - **Pesos em centésimos inteiros**: pesos e capacidades são arredondados
    a 0,01 no load e somados/comparados como inteiros, sem drift de float
    (`0.1 × 3` cabe em `0.3`). Expressões e UI mostram unidades normais.
  - **Salas são retângulos** (`maps[].rooms: [{ rect, tags }]`); as tags de
    uma célula são a união dos retângulos que a contêm. Tags de sala, de
    tile e de entidade são três conjuntos separados (`tile.in_room("x")`).
  - **A distribuição mais específica vence**: cada container de tile usa a
    primeira entrada de `distributions` cuja `room` está nas tags da
    célula; senão a primeira sem `room`; empate → ordem de definição.
  - **Loot tem RNG próprio**, derivado da seed do mundo, rolado uma vez no
    construtor do `World`; o RNG do mundo não é tocado, então movimento e
    `random()` não mudam. Tabelas aninhadas, `nothing` e ciclos (erro de
    load) são suportados.
  - **Ações são instantâneas até o M5**: `take`/`put`/`drop`/`use` entram
    numa fila própria (`queueAction`, separada dos intents de movimento),
    aplicada na fase de intent logo após o movimento, com alcance de 1
    tile (Chebyshev) e resultado em `world.lastAction`. Duração, barra de
    progresso e interrupção ficam para o M5.

## 8. Próximo passo

S0, M0, M1, M2 e M3 estão entregues: zumbi e vampiro têm um loop de
sobrevivência e de saque (casas e mansão com salas, containers com loot
por sala, inventário com peso, comer/beber/curar usando itens), tudo em
YAML, jogável no terminal e no iso. O próximo passo é autorar via
`spec-orchestrator` a **spec do M4**: percepção (visão/ruído) e
`behaviors` declarativos — a horda que ouve a janela quebrando.

Perguntas de design do M4 ainda em aberto (a decidir na spec, não aqui):
máquina de estados vs utility AI (ou ambos), como sentidos e ruído são
representados sem custo por tick proporcional ao mapa, como NPCs usam
containers e itens (hoje só o player age), e se efeitos de `systems`
passam a criar ou consumir itens.
