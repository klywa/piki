# 本地数据与计算工具 (Data Tools)

**何时读**：本会话首次要调用 `pokedb.mjs` 或 `calc.mjs` 之前，读一次即可。

两个脚本，职责不重叠：

| 脚本 | 负责 | 不负责 |
|---|---|---|
| `scripts/pokedb.mjs` | 属性、种族值、特性、招式参数、相性、速度线、学习合法性 | 伤害数字 |
| `scripts/calc.mjs` | 伤害区间、确定数、耐久线反推 | 别的都不管 |

**都不负责「时变数据」**——使用率、当前环境的常用配招/道具分布/性格分布，
这些必须走 web（`references/sources.md` → pokechamdb）。本地库是主系列 Showdown 数据的快照，
它知道「拍落威力 65」，不知道「这赛季谁在用拍落」。

工作目录：`cd` 到 `scripts/` 下运行，或用绝对路径。首次调用 `calc.mjs` 会自动
`npm install @smogon/calc`（约 3 MB，几秒），之后完全离线。

---

## pokedb.mjs

名称支持**中文 / 日文 / 英文 / 俗称混用**，一次可查多个。

```bash
node pokedb.mjs mon     <名...>  [--matchup] [--moves] [--ability <特性>]
node pokedb.mjs move    <名...>
node pokedb.mjs ability <名...>
node pokedb.mjs item    <名...>
node pokedb.mjs type    <属性|属性1/属性2> [--atk] [--def] [--ability <特性>]
node pokedb.mjs speed   <名...>  [--format champs|sv] [--level 50] [--mods 围巾,顺风,+1,麻痹]
node pokedb.mjs can     <宝可梦> <招式...>
node pokedb.mjs search  <关键词> [--kind mon|move|ability|item] [--n 10]
node pokedb.mjs --version
```

### 输出格式

每条记录一行，管道分隔，字段顺序固定：

```
MON 喷火龙|Charizard|リザードン|火/飞行|78.84.78.109.85.100|种族和534|猛火,太阳之力(隐藏)|90.5kg
    HP78 攻84 防78 特攻109 特防85 速100
    其他形态：Charizard-Mega-X, Charizard-Mega-Y

DEF 喷火龙 x4 岩石 | x2 水,电 | x0.5 格斗,钢,火,妖精 | x0.25 虫,草 | x0 地面
ATK 喷火龙 本系克 火打 虫,钢,草,冰 ｜ 飞行打 格斗,虫,草

MOVE 拍落|Knock Off|はたきおとす|恶|物理|威力65|命中100|PP20|优先+0|单体|接触,可被守住
ABI  威吓|Intimidate|いかく|竞技评分3.5
ITEM 讲究围巾|Choice Scarf|こだわりスカーフ

SPEED lv50 Pokémon Champions 单打｜裸速=0投入中性性格　max=32能力点投入+加速性格
SPD 振翼发|种族135|裸速 155|max 172|围巾 258|顺风 344
ORDER(满速) 振翼发 172 > 喷火龙 167 > 铁臂膀 92
TIE 甲贺忍蛙=火焰鸟 167（同速，先手是 50/50 猜拳）

CAN 喷火龙 地震:YES 喷射火焰:YES 龙之舞:YES 冲浪:NO
```

### 三个必须理解的返回

| 返回 | 含义 | 你该做什么 |
|---|---|---|
| `AMBIGUOUS <词> → a(甲) \| b(乙)` | 有多个势均力敌的候选 | **向用户确认是哪一个**。脚本刻意不替你选——「阿罗拉九尾被当成九尾」这类错误就是这么来的 |
| `NOTFOUND <词> — 是否指：…` | 没命中，但有相近项 | 用建议项重查；若都不像，问用户 |
| `NOTFOUND <词> — 本地库为主系列数据…` | 完全没有 | 可能是 Champions 新增/改名。**走 web 源，不要用近似的宝可梦顶替** |

### 用得最多的两个开关

- **`--matchup`**：把**特性并入防御相性**（悬浮免地面、厚脂肪半伤火冰、引火/储水/避雷针免疫、
  硬石头/坚硬头骨减伤超效技）。这是对战里最常问、也最容易记错的一块，别自己心算。
  默认取该宝可梦的第一特性；对手特性已知时用 `--ability` 指定。
- **`--mods`**：速度修正一次算完，支持 `围巾/顺风/+1/+2/麻痹/晴天加速/雨天加速/古代活性/夸克充能`。
  `TIE` 行会显式点出同速——**同速本身就是一个猜拳点**，别漏掉。

---

## calc.mjs

**铁律：任何伤害百分比、任何确定数，只能来自这里。** 不允许口算，不允许凭记忆给「大概 X%」。

```bash
node calc.mjs --in <scratchpad>/calc_01.json [--desc] [--stats]
node calc.mjs --json '{...}'      # ≤3 条时内联更省事
```

一次对局分析通常要 10~30 个计算。**写成一个 JSON 文件一次跑完**，不要循环调用 shell。

### 输入格式

核心设计：**`sets` 定义一次，`calcs` 按 key 引用**。30 条计算就是 30 行短文本。

```json
{
  "format": "champs-double",
  "field": {
    "weather": "晴",
    "terrain": null,
    "atk": {"tailwind": true},
    "def": {"reflect": true, "friendguard": true}
  },
  "sets": {
    "A1": {"species": "喷火龙", "mega": "Y", "item": "生命宝珠", "spread": "特攻速攻"},
    "A2": {"species": "铁臂膀", "spread": "物攻满", "boosts": {"atk": 1}},
    "B1": {"species": "振翼发", "spread": "unknown", "hpPercent": 60},
    "B2": {"species": "结草贵妇", "spread": "unknown", "item": "?"}
  },
  "calcs": [
    {"id": "1", "atk": "A1", "def": "B1", "move": "热风"},
    {"id": "2", "atk": "A2", "def": "B1", "move": "雷电拳", "note": "能不能收残血"},
    {"id": "3", "atk": "B2", "def": "A1", "move": "十字剪", "crit": true},
    {"id": "4", "mode": "survive", "atk": "A2", "def": "B1", "move": "雷电拳"}
  ]
}
```

**set 字段**

| 字段 | 说明 |
|---|---|
| `species` | 中/日/英/俗称皆可 |
| `mega` | `"X"` / `"Y"` / `true`。Champions 有 Mega；不支持的格式会直接报错 |
| `item` | 名称；`"?"` 或 `"unknown"` = 按无道具算并打标记 |
| `ability` | 省略则取第一特性 |
| `spread` | 见下方预设；`"unknown"` 触发双基准 |
| `evs` | 显式投入，如 `{"hp":32,"def":20}`。超总量/超单项上限会打警告，不静默截断 |
| `nature` | 英文性格名（与 `evs` 搭配用） |
| `boosts` | `{"atk":1,"spe":-1}` 能力升降段 |
| `status` | `烧伤/麻痹/中毒/剧毒/睡眠/冰冻` |
| `hpPercent` | 当前血量百分比（局面分析几乎总要用） |

**spread 预设**：`物攻满` `物攻速攻` `特攻满` `特攻速攻` `物耐满` `特耐满` `满速` `无投入`
（也接受 `offense-phys` / `bulky-spec` 等英文写法）。
`max` 按格式展开——主系列 252 努力值，Champions 32 能力点。

**field 字段**：`weather`（晴/雨/沙/雪）、`terrain`（电气/青草/精神/薄雾）、
`atk`/`def` 各自的 `tailwind` `reflect` `lightscreen` `auroraveil` `helpinghand` `friendguard` `protect` `stealthrock` `spikes`。

### 「对手配置未知」——这是常态，不是例外

写 `"spread": "unknown"` 的**防守方**，脚本会对同一条计算输出**两行**：
一行对「无投入」，一行对「满耐久」。

```
2 铁臂膀[物攻满] 雷电拳 -> 振翼发[无投入,HP60%]   90.8-108.5%  1发确定击倒
2 铁臂膀[物攻满] 雷电拳 -> 振翼发[物耐满,HP60%]   46.9-56.2%   2发确定击倒
```

真相一定落在这个区间里。**不要挑一行当结论**——这个区间本身就是猜拳分析的输入：
「他要是裸的我这发就收掉，堆了耐久就收不掉」正是一个需要读心的分歧点。

### 输出格式

```
CALC v1 fmt=champs-double lv=50 ev=66能力点/单项上限32(1点=+1面板) iv=固定31 性格=有 太晶=DISABLED mega=ON rolls=16 weather=晴
<id> <攻方>[道具,预设,标记] <招式>(修正) -> <守方>[预设,标记]  <低>-<高>%  <确定数>  ※<备注>
<id> SURVIVE <守方> 需 HP12能力点 + 特防20能力点，才能吃住 <攻方> 的<招式>（最高伤害 98.7%）
<id> ERROR unknown-move "喷射火尤" — 是否指：flamethrower(喷射火焰) | eruption(喷火)
ok: 7  err: 1  backend: @smogon/calc gen9
假设: 对手耐久未知→给无投入/满耐久双基准
⚠ 道具「讲究眼镜」在 Pokémon Champions（赛季 M-5）尚未实装——含它的配招是无效建议
```

- **头部永远打印采用的规则**（等级、能力点制、个体值、性格、太晶开关），结论因此可审计。
- **脚本做的每个假设都以 `~标记` 出现在行内**并汇总到 `假设:` 行，不会在分析中途丢失。
- **一条报错不影响其余**，且错误按原顺序内联，不打乱编号。
- `--stats` 打印每个 set 的最终面板，供人工核对；`--desc` 附 Smogon 英文描述（较费 token，默认关）。

### 硬性行为

| 情况 | 脚本行为 | 你该做什么 |
|---|---|---|
| Champions 里传 `teraType` | `ERROR tera-not-allowed-in-champs-*` | 去掉——当前规则未解禁太晶 |
| 用了未实装的道具 | 输出 `⚠` 警告 | 换道具，或明确告诉用户这个配招目前用不了 |
| 招式名拼错 | 该条 `ERROR` + 候选建议 | 用建议重提交这一条 |
| `npm install` 失败 | 打印 `calc_unavailable` 并 exit 3 | **只做定性分析，并明确告诉用户「本次未做精算」。绝不用心算顶替。** |

### 剪枝：别把 36 格全算一遍

阵容对局有 6×6 = 36 个对位，全精算是 token 和时间的黑洞。
正确做法是**两遍法**：先用 `pokedb.mjs` 的相性/速度/种族做粗筛，
只对「胜负待定」的格子跑 `calc.mjs`，一次批量提交，典型 8~20 条。
详见 `matchup-analysis.md`。

---

## 本地库的维护

数据来自 Pokémon Showdown（竞技数据）+ PokeAPI（中日文名），已提交在 `data/`，无需联网。

- `node pokedb.mjs --version` 查看生成日期、条目数、中文名覆盖率、Champions 规则是否已核实。
- 中文名覆盖率不是 100%（PokeAPI 的中文名滞后于最新世代），缺失项显示为
  `英文名(无中文名)` 并照常可查，**不会编造中文名**。
- `data/aliases.zh.json` 有两个可手工扩展的区块，改完立即生效、不用重建数据库：
  - 顶层的 `species/moves/abilities/items` —— **俗称/缩写**（`"洗衣机": "rotomwash"`）。
    piki 认不出某个常用叫法时加一行。
  - `zh_names` —— **显示名覆盖**（`"moves": {"bloodmoon": "血月"}`）。
    某个中文名缺失或你觉得译得不对时，在这里按 id 指定。
- 数据过时或出现 `NOTFOUND` 时，重新生成：`node tools/build_data.mjs`（需联网，维护动作）。
- Champions 的数值规则在 `data/champions-rules.json`。**发现算得和游戏内对不上，改这个文件，不用改代码。**
