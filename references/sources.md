# piki 数据源索引 (Data Sources / データソース一覧)

> **如何扩展**：在本文件末尾按相同格式添加新的「## 来源」节即可，无需修改 SKILL.md。

---

## 优先级与分工

| 需求场景 | 首选来源 |
|---|---|
| 中文名/属性/基础数据 | 52poke |
| 详尽机制、招式效果、遗传链 | Bulbapedia |
| 各世代招式/特性数据表 | Serebii |
| Champions 排位使用率数据 | pokechamdb |
| VGC 竞技攻略/阵容思路 | vgcguide |
| 赛事对战数据/队伍分析 | limitlessvgc / pokedb.tokyo |

---

## 来源 1：52poke（神奇宝贝百科 / ポケモン百科）

- **地址**：`https://wiki.52poke.com/`
- **语言**：中文
- **用途**：宝可梦中文名称、属性（Type/タイプ）、种族值（Base Stats/種族値）、招式列表、特性中文说明
- **URL 模式**：
  ```
  宝可梦：https://wiki.52poke.com/wiki/<中文名>
  招式：  https://wiki.52poke.com/wiki/<招式中文名>
  特性：  https://wiki.52poke.com/wiki/<特性中文名>
  ```
  示例：`https://wiki.52poke.com/wiki/喷火龙`、`https://wiki.52poke.com/wiki/拍落`
- **⚠️ 注意**：直接 WebFetch 可能返回 403，改用 WebSearch：
  ```
  WebSearch: site:wiki.52poke.com <中文名>
  ```
  取得搜索结果后再 WebFetch 具体页面 URL。

---

## 来源 2：Bulbapedia（神奇宝贝百科 / ポケモン百科）

- **地址**：`https://bulbapedia.bulbagarden.net/`
- **语言**：英文
- **用途**：详尽机制说明、招式效果细节、遗传链、历代差异、进化条件
- **URL 模式**：
  ```
  宝可梦：https://bulbapedia.bulbagarden.net/wiki/<EnglishName>_(Pokémon)
  招式：  https://bulbapedia.bulbagarden.net/wiki/<MoveName>_(move)
  特性：  https://bulbapedia.bulbagarden.net/wiki/<AbilityName>_(Ability)
  道具：  https://bulbapedia.bulbagarden.net/wiki/<ItemName>
  搜索：  https://bulbapedia.bulbagarden.net/wiki/Special:Search?search=<query>
  ```
  示例：`/wiki/Charizard_(Pokémon)`、`/wiki/Knock_Off_(move)`、`/wiki/Blaze_(Ability)`
- **竞技内容**：页面本身无竞技分析，但招式效果/遗传表/种族值完整，适合查机制。

---

## 来源 3：Serebii（塞雷比 / セレビィ）

- **地址**：`https://www.serebii.net/`
- **语言**：英文
- **用途**：各世代招式/特性数据表、各版本差异速查
- **URL 模式**（以 SV 朱紫为例，其他世代替换 `sv`）：
  ```
  宝可梦：https://www.serebii.net/pokedex-sv/<englishname>/
          或按编号：https://www.serebii.net/pokedex-sv/006.shtml
  招式：  https://www.serebii.net/attackdex-sv/<movename>.shtml
  特性：  https://www.serebii.net/abilitydex/<abilityname>.shtml
  ```
  世代关键词：`swsh`（剑盾）、`sm`（日月）、`sv`（朱紫）、`bdsp`（晶钻）
  示例：`/pokedex-sv/charizard/`、`/attackdex-sv/knockoff.shtml`、`/abilitydex/blaze.shtml`

---

## 来源 4：pokechamdb（宝可梦冠军排位数据库）

- **地址**：`https://pokechamdb.com/zh-Hans`
- **语言**：中文
- **用途**：Pokémon Champions 排位赛（单打/双打）宝可梦使用率、常用招式、道具、拍档数据
- **URL 模式**：
  ```
  宝可梦使用率：https://pokechamdb.com/zh-Hans/pokemon/<englishname>?season=<赛季>&format=<single|double>
  首页排行：    https://pokechamdb.com/zh-Hans?season=<赛季>&format=<single|double>
  ```
  - `season` 当前：`M-3`（随赛季更新，首页显示最新值）
  - `format`：`single`（单打）或 `double`（双打）
  示例：`/zh-Hans/pokemon/charizard?season=M-3&format=single`
- **数据字段**：招式使用率%、道具使用率%、特性使用率%、拍档宝可梦 Top10

---

## 来源 5：VGC Guide（VGC 竞技指南）

- **地址**：`https://www.vgcguide.com/`
- **语言**：英文
- **用途**：VGC 双打竞技思路、阵容构建方法论、入门/进阶攻略
- **URL 模式**：
  ```
  入门：         /intro
  阵容构建：     /teambuilding
  对战技巧：     /battling
  赛事信息：     /circuit
  ```
  内容为专题长文，无单独宝可梦查询页，适合查战术思路和通用竞技理念。

---

## 附加来源（可选，按需 WebFetch）

### pokedb.tokyo（日文排位数据，含 Champions）
- Champions 单打：`https://champs.pokedb.tokyo/pokemon/show/<国际编号>?season=<N>&rule=1`
- 朱紫排位双打：`https://sv.pokedb.tokyo/pokemon/show/<编号>?season=<N>&rule=1`
- 语言：日文，数据极为详尽

### limitlessvgc.com（英文赛事/队伍数据库）
- 宝可梦数据：`https://limitlessvgc.com/pokemon/<englishname>?format=<format>`
- 赛事结果：`https://limitlessvgc.com/events/`

### vgcpedia.com（选手/赛事数据库）
- 选手页：`https://www.vgcpedia.com/player/<player-name>/`

---

*如需新增来源，在本文件末尾添加「### 来源名」节，描述语言、用途和 URL 模式即可。*
